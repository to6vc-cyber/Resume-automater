import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import Groq from 'groq-sdk';
import axios from 'axios';
import PDFDocument from 'pdfkit';
import fs from 'fs';
import path from 'path';
import os from 'os';

const app = express();
app.use(cors());
app.use(express.json({ limit: '5mb' }));

const IS_SERVERLESS = process.env.VERCEL === '1';

// Log file path
const LOG_FILE = process.env.VERCEL === '1' || process.env.VERCEL === 'true' ? path.join(os.tmpdir(), 'server.log') : path.join(process.cwd(), 'server.log');

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
try {
  fs.writeFileSync(LOG_FILE, `[${new Date().toISOString()}] Server started\n`);
} catch (e) {
  console.warn('Could not write server log file (continuing):', e.message);
}

// Request logging middleware
app.use((req, res, next) => {
  log(`📨 ${req.method} ${req.path}`);
  next();
});

const PORT = process.env.PORT || 3001;

/* ─── Validate env vars ─── */
const GROQ_API_KEY = process.env.GROQ_API_KEY;
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;

if (!GROQ_API_KEY) {
  log('⚠️ GROQ_API_KEY is not set. Gemini will be used as fallback.');
}
if (!GEMINI_API_KEY) {
  log('⚠️ GEMINI_API_KEY is not set. Groq will be primary.');
}
if (!GROQ_API_KEY && !GEMINI_API_KEY) {
  logError('❌ Neither GROQ_API_KEY nor GEMINI_API_KEY is set.');
  logError('   Continuing without keys — requests will return an error instead of crashing the function.');
  // Do NOT exit the process in serverless environments; handle errors per-request.
}

/* ─── LLM Clients ─── */
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

/* ─── PDF Rendering (PDFKit) ─── */
const compileResumeToPDF = async (markdownResume) => {
  try {
    log('🔨 Rendering PDF with PDFKit…');

    const { name, contact, sections } = parseResumeMarkdown(markdownResume);
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 44, bottom: 44, left: 46, right: 46 },
      bufferPages: true,
      compress: true,
    });

    const pdfBuffer = await new Promise((resolve, reject) => {
      const chunks = [];
      doc.on('data', (chunk) => chunks.push(chunk));
      doc.on('end', () => resolve(Buffer.concat(chunks)));
      doc.on('error', reject);

      const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
      const safeText = (value = '') => String(value).replace(/\r/g, '').replace(/\s+/g, ' ').trim();
      const cleanItem = (value = '') => safeText(value).replace(/^[\u2022\u2023\u25E6\u2043\u2219•\-*]+\s*/, '');
      const dedupe = (items = []) => [...new Set(items.map(cleanItem).filter(Boolean))];
      const splitTitleDate = (value = '') => {
        const text = cleanItem(value);
        const dateMatch = text.match(/(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4}\s*[-–]\s*(?:present|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s+\d{4})\b|\b\d{4}\s*[-–]\s*(?:present|\d{4})\b)$/i);
        if (!dateMatch) return { title: text, date: '' };
        return {
          title: text.slice(0, dateMatch.index).replace(/[|,-]\s*$/, '').trim(),
          date: dateMatch[0].trim(),
        };
      };

      const writeSectionHeading = (heading, compact = false) => {
        doc.moveDown(compact ? 0.45 : 0.65);
        doc.font('Helvetica-Bold').fontSize(11).fillColor('#111111').text(heading.toUpperCase(), {
          width: contentWidth,
        });
        doc.moveDown(0.2);
      };

      const writeParagraph = (text, options = {}) => {
        const value = cleanItem(text);
        if (!value) return;
        doc.font(options.font || 'Helvetica').fontSize(options.size || 10).text(value, {
          width: contentWidth,
          align: options.align || 'left',
          lineGap: options.lineGap || 2,
          paragraphGap: options.paragraphGap ?? 4,
        });
      };

      const writeBullets = (items) => {
        const filtered = dedupe(items);
        for (const item of filtered) {
          doc.font('Helvetica').fontSize(10).fillColor('#111111').text(`• ${item}`, {
            width: contentWidth,
            indent: 10,
            continued: false,
            lineGap: 2,
            paragraphGap: 2,
          });
        }
      };

      const writeSkills = (items) => {
        const filtered = dedupe(items);
        if (!filtered.length) {
          writeBullets(['Social media marketing', 'Performance marketing', 'Analytics and reporting']);
          return;
        }

        for (const item of filtered) {
          const parts = item.split(':');
          if (parts.length > 1) {
            const label = cleanItem(parts.shift());
            const value = cleanItem(parts.join(':'));
            doc.font('Helvetica').fontSize(10).fillColor('#111111').text('• ', {
              width: contentWidth,
              continued: true,
            });
            doc.font('Helvetica-Bold').fontSize(10).text(`${label}: `, { continued: true });
            doc.font('Helvetica').fontSize(10).text(value, {
              width: contentWidth,
              lineGap: 2,
              paragraphGap: 2,
            });
          } else {
            doc.font('Helvetica').fontSize(10).fillColor('#111111').text(`• ${item}`, {
              width: contentWidth,
              lineGap: 2,
              paragraphGap: 2,
            });
          }
        }
      };

      const writeExperience = (items) => {
        const filtered = dedupe(items);
        if (!filtered.length) {
          writeBullets(['Managed and executed key initiatives aligned to role expectations.']);
          return;
        }

        const [firstLine, ...remaining] = filtered;
        const { title, date } = splitTitleDate(firstLine);
        if (title) {
          doc.font('Helvetica-Bold').fontSize(10.4).fillColor('#111111').text(title, {
            width: contentWidth,
            continued: !!date,
          });
          if (date) {
            doc.font('Helvetica-Oblique').fontSize(10).text(`   ${date}`, {
              width: contentWidth,
              align: 'right',
            });
          } else {
            doc.moveDown(0.12);
          }
        }
        writeBullets(remaining.length ? remaining : filtered.slice(0, 3));
      };

      const writeEducation = (items) => {
        const filtered = dedupe(items);
        if (!filtered.length) {
          writeBullets(['Degree | Institution | Year']);
          return;
        }

        for (const item of filtered) {
          const parts = item.split('|').map((part) => cleanItem(part)).filter(Boolean);
          if (parts.length >= 2) {
            const left = parts.slice(0, parts.length - 1).join(' | ');
            const right = parts[parts.length - 1];
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(left, {
              width: contentWidth,
              continued: true,
            });
            doc.font('Helvetica-Oblique').fontSize(9.8).text(`   ${right}`, {
              width: contentWidth,
              align: 'right',
            });
          } else {
            doc.font('Helvetica').fontSize(10).text(`• ${item}`, {
              width: contentWidth,
              lineGap: 2,
              paragraphGap: 2,
            });
          }
        }
      };

      doc.font('Helvetica-Bold').fontSize(18).fillColor('#111111').text(cleanItem(name) || 'Tailored Resume', {
        width: contentWidth,
        align: 'left',
      });

      if (contact.length) {
        doc.moveDown(0.15);
        doc.font('Helvetica').fontSize(9.6).fillColor('#333333').text(contact.map((part) => cleanItem(part)).filter(Boolean).join('  •  '), {
          width: contentWidth,
          align: 'left',
        });
      }

      doc.moveDown(0.25);
      doc.strokeColor('#9a9a9a').lineWidth(1).moveTo(doc.page.margins.left, doc.y).lineTo(doc.page.width - doc.page.margins.right, doc.y).stroke();
      doc.moveDown(0.3);

      const summaryText = sections.SUMMARY.length
        ? sections.SUMMARY.join(' ')
        : 'A focused professional summary aligned to the target role.';
      writeSectionHeading('Professional Summary', true);
      writeParagraph(summaryText);

      writeSectionHeading('Skills', true);
      writeSkills(sections.SKILLS);

      const experienceItems = sections.EXPERIENCE.length
        ? sections.EXPERIENCE
        : ['Add your most relevant experience here.', 'Keep bullets concise and impact-driven.', 'Use action verbs and measurable outcomes.'];
      writeSectionHeading('Experience', true);
      writeExperience(experienceItems);

      writeSectionHeading('Education', true);
      writeEducation(sections.EDUCATION);

      const projectItems = sections.PROJECTS.length
        ? sections.PROJECTS
        : ['What you built', 'What problem it solves', 'Any result or outcome'];
      writeSectionHeading('Projects', true);
      writeBullets(projectItems);

      if (sections.ACHIEVEMENTS.length) {
        writeSectionHeading('Achievements', true);
        writeBullets(sections.ACHIEVEMENTS);
      }

      if (sections.CERTIFICATIONS.length) {
        writeSectionHeading('Certifications', true);
        writeBullets(sections.CERTIFICATIONS);
      }

      if (sections.TOOLS.length) {
        writeSectionHeading('Tools & Platforms', true);
        writeSkills(sections.TOOLS);
      }

      doc.end();
    });

    log('✅ PDF rendered successfully (PDFKit)');
    return pdfBuffer.toString('base64');
  } catch (error) {
    logError(`❌ PDFKit rendering failed: ${error.message}`);
    return null;
  }
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

const normalizeHeadingText = (value = '') => {
  return stripMarkdown(value)
    .replace(/[:-]+$/, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
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
    ['summary of qualifications', 'SUMMARY'],
    ['career summary', 'SUMMARY'],
    ['summary', 'SUMMARY'],
    ['education', 'EDUCATION'],
    ['academic background', 'EDUCATION'],
    ['work experience', 'EXPERIENCE'],
    ['professional experience', 'EXPERIENCE'],
    ['career experience', 'EXPERIENCE'],
    ['experience', 'EXPERIENCE'],
    ['employment history', 'EXPERIENCE'],
    ['work history', 'EXPERIENCE'],
    ['skills', 'SKILLS'],
    ['technical skills', 'SKILLS'],
    ['core competencies', 'SKILLS'],
    ['key skills', 'SKILLS'],
    ['technical expertise', 'SKILLS'],
    ['projects', 'PROJECTS'],
    ['selected projects', 'PROJECTS'],
    ['key projects', 'PROJECTS'],
    ['project experience', 'PROJECTS'],
    ['achievements', 'ACHIEVEMENTS'],
    ['achievements and awards', 'ACHIEVEMENTS'],
    ['awards and honors', 'ACHIEVEMENTS'],
    ['certifications', 'CERTIFICATIONS'],
    ['certificates', 'CERTIFICATIONS'],
    ['awards', 'ACHIEVEMENTS'],
    ['honors', 'ACHIEVEMENTS'],
    ['additional information', 'ACHIEVEMENTS'],
    ['additional skills', 'ACHIEVEMENTS'],
    ['tools & platforms', 'TOOLS'],
    ['tools and platforms', 'TOOLS'],
    ['tools', 'TOOLS'],
    ['platforms', 'TOOLS'],
  ]);

  const sections = {
    SUMMARY: [],
    EDUCATION: [],
    EXPERIENCE: [],
    SKILLS: [],
    PROJECTS: [],
    ACHIEVEMENTS: [],
    CERTIFICATIONS: [],
    TOOLS: [],
  };
  const contact = [];
  let name = '';
  let currentSection = null;

  for (const line of rawLines) {
    if (/^[-_*]{3,}$/.test(line)) continue;

    const normalizedHeading = normalizeHeadingText(line);
    if (headingAliases.has(normalizedHeading)) {
      currentSection = headingAliases.get(normalizedHeading);
      continue;
    }

    if (/^(professional summary|summary of qualifications|career summary|education|academic background|work experience|professional experience|career experience|employment history|work history|skills|technical skills|core competencies|key skills|technical expertise|projects|selected projects|key projects|achievements|certifications|certificates|awards|honors|additional information|tools\s*&\s*platforms|tools and platforms|tools|platforms)\b/i.test(normalizedHeading)) {
      const matchedHeading = normalizeHeadingText(normalizedHeading.split(':')[0]);
      currentSection = headingAliases.get(matchedHeading) || currentSection;
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

const extractFallbackKeywords = (text = '', limit = 8) => {
  const stopWords = new Set([
    'the', 'and', 'for', 'with', 'that', 'from', 'this', 'your', 'you', 'are', 'was', 'were',
    'has', 'have', 'had', 'into', 'over', 'under', 'using', 'used', 'use', 'role', 'job', 'resume',
    'experience', 'skills', 'skill', 'work', 'team', 'teams', 'build', 'built', 'develop', 'developed',
    'ability', 'responsible', 'responsibilities', 'preferred', 'required', 'preferred', 'including',
    'across', 'such', 'etc', 'our', 'their', 'they', 'them', 'can', 'will', 'may', 'should', 'must'
  ]);

  const tokens = stripMarkdown(text)
    .toLowerCase()
    .match(/[a-z0-9#+.-]{3,}/g) || [];

  const picked = [];
  const seen = new Set();

  for (const token of tokens) {
    if (stopWords.has(token) || seen.has(token)) continue;
    seen.add(token);
    picked.push(token.replace(/^[^a-z0-9]+|[^a-z0-9#+.-]+$/g, ''));
    if (picked.length >= limit) break;
  }

  return picked;
};

const collectResumeSnippets = (text = '', limit = 5) => {
  const ignoredHeading = /^(professional summary|summary|education|work experience|professional experience|employment history|skills|technical skills|projects|project experience|achievements|certifications|awards|additional information)\b/i;
  const ignoredContact = /^(address|phone|phone no|email|linkedin|github)\s*:/i;
  const lines = String(text)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripMarkdown(line).replace(/^[•*-]\s*/, '').trim())
    .filter(Boolean);

  const snippets = [];
  for (const line of lines) {
    if (ignoredHeading.test(line) || ignoredContact.test(line)) continue;
    if (/^https?:\/\//i.test(line)) continue;
    if (line.includes('|') && line.length < 40) continue;
    if (snippets.includes(line)) continue;
    snippets.push(line);
    if (snippets.length >= limit) break;
  }

  return snippets;
};

const buildFallbackBulletLines = (snippets, keywords, fallbackLabel, limit = 3) => {
  const lines = [];

  for (const snippet of snippets) {
    if (lines.length >= limit) break;
    lines.push(snippet);
  }

  while (lines.length < limit) {
    const keywordPhrase = keywords.slice(lines.length * 2, lines.length * 2 + 3).join(', ');
    lines.push(keywordPhrase ? `${fallbackLabel} with ${keywordPhrase}.` : `${fallbackLabel}.`);
  }

  return lines;
};

const buildOfflineResumeMarkdown = (jobDescription, currentResume, errorMessage = '') => {
  const parsed = parseResumeMarkdown(currentResume);
  const jobKeywords = extractFallbackKeywords(jobDescription, 8);
  const resumeKeywords = extractFallbackKeywords(currentResume, 8);
  const combinedKeywords = [...new Set([...jobKeywords, ...resumeKeywords])].slice(0, 8);
  const resumeSnippets = collectResumeSnippets(currentResume, 6);

  const contactLine = parsed.contact.length
    ? parsed.contact.join(' | ')
    : 'Phone | Email | LinkedIn | GitHub';

  const summary = jobKeywords.length
    ? `Targeting ${jobKeywords.slice(0, 3).join(', ')} roles with a focus on ${jobKeywords.slice(3, 6).join(', ') || jobKeywords.slice(0, 3).join(', ')} and hands-on delivery.`
    : 'Targeting the requested role with a focus on clear impact, ATS keywords, and concise execution.';

  const educationLines = parsed.sections.EDUCATION.length
    ? parsed.sections.EDUCATION
    : ['Degree | Institution | Location | Dates'];

  const experienceLines = parsed.sections.EXPERIENCE.length
    ? parsed.sections.EXPERIENCE
    : buildFallbackBulletLines(resumeSnippets, combinedKeywords, 'Delivered frontend work', 3);

  const projectLines = parsed.sections.PROJECTS.length
    ? parsed.sections.PROJECTS
    : [
        jobKeywords.length
          ? `Project aligned to ${jobKeywords.slice(0, 4).join(', ')}.`
          : 'Project aligned to the target role.',
        ...buildFallbackBulletLines(resumeSnippets.slice(0, 2), combinedKeywords, 'Built and shipped a focused project', 2),
      ];

  const skillLines = parsed.sections.SKILLS.length
    ? parsed.sections.SKILLS
    : [
        combinedKeywords.length ? combinedKeywords.join(', ') : 'Keyword alignment, execution, communication',
        jobKeywords.length ? `Role focus: ${jobKeywords.slice(0, 4).join(', ')}` : 'Role focus: adaptable frontend delivery',
      ];

  const achievementLines = parsed.sections.ACHIEVEMENTS.length
    ? parsed.sections.ACHIEVEMENTS
    : [
        errorMessage
          ? `Generated as a safe fallback after LLM provider errors: ${stripMarkdown(errorMessage)}`
          : 'Generated as a safe fallback when online providers were unavailable.',
      ];

  return [
    parsed.name || 'Tailored Resume',
    contactLine,
    '',
    'Professional Summary',
    summary,
    '',
    'Education',
    ...educationLines,
    '',
    'Work Experience',
    ...experienceLines.map((line) => `- ${line}`),
    '',
    'Skills',
    ...skillLines.map((line) => `- ${line}`),
    '',
    'Projects',
    ...projectLines.map((line) => `- ${line}`),
    '',
    'Achievements',
    ...achievementLines.map((line) => `- ${line}`),
  ].join('\n');
};

const buildLatexResume = (markdownResume) => {
  const { name, contact, sections } = parseResumeMarkdown(markdownResume);
  const contactLine = contact.length
    ? contact.map((part) => escapeLatex(part)).join(' \\quad | \\quad ')
    : '';

  const summaryText = sections.SUMMARY.length
    ? escapeLatex(sections.SUMMARY.join(' '))
    : 'A short 2--3 line professional summary. Keep it clean and impactful.';

  const skillsText = sections.SKILLS.length
    ? sections.SKILLS.map((item) => escapeLatex(item)).join(', ')
    : 'Skill1, Skill2, Skill3';

  const experienceItems = sections.EXPERIENCE.length
    ? sections.EXPERIENCE.map((item) => escapeLatex(item))
    : ['Achievement or responsibility written in one line', 'Use action verbs and measurable results', 'Keep it concise and impactful'];

  const projectItems = sections.PROJECTS.length
    ? sections.PROJECTS.map((item) => escapeLatex(item))
    : ['What you built', 'What problem it solves', 'Any result or outcome'];
  const projectTitle = sections.PROJECTS.length
    ? escapeLatex(sections.PROJECTS[0])
    : 'Selected Project';
  const projectDetails = sections.PROJECTS.length > 1
    ? sections.PROJECTS.slice(1).map((item) => escapeLatex(item))
    : projectItems;

  const educationText = sections.EDUCATION.length
    ? escapeLatex(sections.EDUCATION.join(' | '))
    : 'College Name | Year | Degree | Location';

  const extraText = sections.ACHIEVEMENTS.length
    ? escapeLatex(sections.ACHIEVEMENTS.join(' '))
    : 'Certifications, achievements, or anything extra.';

  return `\\documentclass[a4paper,10pt]{article}

\\usepackage[left=0.7in,right=0.7in,top=0.6in,bottom=0.6in]{geometry}
\\usepackage{enumitem}
\\usepackage{titlesec}
\\usepackage{hyperref}
\\usepackage{xcolor}

% ---------- FONT ----------
\\usepackage{helvet}
\\renewcommand{\\familydefault}{\\sfdefault}

% ---------- SECTION STYLE ----------
\\titleformat{\\section}{
  \\large\\bfseries\\uppercase
}{}{0em}{}[\\titlerule]

% ---------- CUSTOM COMMANDS ----------
\\newcommand{\\resumeItem}[1]{
  \\item \\small{#1}
}

\\newcommand{\\resumeSubheading}[4]{
  \\vspace{2pt}
  \\textbf{#1} \\hfill {\\small #2} \\\\
  \\textit{\\small #3} \\hfill \\textit{\\small #4} \\\\
}

\\newcommand{\\resumeProject}[2]{
  \\textbf{#1} \\hfill {\\small #2} \\\\
}

\\setlist[itemize]{noitemsep, topsep=0pt}

\\begin{document}

\\begin{center}
    {\\LARGE \\textbf{${escapeLatex(name)}}} \\\\
    \\vspace{4pt}
    \\small
    ${contactLine}
\\end{center}

\\vspace{-8pt}

\\section*{Summary}
\\small{
${summaryText}
}

\\section*{Skills}
\\small{
\\textbf{Skills:} ${skillsText}
}

\\section*{Experience}
\\begin{itemize}
${experienceItems.map((item) => `  \\resumeItem{${item}}`).join('\n')}
\\end{itemize}

\\section*{Projects}
\\resumeProject{${projectTitle}}{${skillsText.split(',').slice(0, 3).join(', ') || 'Tech Stack'}}
\\begin{itemize}
${projectDetails.map((item) => `  \\resumeItem{${item}}`).join('\n')}
\\end{itemize}

\\section*{Education}
\\resumeSubheading
{${educationText}}{ }
{Degree}{Location}

\\section*{Additional Information}
\\small{
${extraText}
}

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

  // Declare variables at function level so they're accessible in all catch blocks
  let latexCode = null;
  let markdownResume = null;

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

    markdownResume = await callLLM(step1Prompt);

    if (!markdownResume) {
      throw new Error('Groq returned an empty resume.');
    }

    log('✅ Step 1 complete — markdown resume generated.');

    /* ── Step 2: Deterministic Markdown → LaTeX ── */
    log('📝 Step 2: Rendering safe LaTeX…');
    latexCode = buildLatexResume(markdownResume);

    log('✅ Step 2 complete — LaTeX generated.');
    log(`   LaTeX length: ${latexCode.length} chars`);

    /* ── Step 3: Render PDF locally ── */

    log('📝 Step 3: Rendering PDF locally.');
    let pdfBase64 = null;

    try {
      pdfBase64 = await compileResumeToPDF(markdownResume);
      if (pdfBase64) {
        log('✅ PDF rendering succeeded; returning PDF.');
        return res.json({
          status: 'success',
          message: '✅ Resume generated with locally rendered PDF',
          pdfBase64,
          projectUrl: null,
          pdfUrl: null,
          latexCode,
          markdownResume,
        });
      }
      log('⚠️ PDF renderer did not produce a PDF.');
    } catch (localErr) {
      logError('⚠️ PDF rendering attempt failed: ' + String(localErr.message || localErr));
    }

    return res.json({
      status: 'success',
      pdfBase64: pdfBase64,
      projectUrl: null,
      pdfUrl: null,
      message: pdfBase64 ? '✅ Resume generated with PDF' : '⚠️ Resume generated (PDF compilation skipped or failed)',
      latexCode,
      markdownResume,
    });
  } catch (err) {
    logError('❌ Error:', err.message);
    log('📄 Returning error response but keeping server alive');

    const fallbackMarkdownResume = buildOfflineResumeMarkdown(jobDescription, currentResume, err.message);
    const fallbackLatexCode = buildLatexResume(fallbackMarkdownResume);

    try {
      const fallbackPdfBase64 = await compileResumeToPDF(fallbackMarkdownResume);
      return res.status(200).json({
        status: fallbackPdfBase64 ? 'success' : 'partial',
        message: fallbackPdfBase64
          ? '✅ Resume generated with fallback content after provider issues.'
          : `✅ Resume generated with fallback content after provider issues. PDF rendering was skipped or failed: ${err.message}`,
        pdfBase64: fallbackPdfBase64,
        projectUrl: null,
        pdfUrl: null,
        latexCode: fallbackLatexCode,
        markdownResume: fallbackMarkdownResume,
      });
    } catch (fallbackErr) {
      logError('⚠️ Fallback generation also failed: ' + String(fallbackErr.message || fallbackErr));
    }
    
    // If we at least have LaTeX, return it
    if (latexCode) {
      return res.status(200).json({
        status: 'partial',
        message: `✅ Resume generated! Error during PDF compilation: ${err.message}`,
        pdfBase64: null,
        projectUrl: null,
        pdfUrl: null,
        latexCode: latexCode,
        markdownResume: markdownResume,
      });
    }
    
    // If we have markdown but no LaTeX, return markdown
    if (markdownResume) {
      return res.status(200).json({
        status: 'partial',
        message: `✅ Resume content generated! Error building LaTeX: ${err.message}`,
        pdfBase64: null,
        projectUrl: null,
        pdfUrl: null,
        latexCode: null,
        markdownResume: markdownResume,
      });
    }
    
    // No output at all - show error
    return res.status(200).json({
      status: 'error',
      message: `Failed to generate resume: ${err.message}. Please check your inputs and try again.`,
      pdfBase64: null,
      projectUrl: null,
      pdfUrl: null,
      latexCode: null,
      markdownResume: null,
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

if (!IS_SERVERLESS) {
  /* ─── Start ─── */
  const server = app.listen(PORT, () => {
    log(`🚀 ATS Resume Tailor backend running on http://localhost:${PORT}`);
    log(`🔌 Server is listening and ready to accept requests`)
  });

  // Error handlers
  process.on('uncaughtException', (err) => {
    logError('❌ UNCAUGHT EXCEPTION:', err);
  });

  process.on('unhandledRejection', (reason) => {
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
}

export default app;
