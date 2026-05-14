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

/* ─── LLM Clients ─── */
const groq = GROQ_API_KEY ? new Groq({ apiKey: GROQ_API_KEY }) : null;

if (!GROQ_API_KEY) {
  log('⚠️ GROQ_API_KEY is not set. Gemini will be used as fallback.');
}
if (!GEMINI_API_KEY) {
  log('⚠️ GEMINI_API_KEY is not set. Groq will be primary.');
}
if (!GROQ_API_KEY && !GEMINI_API_KEY) {
  logError('❌ Neither GROQ_API_KEY nor GEMINI_API_KEY is set.');
}

/* ─── PDF Rendering (PDFKit) ─── */
const compileResumeToPDF = async (markdownResume) => {
  try {
    log('🔨 Rendering PDF with PDFKit…');

    const { name, contact, sections } = parseResumeMarkdown(markdownResume);
    const doc = new PDFDocument({
      size: 'A4',
      margins: { top: 36, bottom: 36, left: 36, right: 36 },
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
      const bodyTextOptions = {
        width: contentWidth,
        align: 'left',
        lineGap: 4,
        paragraphGap: 5,
        wordSpacing: 0.2,
      };

      const writeBulletItem = (item, xOffset = 12) => {
        const startY = doc.y;
        doc.circle(doc.page.margins.left + 4, startY + 4.5, 1.2).fill('#000000');
        doc.font('Helvetica').fontSize(10).fillColor('#000000').text(cleanItem(item), {
          width: contentWidth - xOffset,
          indent: xOffset,
          lineGap: 4,
          paragraphGap: 4,
          wordSpacing: 0.2,
          align: 'left',
        });
      };
      
      const splitTitleDate = (value = '') => {
        const text = cleanItem(value);
        // Match standard date ranges like "Jan 2020 - Present", "2018-2020", etc.
        const dateMatch = text.match(/(\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*,?\s*\d{4}\s*[-–]\s*(?:present|current|\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\s*,?\s*\d{4})\b|\b\d{4}\s*[-–]\s*(?:present|current|\d{4})\b)$/i);
        if (!dateMatch) return { title: text, date: '' };
        return {
          title: text.slice(0, dateMatch.index).replace(/[|,-]\s*$/, '').trim(),
          date: dateMatch[0].trim(),
        };
      };

      const writeSectionHeading = (heading) => {
        doc.moveDown(0.9);
        doc.font('Helvetica-Bold').fontSize(11.5).fillColor('#111111').text(heading.toUpperCase(), {
          width: contentWidth,
          letterSpacing: 0.35,
        });
        doc.moveDown(0.15);
        doc.strokeColor('#b3b3b3').lineWidth(0.8)
           .moveTo(doc.page.margins.left, doc.y)
           .lineTo(doc.page.width - doc.page.margins.right, doc.y)
           .stroke();
        doc.moveDown(0.4);
      };

      const writeParagraph = (text) => {
        const value = cleanItem(text);
        if (!value) return;
        doc.font('Helvetica').fontSize(10).fillColor('#000000').text(value, {
          ...bodyTextOptions,
          align: 'left',
        });
      };

      const writeBullets = (items) => {
        const filtered = dedupe(items);
        for (const item of filtered) {
          writeBulletItem(item, 14);
          doc.moveDown(0.05);
        }
      };

      const writeExperience = (items) => {
        const filtered = dedupe(items);
        if (!filtered.length) return;

        let inJob = false;
        let jobIdx = 0;
        for (const item of filtered) {
          const { title, date } = splitTitleDate(item);
          
          let isHeader = date || item.includes('|') || (!inJob && jobIdx === 0 && !item.toLowerCase().startsWith('managed ') && !item.toLowerCase().startsWith('developed '));

          if (isHeader) {
            if (inJob) doc.moveDown(0.35); 
            
            let organization = '';
            let roleOrTitle = title || item;
            
            if (roleOrTitle.includes('|')) {
               const parts = roleOrTitle.split('|').map(s => s.trim());
               organization = parts[0];
               roleOrTitle = parts.slice(1).join(' | ');
            } else if (roleOrTitle.includes('-')) {
               const parts = roleOrTitle.split('-').map(s => s.trim());
               if(parts[0].length < 30) {
                 organization = parts[0];
                 roleOrTitle = parts.slice(1).join(' - ');
               }
            }

            const startY = doc.y;
            
            if (organization) {
               doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text(organization, {
                 continued: true,
                 width: contentWidth - 120,
               });
               doc.font('Helvetica').fontSize(10.5).fillColor('#111111').text(` | ${roleOrTitle}`, {
                 width: contentWidth - 120,
                 lineGap: 1,
                 wordSpacing: 0.15,
               });
            } else {
               doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111').text(roleOrTitle, {
                 width: contentWidth - 120,
                 lineGap: 1,
               });
            }
            
            const afterTitleY = doc.y;

            if (date) {
              doc.y = startY;
              doc.font('Helvetica').fontSize(9.5).fillColor('#555555').text(date, {
                width: contentWidth,
                align: 'right',
                wordSpacing: 0.15,
              });
              doc.y = Math.max(afterTitleY, doc.y);
            } else {
              doc.moveDown(0.1);
            }
            inJob = true;
          } else {
            writeBulletItem(item, 14);
            doc.moveDown(0.05);
          }
          jobIdx++;
        }
      };

      const writeEducation = (items) => {
        writeExperience(items);
      };

      const writeSkills = (items) => {
        const filtered = dedupe(items);
        if (!filtered.length) return;

        for (const item of filtered) {
          const parts = item.split(':');
          if (parts.length > 1) {
            const label = cleanItem(parts.shift());
            const value = cleanItem(parts.join(':'));
            doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(`${label}: `, {
              continued: true,
            });
            doc.font('Helvetica').fontSize(10).fillColor('#111111').text(value, {
              ...bodyTextOptions,
            });
          } else {
            doc.font('Helvetica').fontSize(10).fillColor('#111111').text(item, {
              ...bodyTextOptions,
            });
          }
        }
      };

      // === Render Professional Resume ===

      // Header: Name
      doc.font('Helvetica-Bold').fontSize(22).fillColor('#111111').text(cleanItem(name) || 'Tailored Resume', {
        width: contentWidth,
        align: 'center',
        lineGap: 0,
        wordSpacing: 0.2,
      });

      // Header: Contact Info
      if (contact.length) {
        doc.moveDown(0.18);
        doc.font('Helvetica').fontSize(9.3).fillColor('#555555').text(contact.map((part) => cleanItem(part)).filter(Boolean).join('  |  '), {
          width: contentWidth,
          align: 'center',
          wordSpacing: 0.15,
          lineGap: 0,
        });
      }

      // Summary
      if (sections.SUMMARY.length) {
        writeSectionHeading('Professional Summary');
        writeParagraph(sections.SUMMARY.join(' '));
      }

      // Experience
      if (sections.EXPERIENCE.length) {
        writeSectionHeading('Professional Experience');
        writeExperience(sections.EXPERIENCE);
      }

      // Projects
      if (sections.PROJECTS.length) {
        writeSectionHeading('Projects');
        writeExperience(sections.PROJECTS); // Uses the same date/title split heuristic which works perfectly for projects
      }

      // Education
      if (sections.EDUCATION.length) {
        writeSectionHeading('Education');
        writeEducation(sections.EDUCATION);
      }

      // Skills
      if (sections.SKILLS.length) {
        writeSectionHeading('Skills');
        writeSkills(sections.SKILLS);
      }

      // Certifications
      if (sections.CERTIFICATIONS.length) {
        writeSectionHeading('Certifications');
        writeSkills(sections.CERTIFICATIONS);
      }

      // Tools & Platforms
      if (sections.TOOLS.length) {
        writeSectionHeading('Tools & Platforms');
        writeSkills(sections.TOOLS);
      }

      // Achievements
      if (sections.ACHIEVEMENTS.length) {
        writeSectionHeading('Achievements');
        writeBullets(sections.ACHIEVEMENTS);
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
    .replace(/\*/g, '')
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
  const normalized = stripMarkdown(line);
  return line
    .replace(/^phone\s+no\s*:/i, 'Phone:')
    .split(/\s+\|\s+|\s{2,}/)
    .map((part) => stripMarkdown(part || normalized))
    .filter(Boolean)
    .filter((part) => !/^address\s*:/i.test(part));
};

const splitCleanParts = (value = '') => {
  return stripMarkdown(value)
    .split('|')
    .map((part) => part.trim())
    .filter(Boolean);
};

const isDateLike = (value = '') => /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)?[a-z]*\s*,?\s*\d{4}\s*[-–]\s*(?:present|current|\d{4})\b|\b\d{4}\s*[-–]\s*(?:present|current|\d{4})\b/i.test(value);

const findDateLike = (parts = []) => parts.find((part) => isDateLike(part)) || '';

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
    ? contact.map((part) => escapeLatex(part)).join(' \\hspace{1pt} $|$ \\hspace{1pt} ')
    : '[PHONE] \\hspace{1pt} $|$ \\hspace{1pt} [EMAIL] \\hspace{1pt} $|$ \\hspace{1pt} [LINKEDIN] \\hspace{1pt} $|$ \\hspace{1pt} [GITHUB] \\hspace{1pt} $|$ \\hspace{1pt} [LOCATION]';

  const summaryText = sections.SUMMARY.length
    ? escapeLatex(sections.SUMMARY.join(' '))
    : 'A concise, role-aligned summary focused on impact and ATS keywords.';

  const educationPrimaryParts = splitCleanParts(sections.EDUCATION[0] || '');
  const educationSecondaryParts = splitCleanParts(sections.EDUCATION[1] || '');
  const educationDegree = escapeLatex(educationPrimaryParts[0] || '[Degree]');
  const educationDates = escapeLatex(findDateLike(educationSecondaryParts) || educationPrimaryParts.slice(1).find(isDateLike) || '[Dates]');
  const educationSchool = escapeLatex(educationSecondaryParts[0] || educationPrimaryParts[1] || '[College Name]');
  const educationLocation = escapeLatex(educationSecondaryParts[1] || educationPrimaryParts[2] || '[Location]');

  const experienceParts = splitCleanParts(sections.EXPERIENCE[0] || '');
  const experienceCompany = escapeLatex(experienceParts[0] || '[Company Name]');
  const experienceLocation = escapeLatex(experienceParts[1] || '[Location]');
  const experienceTitle = escapeLatex(experienceParts[2] || '[Job Title]');
  const experienceDates = escapeLatex(findDateLike(experienceParts) || '[Start Date] - [End Date]');
  const experienceBullets = (sections.EXPERIENCE.slice(1, 4).length
    ? sections.EXPERIENCE.slice(1, 4)
    : ['[Achievement-driven bullet with keywords + impact]', '[Achievement-driven bullet with keywords + impact]', '[Achievement-driven bullet with keywords + impact]'])
    .map((item) => escapeLatex(item));

  const projectParts = splitCleanParts(sections.PROJECTS[0] || '');
  const projectTitle = escapeLatex(projectParts[0] || '[Project Title]');
  const projectDate = escapeLatex(findDateLike(projectParts) || '[Dates]');
  const projectBullet = escapeLatex(sections.PROJECTS[1] || '[Description with tools, keywords, and measurable impact]');

  const skillPairs = sections.SKILLS.length
    ? sections.SKILLS.slice(0, 2).map((item) => {
        const [label, ...rest] = stripMarkdown(item).split(':');
        return {
          label: escapeLatex((label || '[Category]').trim()),
          value: escapeLatex(rest.join(':').trim() || '[Relevant skills]'),
        };
      })
    : [
        { label: '[Category 1]', value: '[Relevant skills]' },
        { label: '[Category 2]', value: '[Relevant skills]' },
      ];

  const achievementPairs = sections.ACHIEVEMENTS.length
    ? sections.ACHIEVEMENTS.slice(0, 1).map((item) => {
        const [label, ...rest] = stripMarkdown(item).split(':');
        return {
          label: escapeLatex((label || '[Achievement]').trim()),
          value: escapeLatex(rest.join(':').trim() || '[detail]'),
        };
      })
    : [{ label: '[Achievement]', value: '[detail]' }];

  return String.raw`%-------------------------------------------
\documentclass[letterpaper,11pt]{article}

\usepackage{latexsym}
\usepackage[empty]{fullpage}
\usepackage{titlesec}
\usepackage{marvosym}
\usepackage[usenames,dvipsnames]{color}
\usepackage{verbatim}
\usepackage{enumitem}
\usepackage[hidelinks]{hyperref}
\usepackage{fancyhdr}
\usepackage[english]{babel}
\usepackage{tabularx}
\usepackage{fontawesome5}
\usepackage[scale=0.90,lf]{FiraMono}

\definecolor{light-grey}{gray}{0.83}
\definecolor{dark-grey}{gray}{0.3}
\definecolor{text-grey}{gray}{.08}

\DeclareRobustCommand{\ebseries}{\fontseries{eb}\selectfont}
\DeclareTextFontCommand{\texteb}{\ebseries}

\usepackage{contour}
\usepackage[normalem]{ulem}
\renewcommand{\ULdepth}{1.8pt}
\contourlength{0.8pt}
\newcommand{\myuline}[1]{%
  \uline{\phantom{#1}}%
  \llap{\contour{white}{#1}}%
}

\usepackage{tgheros}
\renewcommand*\familydefault{\sfdefault}
\usepackage[T1]{fontenc}

\pagestyle{fancy}
\fancyhf{}
\fancyfoot{}
\renewcommand{\headrulewidth}{0pt}
\renewcommand{\footrulewidth}{0pt}

\addtolength{\oddsidemargin}{-0.5in}
\addtolength{\evensidemargin}{0in}
\addtolength{\textwidth}{1in}
\addtolength{\topmargin}{-.5in}
\addtolength{\textheight}{1.0in}

\urlstyle{same}
\raggedbottom
\raggedright
\setlength{\tabcolsep}{0in}

	itleformat{\section}{
    \bfseries \vspace{2pt} \raggedright \large
}{}{0em}{}[\color{light-grey} {\titlerule[2pt]} \vspace{-4pt}]

\newcommand{\resumeItem}[1]{\item\small{{#1 \vspace{-1pt}}}}

\newcommand{\resumeSubheading}[4]{
  \vspace{-1pt}\item
    \begin{tabular*}{\textwidth}[t]{l@{\extracolsep{\fill}}r}
      	extbf{#1} & {\color{dark-grey}\small #2}\vspace{1pt}\\
      	extit{#3} & {\color{dark-grey} \small #4}\\
    \end{tabular*}\vspace{-4pt}
}

\newcommand{\resumeProjectHeading}[2]{
    \item
    \begin{tabular*}{\textwidth}{l@{\extracolsep{\fill}}r}
      #1 & {\color{dark-grey}} \\
    \end{tabular*}\vspace{-4pt}
}

\newcommand{\resumeSubItem}[1]{\resumeItem{#1}\vspace{-4pt}}
\renewcommand\labelitemii{$\vcenter{\hbox{\tiny$\bullet$}}$}

\newcommand{\resumeSubHeadingListStart}{\begin{itemize}[leftmargin=0in, label={}]}
\newcommand{\resumeSubHeadingListEnd}{\end{itemize}}
\newcommand{\resumeItemListStart}{\begin{itemize}}
\newcommand{\resumeItemListEnd}{\end{itemize}\vspace{0pt}}

\color{text-grey}

\begin{document}

%----------HEADING----------
\begin{center}
  	extbf{\Huge ${escapeLatex(name || 'Full Name')}} \\ \vspace{5pt}
    \small \faPhone* \texttt{${contactLine}} 
    \\ \vspace{-3pt}
\end{center}

\section{SUMMARY}
${summaryText}

\section{EDUCATION}
  \resumeSubHeadingListStart
    \resumeSubheading
      {${educationDegree}}{${educationDates}}
      {${educationSchool}}{${educationLocation}}
  \resumeSubHeadingListEnd

\section{EXPERIENCE}
  \resumeSubHeadingListStart
    \resumeSubheading
      {${experienceCompany}}{${experienceDates}}
      {${experienceTitle}}{${experienceLocation}}
      \resumeItemListStart
        \resumeItem{${experienceBullets[0] || '[Bullet 1]'}}
        \resumeItem{${experienceBullets[1] || '[Bullet 2]'}}
        \resumeItem{${experienceBullets[2] || '[Bullet 3]'}}
      \resumeItemListEnd
  \resumeSubHeadingListEnd

\section{PROJECTS}
    \resumeSubHeadingListStart
      \resumeProjectHeading
          {\textbf{${projectTitle}}} {${projectDate}}
          \resumeItemListStart
            \resumeItem{${projectBullet}}
          \resumeItemListEnd
    \resumeSubHeadingListEnd

\section{SKILLS}
 \begin{itemize}[leftmargin=0in, label={}]
    \small{\item{
     	extbf{${skillPairs[0].label}}{: ${skillPairs[0].value}}\vspace{2pt} \\
     	extbf{${skillPairs[1].label}}{: ${skillPairs[1].value}}
    }}
 \end{itemize}

\section{ACHIEVEMENTS}
 \begin{itemize}[leftmargin=0in, label={}]
    \small{\item{
     	extbf{${achievementPairs[0].label}}{: ${achievementPairs[0].value}}
    }}
 \end{itemize}

\end{document}`;
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
    /* ── Step 1: LLM call — ATS Resume Rewriter ── */
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
      throw new Error('Step 1 returned an empty resume.');
    }

    log('✅ Step 1 validation passed.');

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
