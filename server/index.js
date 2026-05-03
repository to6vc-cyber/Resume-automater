import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import axios from 'axios';
import fs from 'fs';
import path from 'path';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// Log file path
const LOG_FILE = path.join(process.cwd(), 'server.log');

// Enhanced logging that writes to both console and file
const log = (message) => {
  console.log(message);
  fs.appendFileSync(LOG_FILE, message + '\n');
};

const logError = (message) => {
  console.error(message);
  fs.appendFileSync(LOG_FILE, '[ERROR] ' + message + '\n');
};

// Clear log file on startup
fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] Server started\n`);

// Request logging middleware
app.use((req, res, next) => {
  log(`📨 ${req.method} ${req.path}`);
  next();
});

const PORT = process.env.PORT || 3001;

/* ─── Validate env vars ─── */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const OVERLEAF_SESSION_COOKIE_RAW = process.env.OVERLEAF_SESSION_COOKIE;
const OVERLEAF_GCLB_TOKEN_RAW = process.env.OVERLEAF_GCLB_TOKEN;

if (!GROQ_API_KEY) {
  log('⚠️ GROQ_API_KEY is not set. Gemini will be used as fallback.');
}
if (!GEMINI_API_KEY) {
  log('⚠️ GEMINI_API_KEY is not set. Groq will be primary.');
}
if (!GROQ_API_KEY && !GEMINI_API_KEY) {
  logError('❌ Neither GROQ_API_KEY nor GEMINI_API_KEY is set.');
  process.exit(1);
}
if (!OVERLEAF_SESSION_COOKIE_RAW) {
  logError('❌ OVERLEAF_SESSION_COOKIE is not set.');
  process.exit(1);
}
if (!OVERLEAF_GCLB_TOKEN_RAW) {
  logError('❌ OVERLEAF_GCLB_TOKEN is not set.');
  process.exit(1);
}

/* ─── LLM Clients ─── */
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ─── Shared user-agent ─── */
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ─── Provider Status Tracking ─── */
let lastUsedProvider = 'groq';

const isQuotaError = (error) => {
  const msg = String(error?.message || error).toLowerCase();
  const status = error?.status || error?.response?.status || error?.statusCode;
  log(`   [DEBUG] Error check - status: ${status}, message: ${msg.substring(0, 100)}`);
  return (
    status === 429 ||
    status === 403 ||
    msg.includes('quota') ||
    msg.includes('rate limit') ||
    msg.includes('rate_limit') ||
    msg.includes('too many requests') ||
    msg.includes('rate limiting') ||
    msg.includes('exhausted') ||
    msg.includes('429')
  );
};

/* ─── Multi-Provider LLM Call with Smart Fallback ─── */
const callLLM = async (prompt) => {
  const errors = {};
  let groqFailed = false;

  // Try Groq first
  if (groq) {
    try {
      log('🔄 Attempting Groq API call…');
      const result = await groq.chat.completions.create({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        max_tokens: 4096,
        temperature: 0.7,
      });
      const content = result.choices[0]?.message?.content;
      if (content) {
        log('✅ Groq API call successful.');
        lastUsedProvider = 'groq';
        return content;
      }
    } catch (groqError) {
      groqFailed = true;
      errors.groq = groqError;
      const errorStr = JSON.stringify({
        status: groqError.status,
        message: groqError.message,
        type: groqError.type,
        code: groqError.code
      });
      logError(`❌ Groq API failed:`);
      logError(`   ${errorStr}`);
      log(`\n🔄 Switching to Gemini provider…\n`);
    }
  } else {
    log('⚠️ Groq client not initialized (GROQ_API_KEY missing)');
  }

  // Fall back to Gemini (guaranteed if Groq failed or not available)
  if (groqFailed || !groq) {
    if (GEMINI_API_KEY) {
      try {
        log('🔄 Attempting Gemini API call…');
        log(`   Key: ${GEMINI_API_KEY.substring(0, 20)}...`);
        log(`   Endpoint: https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent`);
        
        const geminiPayload = {
          contents: [{
            parts: [{ text: prompt }]
          }]
        };

        const response = await axios.post(
          `https://generativelanguage.googleapis.com/v1/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
          geminiPayload,
          {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000,
            validateStatus: () => true // Don't throw on any status
          }
        );

        log(`   Response status: ${response.status}`);
        log(`   Response headers: ${JSON.stringify(response.headers, null, 2)}`);
        log(`   Response data: ${JSON.stringify(response.data, null, 2)}`);

        // Check for Gemini API errors
        if (response.status >= 400) {
          const errMsg = JSON.stringify(response.data, null, 2);
          logError(`   ❌ HTTP Error ${response.status}`);
          logError(`   Error response: ${errMsg}`);
          throw new Error(`Gemini HTTP ${response.status}: ${errMsg}`);
        }

        const textContent = response.data?.candidates?.[0]?.content?.parts?.[0]?.text;
        if (textContent) {
          log('✅ Gemini API call successful.');
          lastUsedProvider = 'gemini';
          return textContent;
        }
        
        logError('   ❌ No text content in Gemini response');
        logError(`   Full response: ${JSON.stringify(response.data)}`);
        throw new Error('Gemini returned empty response');
      } catch (geminiError) {
        errors.gemini = geminiError;
        logError(`❌ Gemini API failed:`);
        logError(`   Error: ${geminiError.message}`);
        logError(`   Stack: ${geminiError.stack}`);
      }
    } else {
      logError('❌ Gemini API key not configured. Cannot fallback from Groq.');
      errors.gemini = new Error('GEMINI_API_KEY not configured');
    }
  }

  // Both failed
  logError('\n❌ BOTH providers failed:');
  logError('   Groq error:', errors.groq?.message || 'No error captured');
  logError('   Gemini error:', errors.gemini?.message || 'No error captured');
  logError('\n📋 Diagnostics:');
  logError(`   Groq configured: ${!!groq}`);
  logError(`   Gemini configured: ${!!GEMINI_API_KEY}`);
  logError(`   Groq failed: ${groqFailed}`);
  throw new Error('Both LLM providers failed. Check API keys, quotas, and network.');
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

const isCompileStillPending = (compileData) => {
  const status = String(
    compileData?.status || compileData?.compile?.status || compileData?.state || ''
  ).toLowerCase();

  return /pending|running|compil|queued|processing|in[-_ ]?progress/.test(status);
};

const stripMarkdown = (value = '') => {
  return String(value)
    .replace(/\r\n/g, '\n')
    .replace(/[“”]/g, '"')
    .replace(/[‘’]/g, "'")
    .replace(/[–—]/g, '--')
    .replace(/\u00a0/g, ' ')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1 ($2)')
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s*[-*+]\s+/gm, '')
    .replace(/^\s*\d+\.\s+/gm, '')
    .replace(/\*\*/g, '')
    .replace(/__/g, '')
    .replace(/`/g, '')
    .trim();
};

const escapeLatex = (value = '') => {
  const cleaned = stripMarkdown(value);
  let result = cleaned;
  
  // Order matters: backslash must be first
  result = result.replace(/\\/g, '\\textbackslash{}');
  result = result.replace(/&/g, '\\&');
  result = result.replace(/%/g, '\\%');
  result = result.replace(/\$/g, '\\$');
  result = result.replace(/#/g, '\\#');
  result = result.replace(/_/g, '\\_');
  result = result.replace(/\{/g, '\\{');
  result = result.replace(/\}/g, '\\}');
  result = result.replace(/~/g, '\\textasciitilde{}');
  result = result.replace(/\^/g, '\\textasciicircum{}');
  
  return result;
};

const firstNonEmptyLine = (lines) => {
  return lines.find((line) => line && !/^[-_*]{3,}$/.test(line)) || 'Tailored Resume';
};

const splitContactLine = (line = '') => {
  return line
    .replace(/^phone\s+no\s*:/i, 'Phone:')
    .split(/\s+\|\s+|\s{2,}/)
    .map((part) => stripMarkdown(part))
    .filter(Boolean)
    .filter((part) => !/^address\s*:/i.test(part));
};

const parseResumeMarkdown = (markdownResume) => {
  const rawLines = String(markdownResume)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

  const headingAliases = new Map([
    ['professional summary', 'SUMMARY'],
    ['summary', 'SUMMARY'],
    ['education', 'EDUCATION'],
    ['work experience', 'EXPERIENCE'],
    ['experience', 'EXPERIENCE'],
    ['employment history', 'EXPERIENCE'],
    ['skills', 'SKILLS'],
    ['technical skills', 'SKILLS'],
    ['projects', 'PROJECTS'],
    ['project experience', 'PROJECTS'],
    ['achievements', 'ACHIEVEMENTS'],
    ['certifications', 'ACHIEVEMENTS'],
    ['awards', 'ACHIEVEMENTS'],
  ]);

  const sections = {
    SUMMARY: [],
    EDUCATION: [],
    EXPERIENCE: [],
    SKILLS: [],
    PROJECTS: [],
    ACHIEVEMENTS: [],
  };
  const contact = [];
  let currentSection = null;
  let name = '';

  for (const line of rawLines) {
    if (/^[-_*]{3,}$/.test(line)) continue;

    const normalizedHeading = stripMarkdown(line).replace(/:$/, '').toLowerCase();
    if (headingAliases.has(normalizedHeading)) {
      currentSection = headingAliases.get(normalizedHeading);
      continue;
    }

    if (!name) {
      name = stripMarkdown(line);
      continue;
    }

    if (!currentSection && /^(address|phone|phone no|email|linkedin|github)\s*:/i.test(stripMarkdown(line))) {
      contact.push(...splitContactLine(line));
      continue;
    }

    if (!currentSection && line.includes('|')) {
      contact.push(...splitContactLine(line));
      continue;
    }

    if (currentSection) {
      sections[currentSection].push(stripMarkdown(line));
    }
  }

  return {
    name: name || stripMarkdown(firstNonEmptyLine(rawLines)),
    contact: [...new Set(contact)].slice(0, 5),
    sections,
  };
};

const renderItemList = (items) => {
  const safeItems = items.map((item) => escapeLatex(item)).filter(Boolean);
  if (!safeItems.length) return '';

  return `\\begin{itemize}[topsep=0pt, itemsep=3pt, leftmargin=0.2in]
${safeItems.map((item) => `  \\resumeItem{${item}}`).join('\n')}
\\end{itemize}`;
};

const renderSection = (icon, title, items) => {
  const body = renderItemList(items);
  if (!body) return '';
  return `\\sectiontitle{${title}}
${body}`;
};

const buildLatexResume = (markdownResume) => {
  const { name, contact, sections } = parseResumeMarkdown(markdownResume);
  const contactLine = contact.length
    ? contact.map((part) => escapeLatex(part)).join(' \\textbar\\ ')
    : '';

  const summary = sections.SUMMARY.length
    ? `\\sectiontitle{SUMMARY}
\\small ${escapeLatex(sections.SUMMARY.join(' '))}`
    : '';

  const renderedSections = [
    summary,
    renderSection('graduation-cap', 'EDUCATION', sections.EDUCATION),
    renderSection('briefcase', 'EXPERIENCE', sections.EXPERIENCE),
    renderSection('project-diagram', 'PROJECTS', sections.PROJECTS.slice(0, 8)),
    renderSection('code', 'SKILLS', sections.SKILLS),
    renderSection('award', 'ACHIEVEMENTS', sections.ACHIEVEMENTS),
  ]
    .filter(Boolean)
    .join('\n\n');

  return `\\documentclass[letterpaper,11pt]{article}

\\usepackage[utf8]{inputenc}
\\usepackage[T1]{fontenc}
\\usepackage[english]{babel}
\\usepackage{latexsym}
\\usepackage[empty]{fullpage}
\\usepackage{titlesec}
\\usepackage{xcolor}
\\usepackage{enumitem}
\\usepackage[hidelinks]{hyperref}
\\usepackage{fancyhdr}

\\definecolor{darkblue}{RGB}{31, 58, 95}
\\definecolor{lightgrey}{gray}{0.92}

\\pagestyle{fancy}
\\fancyhf{}
\\renewcommand{\\headrulewidth}{0pt}
\\renewcommand{\\footrulewidth}{0pt}

\\setlength{\\oddsidemargin}{-0.5in}
\\setlength{\\evensidemargin}{-0.5in}
\\setlength{\\textwidth}{7.5in}
\\setlength{\\topmargin}{-0.5in}
\\setlength{\\textheight}{10in}

\\urlstyle{same}
\\raggedbottom
\\raggedright
\\setlength{\\tabcolsep}{0in}
\\setlength{\\parindent}{0pt}
\\setlength{\\parskip}{2pt}

\\titleformat{\\section}[block]{
  \\vspace{-8pt}
  \\raggedright
  \\large
  \\bfseries
  \\color{darkblue}
}{}{0pt}{}{\\vspace{-4pt}}

\\titlespacing{\\section}{0pt}{10pt}{4pt}

\\newcommand{\\sectiontitle}[1]{\\section{\\MakeUppercase{#1}}}
\\newcommand{\\resumeItem}[1]{\\item \\small{#1}}

\\color{black}

\\begin{document}

\\begin{center}
{\\Large \\textbf{${escapeLatex(name)}}}\\\\[3pt]
${contactLine ? `{\\small ${contactLine}}\\\\[2pt]` : ''}
\\end{center}

${renderedSections || '\\sectiontitle{Summary}\n\\small Tailored resume content was generated successfully.'}

\\end{document}`;
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
    log('📝 Step 1: Calling LLM for ATS resume rewrite…');

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

    const markdownResume = await callLLM(step1Prompt);

    if (!markdownResume) {
      throw new Error('Groq returned an empty resume.');
    }

    log('✅ Step 1 complete — markdown resume generated.');

    /* ── Step 2: Deterministic Markdown → LaTeX ── */
    log('📝 Step 2: Rendering safe LaTeX…');
    const latexCode = buildLatexResume(markdownResume);

    log('✅ Step 2 complete — LaTeX generated.');
    log(`   LaTeX length: ${latexCode.length} chars`);

    /* ── Step 3: Decode Overleaf session cookie ── */
    log('🔑 Step 3: Decoding Overleaf credentials…');

    const SESSION_COOKIE = decodeURIComponent(OVERLEAF_SESSION_COOKIE_RAW);
    const GCLB_TOKEN = OVERLEAF_GCLB_TOKEN_RAW;

    const cookieStr = `overleaf_session2=${SESSION_COOKIE}; GCLB=${GCLB_TOKEN}`;

    log('✅ Step 3 complete.');

    /* ── Step 4: GET /project to fetch CSRF token ── */
    log('🔐 Step 4: Fetching Overleaf CSRF token…');

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
    log('✅ Step 4 complete — CSRF token obtained.');

    /* ── Step 5: POST /docs to create project ── */
    log('📤 Step 5: Creating Overleaf project…');

    const createResponse = await axios.post(
      'https://www.overleaf.com/docs',
      new URLSearchParams({
        _csrf: csrfToken,
        snip: latexCode,
        engine: 'pdflatex',
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
    log(`✅ Step 5 complete — project created: ${projectId}`);

    /* ── Step 6: POST compile ── */
    log('🔨 Step 6: Compiling PDF on Overleaf…');

    let compileData = null;
    let pdfFile = null;

    for (let attempt = 1; attempt <= 5; attempt += 1) {
      const compileResponse = await axios.post(
        `https://www.overleaf.com/project/${projectId}/compile`,
        new URLSearchParams({
          check: 'silent',
          draft: 'false',
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

      compileData = compileResponse.data;
      const outputFiles = compileData?.outputFiles || [];
      pdfFile = outputFiles.find((f) => f.path === 'output.pdf');

      if (pdfFile) break;
      if (!isCompileStillPending(compileData) && attempt >= 2) break;

      log(`   Overleaf compile not ready yet; retrying (${attempt}/5)…`);
      await sleep(2000);
    }

    const projectUrl = `https://www.overleaf.com/project/${projectId}`;

    if (!pdfFile) {
      const diagnostics = extractCompileDiagnostics(compileData);
      logError('❌ Overleaf compile failed:', diagnostics);

      return res.status(200).json({
        status: 'error',
        message: `PDF compilation failed. ${diagnostics} Open the project in Overleaf to view the full logs: ${projectUrl}`,
        projectUrl,
        diagnostics,
      });
    }

    const pdfUrl = 'https://www.overleaf.com' + pdfFile.url;
    log('✅ Step 6 complete — PDF compiled.');

    /* ── Step 7: Download the PDF ── */
    log('📥 Step 7: Downloading compiled PDF…');

    const pdfResponse = await axios.get(pdfUrl, {
      headers: {
        Cookie: cookieStr,
        'User-Agent': UA,
      },
      responseType: 'arraybuffer',
    });

    const pdfBase64 = Buffer.from(pdfResponse.data).toString('base64');
    log('✅ Step 7 complete — PDF downloaded and encoded.');

    /* ── Return success ── */
    return res.json({
      status: 'success',
      projectUrl,
      pdfUrl,
      pdfBase64,
    });
  } catch (err) {
    logError('❌ Error:', err.message);
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
const server = app.listen(PORT, () => {
  log(`🚀 ATS Resume Tailor backend running on http://localhost:${PORT}`);
  log(`🔌 Server is listening and ready to accept requests`)
});

// Error handlers
process.on('uncaughtException', (err) => {
  logError('❌ UNCAUGHT EXCEPTION:', err);
});

process.on('unhandledRejection', (reason, promise) => {
  logError('❌ UNHANDLED REJECTION:', reason);
});

// Prevent process from exiting
process.on('SIGINT', () => {
  log('\n📌 Shutting down gracefully...');
  server.close(() => {
    log('✅ Server closed');
    process.exit(0);
  });
});

// Keep-alive interval
setInterval(() => {
  // Server is running
}, 30000);
