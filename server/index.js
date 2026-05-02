import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import axios from 'axios';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const PORT = process.env.PORT || 3001;

/* ─── Validate env vars ─── */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const OVERLEAF_SESSION_COOKIE_RAW = process.env.OVERLEAF_SESSION_COOKIE;
const OVERLEAF_GCLB_TOKEN_RAW = process.env.OVERLEAF_GCLB_TOKEN;

if (!GROQ_API_KEY) {
  console.error('❌ GROQ_API_KEY is not set.');
  process.exit(1);
}
if (!OVERLEAF_SESSION_COOKIE_RAW) {
  console.error('❌ OVERLEAF_SESSION_COOKIE is not set.');
  process.exit(1);
}
if (!OVERLEAF_GCLB_TOKEN_RAW) {
  console.error('❌ OVERLEAF_GCLB_TOKEN is not set.');
  process.exit(1);
}

/* ─── Groq client ─── */
const groq = new Groq({ apiKey: GROQ_API_KEY });

/* ─── Shared user-agent ─── */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const normalizeGeneratedLatex = (latex) => {
  return latex
    .replace(/```[\w]*\n?/g, '')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '--')
    .replace(/\u00a0/g, ' ')
    .replace(/\\faPhone\*/g, '\\faPhone')
    .replace(/\\faEnvelope\*/g, '\\faEnvelope')
    .replace(/\\faLinkedin\*/g, '\\faLinkedin')
    .replace(/\\faGithub\*/g, '\\faGithub')
    .trim();
};

const extractCompileDiagnostics = (compileData) => {
  const outputFiles = compileData?.outputFiles || [];
  const logFile = outputFiles.find((file) => file.path === 'output.log');
  const rawLog =
    compileData?.compile?.log ||
    compileData?.compile?.error ||
    compileData?.error ||
    compileData?.message ||
    logFile?.content ||
    '';

  if (typeof rawLog === 'string' && rawLog.trim()) {
    const errorLines = rawLog
      .split('\n')
      .filter((line) => /^!|^l\.\d+|error|fatal/i.test(line.trim()))
      .slice(0, 12)
      .join('\n')
      .trim();

    return errorLines || rawLog.slice(0, 1200).trim();
  }

  return 'Overleaf did not return a readable compile log for this request.';
};

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   POST /api/generate
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
app.post('/api/generate', async (req, res) => {
  const { jobDescription, currentResume } = req.body;

  if (!jobDescription || !currentResume) {
    return res.status(400).json({
      status: 'error',
      message: 'Both jobDescription and currentResume are required.',
    });
  }

  try {
    /* ── Step 1: Groq call #1 — ATS Resume Rewriter ── */
    console.log('📝 Step 1: Calling Groq for ATS resume rewrite…');

    const step1Prompt = `## **Refined Prompt: ATS-Optimized Resume Rewriter**

You are an expert resume writer and ATS optimization specialist.

Your task is to generate a **completely new, ATS-optimized resume** using two inputs:

1. **Job Description**
2. **Current Resume**

---

## **Inputs**

**Job Description:**
${jobDescription}

**Current Resume:**
${currentResume}

---

## **Core Objective**

Transform the provided resume into a **highly targeted, keyword-optimized resume** that aligns strongly with the given job description and skills.

The output must:
* Maximize **ATS keyword matching**
* Improve **clarity, impact, and structure**
* Present **experience in a results-driven, achievement-oriented way**

---

## **Execution Guidelines**

### Step 1: Extract Structured Data
From the current resume, extract only factual information (do NOT reuse phrasing):
* Personal details: Name, Address, Phone, Email, LinkedIn, GitHub
* Education: Degree, Institution, Location, Dates
* Work Experience: Company names, job titles, dates
* Projects (if present)

### Step 2: Keyword & Skill Mapping
From the job description and skills:
* Identify **primary keywords** (core skills, tools, technologies)
* Identify **secondary keywords** (soft skills, domain knowledge, methodologies)
* Identify **action verbs and impact phrases**

### Step 3: Resume Reconstruction
Build a completely new resume with these rules:
1. **No Reuse of Original Language** — do NOT copy or paraphrase sentences; only reuse raw facts.
2. **Strong Keyword Integration** — weave JD keywords naturally into summary, skills, and bullets.
3. **Work Experience Enhancement** — each bullet: strong action verb + JD tools/tech + measurable impact.
4. **Professional Summary** — 3–5 lines, role-aligned, impact-focused.
5. **Skills Section** — grouped by category; JD-relevant skills first.
6. **Clarity & Readability** — clean, concise, consistent.

---

## **Output Format (Strictly Follow)**

---

**[Full Name]**

**Address:** [Full Address]

**Phone No:** [Phone Number] | **Email:** [Email Address] | **LinkedIn:** [LinkedIn URL] | **GitHub:** [GitHub URL]

---

### **Professional Summary**
[ATS-optimized, role-aligned summary]

---

### **Education**
**[Degree]**
[College Name] | [Location] | [Start Date] - [End Date]

---

### **Work Experience**
**[Company Name] | [Location] | [Job Title]** | [Start Date] - [End Date]
* [Achievement-driven bullet with keywords + impact]
* [Achievement-driven bullet with keywords + impact]
* [Achievement-driven bullet with keywords + impact]

---

### **Skills**
* **[Category]:** [Relevant skills]

---

### **Projects**
**[Project Title]**
* [Description with tools, keywords, and measurable impact]

---

## **Critical Constraints**
* Do NOT include explanations, notes, or commentary.
* Do NOT output anything outside the defined format.
* Do NOT miss important keywords from the job description.
* Do NOT keyword-stuff unnaturally — maintain readability.`;

    const step1Result = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: step1Prompt }],
      max_tokens: 4096,
      temperature: 0.7,
    });
    const markdownResume = step1Result.choices[0]?.message?.content;

    if (!markdownResume) {
      throw new Error('Groq returned an empty resume.');
    }

    console.log('✅ Step 1 complete — markdown resume generated.');

    /* ── Step 2: Groq call #2 — Markdown → LaTeX ── */
    console.log('📝 Step 2: Converting to LaTeX…');

    const latexTemplate = `\\documentclass[letterpaper,10pt]{article}

\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{marvosym}
\\usepackage[usenames,dvipsnames]{color}
\\usepackage{verbatim}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}
\\usepackage[english]{babel}
\\usepackage{tabularx}
\\usepackage{fontawesome5}
\\usepackage{fontspec}

\\definecolor{light-grey}{gray}{0.83}
\\definecolor{dark-grey}{gray}{0.3}
\\definecolor{text-grey}{gray}{.08}
\\definecolor{accent-blue}{HTML}{1F3A5F}

\\pagestyle{fancy}
\\fancyhf{}
\\fancyfoot{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\addtolength{\\oddsidemargin}{-0.35in}
\\addtolength{\\evensidemargin}{-0.35in}
\\addtolength{\\textwidth}{0.7in}
\\addtolength{\\topmargin}{-0.45in}
\\addtolength{\\textheight}{0.9in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}
\\setlist[itemize]{leftmargin=0.2in, topsep=2pt, itemsep=1.5pt, parsep=0pt, partopsep=0pt}
\\IfFontExistsTF{Times New Roman}{
  \\setmainfont{Times New Roman}
}{
  \\setmainfont{TeX Gyre Termes}
}

\\titleformat{\\section}{
  \\bfseries \\raggedright \\normalsize\\color{accent-blue}
}{}{0em}{\\MakeUppercase}[\\color{light-grey} {\\titlerule[0.8pt]} \\vspace{-2pt}]
\\titlespacing{\\section}{0pt}{9pt}{3pt}

\\newcommand{\\resumeSection}[2]{\\section{\\faIcon{#1}\\hspace{6pt}#2}}

\\newcommand{\\resumeItem}[1]{\\item\\small{#1}}

\\newcommand{\\resumeSubheading}[4]{
  \\item\\vspace{1pt}
    \\begin{tabular*}{\\textwidth}[t]{l@{\\extracolsep{\\fill}}r}
      \\textbf{\\normalsize #1} & {\\color{dark-grey}\\footnotesize \\faCalendarAlt\\ #2}\\\\
      {\\textit{\\small #3}} & {\\color{dark-grey} \\footnotesize \\faMapMarkerAlt\\ #4}\\\\
    \\end{tabular*}\\vspace{-2pt}
}

\\newcommand{\\resumeProjectHeading}[2]{
    \\item\\vspace{1pt}
    \\begin{tabular*}{\\textwidth}{l@{\\extracolsep{\\fill}}r}
      \\textbf{\\small #1} & {\\color{dark-grey}\\footnotesize #2} \\\\
    \\end{tabular*}\\vspace{-2pt}
}

\\newcommand{\\resumeSubItem}[1]{\\resumeItem{#1}}
\\renewcommand\\labelitemii{$\\vcenter{\\hbox{\\tiny$\\bullet$}}$}

\\newcommand{\\resumeSubHeadingListStart}{\\begin{itemize}[leftmargin=0in, label={}, itemsep=2pt]}
\\newcommand{\\resumeSubHeadingListEnd}{\\end{itemize}\\vspace{-1pt}}
\\newcommand{\\resumeItemListStart}{\\begin{itemize}[leftmargin=0.2in, itemsep=2pt]}
\\newcommand{\\resumeItemListEnd}{\\end{itemize}\\vspace{-1pt}}

\\color{text-grey}

\\begin{document}
\\begin{center}
  {\\fontsize{19}{22}\\selectfont\\textbf{FULL NAME}} \\\\ \\vspace{3pt}
  \\small \\faPhone\\ PHONE \\hspace{4pt} $|$ \\hspace{4pt} \\faEnvelope\\ EMAIL \\hspace{4pt} $|$ \\hspace{4pt} \\faLinkedin\\ LINKEDIN \\hspace{4pt} $|$ \\hspace{4pt} \\faGithub\\ GITHUB
  \\\\ \\vspace{2pt}
\\end{center}

\\resumeSection{file-alt}{SUMMARY}
\\small One-line summary here.

\\resumeSection{graduation-cap}{EDUCATION}
  \\resumeSubHeadingListStart
    \\resumeSubheading{University}{Dates}{Degree}{Location}
  \\resumeSubHeadingListEnd

\\resumeSection{briefcase}{EXPERIENCE}
  \\resumeSubHeadingListStart
    \\resumeSubheading{Company}{Dates}{Title}{Location}
      \\resumeItemListStart
        \\resumeItem{Bullet 1}
        \\resumeItem{Bullet 2}
        \\resumeItem{Bullet 3}
      \\resumeItemListEnd
  \\resumeSubHeadingListEnd

\\resumeSection{diagram-project}{PROJECTS}
    \\resumeSubHeadingListStart
      \\resumeProjectHeading{\\textbf{Project Title}}{}
          \\resumeItemListStart
            \\resumeItem{Description}
          \\resumeItemListEnd
    \\resumeSubHeadingListEnd

\\resumeSection{code}{SKILLS}
 \\begin{itemize}[leftmargin=0in, label={}]
   \\item{\\small
     \\textbf{Category}{: skills} \\\\
     \\textbf{Category}{: skills}
   }
 \\end{itemize}

\\resumeSection{award}{ACHIEVEMENTS}
 \\begin{itemize}[leftmargin=0in, label={}]
   \\item{\\small
     \\textbf{Achievement}{: detail}
   }
 \\end{itemize}

\\end{document}`;

    const step2Prompt = `You are an expert LaTeX developer. Convert this resume into COMPILABLE LaTeX code using the EXACT template below.

Resume text:
${markdownResume}

RULES:
1. Use ONLY the template structure below — do not add any packages or commands.
2. Fill in the content from the resume. Escape all LaTeX special characters in resume text: & % $ # _ { } ~ ^ \\.
3. Keep template icons as-is. Do NOT add extra icon commands beyond those already in the template.
4. Do NOT use raw markdown markers such as **, ###, backticks, or bullet characters outside itemize.
5. Use plain ASCII punctuation only. Convert smart quotes to straight quotes and en/em dashes to --.
6. Summary must be 1 line. Each job: max 3 bullets. Keep only 1 project.
7. Output ONLY raw LaTeX code. No markdown fences, no explanations, no text before \\documentclass or after \\end{document}.
8. If LinkedIn or GitHub URLs are unavailable, remove those fields from the header entirely.

TEMPLATE:
${latexTemplate}`;

    const step2Result = await groq.chat.completions.create({
      model: 'llama-3.3-70b-versatile',
      messages: [{ role: 'user', content: step2Prompt }],
      max_tokens: 8192,
      temperature: 0.2,
    });
    let latexCode = step2Result.choices[0]?.message?.content;

    if (!latexCode) {
      throw new Error('Groq returned empty LaTeX code.');
    }

    // Robust cleanup: strip fences and normalize punctuation that can break compilation.
    latexCode = normalizeGeneratedLatex(latexCode);

    // Extract only the LaTeX document (from \documentclass to \end{document})
    const docMatch = latexCode.match(/(\\documentclass[\s\S]*\\end\{document\})/);
    if (docMatch) {
      latexCode = docMatch[1].trim();
    }

    // Keep template icons for a polished, professional header and location line.

    // Safety: ensure it starts with \documentclass
    if (!latexCode.includes('\\documentclass')) {
      throw new Error('Generated LaTeX is missing \\documentclass. Please try again.');
    }

    console.log('✅ Step 2 complete — LaTeX generated.');
    console.log(`   LaTeX length: ${latexCode.length} chars`);

    /* ── Step 3: Decode Overleaf session cookie ── */
    console.log('🔑 Step 3: Decoding Overleaf credentials…');

    const SESSION_COOKIE = decodeURIComponent(OVERLEAF_SESSION_COOKIE_RAW);
    const GCLB_TOKEN = OVERLEAF_GCLB_TOKEN_RAW;

    const cookieStr = `overleaf_session2=${SESSION_COOKIE}; GCLB=${GCLB_TOKEN}`;

    console.log('✅ Step 3 complete.');

    /* ── Step 4: GET /project to fetch CSRF token ── */
    console.log('🔐 Step 4: Fetching Overleaf CSRF token…');

    const csrfResponse = await axios.get('https://www.overleaf.com/project', {
      headers: {
        'User-Agent': UA,
        Cookie: cookieStr,
      },
      maxRedirects: 5,
      validateStatus: (s) => s < 400,
    });

    const html = typeof csrfResponse.data === 'string' ? csrfResponse.data : '';

    const csrfMatch =
      html.match(/name="ol-csrfToken" content="([^"]+)"/) ||
      html.match(/content="([^"]+)" name="ol-csrfToken"/);

    if (!csrfMatch) {
      throw new Error(
        'Could not extract CSRF token from Overleaf. Your session cookie may have expired.'
      );
    }

    const csrfToken = csrfMatch[1];
    console.log('✅ Step 4 complete — CSRF token obtained.');

    /* ── Step 5: POST /docs to create project ── */
    console.log('📤 Step 5: Creating Overleaf project…');

    const createResponse = await axios.post(
      'https://www.overleaf.com/docs',
      new URLSearchParams({
        _csrf: csrfToken,
        snip: latexCode,
        engine: 'xelatex',
      }).toString(),
      {
        headers: {
          Accept:
            'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          Referer: 'https://www.overleaf.com/project',
          Origin: 'https://www.overleaf.com',
          'User-Agent': UA,
          Cookie: cookieStr,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        maxRedirects: 0,
        validateStatus: (s) => s >= 200 && s < 400,
      }
    );

    const locationHeader =
      createResponse.headers?.location || createResponse.headers?.['Location'] || '';
    const projectIdMatch = locationHeader.match(/\/project\/([a-f0-9]{24})/);

    if (!projectIdMatch) {
      throw new Error(
        'Could not extract project ID from Overleaf redirect. Location: ' +
          locationHeader
      );
    }

    const projectId = projectIdMatch[1];
    console.log(`✅ Step 5 complete — project created: ${projectId}`);

    /* ── Step 6: POST compile ── */
    console.log('🔨 Step 6: Compiling PDF on Overleaf…');

    const compileResponse = await axios.post(
      `https://www.overleaf.com/project/${projectId}/compile`,
      new URLSearchParams({
        check: 'silent',
        draft: 'true',
        stopOnFirstError: 'false',
      }).toString(),
      {
        headers: {
          Cookie: cookieStr,
          'X-Csrf-Token': csrfToken,
          Accept: 'application/json',
          'Content-Type': 'application/x-www-form-urlencoded',
          'User-Agent': UA,
        },
        validateStatus: (s) => s < 500,
      }
    );

    const compileData = compileResponse.data;
    const outputFiles = compileData?.outputFiles || [];
    const pdfFile = outputFiles.find((f) => f.path === 'output.pdf');
    const projectUrl = `https://www.overleaf.com/project/${projectId}`;

    if (!pdfFile) {
      const diagnostics = extractCompileDiagnostics(compileData);
      console.error('❌ Overleaf compile failed:', diagnostics);

      return res.status(200).json({
        status: 'error',
        message: `PDF compilation failed. ${diagnostics} Open the project in Overleaf to view the full logs: ${projectUrl}`,
        projectUrl,
        diagnostics,
      });
    }

    const pdfUrl = 'https://www.overleaf.com' + pdfFile.url;
    console.log('✅ Step 6 complete — PDF compiled.');

    /* ── Step 7: Download the PDF ── */
    console.log('📥 Step 7: Downloading compiled PDF…');

    const pdfResponse = await axios.get(pdfUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': UA,
      },
      responseType: 'arraybuffer',
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');
    console.log('✅ Step 7 complete — PDF downloaded and encoded.');

    /* ── Return success ── */
    return res.json({
      status: 'success',
      projectUrl,
      pdfUrl,
      pdfBase64,
    });
  } catch (err) {
    console.error('❌ Error:', err.message);
    return res.status(500).json({
      status: 'error',
      message: err.message || 'An unexpected error occurred.',
    });
  }
});

app.use('/api', (req, res) => {
  res.status(404).json({
    status: 'error',
    message: `API route not found: ${req.method} ${req.originalUrl}`,
  });
});

app.use((err, req, res, next) => {
  if (res.headersSent) {
    return next(err);
  }

  if (err instanceof SyntaxError && 'body' in err) {
    return res.status(400).json({
      status: 'error',
      message: 'Request body must be valid JSON.',
    });
  }

  return res.status(500).json({
    status: 'error',
    message: err.message || 'An unexpected server error occurred.',
  });
});

/* ─── Start ─── */
app.listen(PORT, () => {
  console.log(`🚀 ATS Resume Tailor backend running on http://localhost:${PORT}`);
});
