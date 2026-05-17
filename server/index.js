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
      margins: { top: 45.35, bottom: 45.35, left: 52.44, right: 52.44 },
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
        align: 'justify',
        lineGap: 5.8,
        paragraphGap: 5,
        wordSpacing: 0.2,
      };

      const writeBulletItem = (item, xOffset = 12) => {
        const startY = doc.y;
        doc.circle(doc.page.margins.left + 4, startY + 4.5, 1.2).fill('#000000');
        doc.font('Helvetica').fontSize(9.2).fillColor('#000000').text(cleanItem(item), {
          width: contentWidth - 16,
          indent: xOffset,
          lineGap: 5.8,
          paragraphGap: 3,
          wordSpacing: 0.2,
          align: 'justify',
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
        doc.moveDown(0.65);
        doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#1A3C5E').text(heading.toUpperCase(), {
          width: contentWidth,
          letterSpacing: 0.75,
        });
        doc.moveDown(0.15);
        doc.strokeColor('#1A3C5E').lineWidth(0.55)
           .moveTo(doc.page.margins.left, doc.y)
           .lineTo(doc.page.width - doc.page.margins.right, doc.y)
           .stroke();
        doc.moveDown(0.3);
      };

      const writeParagraph = (text) => {
        const value = cleanItem(text);
        if (!value) return;
        doc.font('Helvetica').fontSize(9.2).fillColor('#000000').text(value, {
          ...bodyTextOptions,
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
            
            doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#111111').text(roleOrTitle || organization || item, {
              width: contentWidth - 120,
              lineGap: 1,
            });
            
            const afterTitleY = doc.y;

            if (date) {
              doc.y = startY;
              doc.font('Helvetica-Oblique').fontSize(9.2).fillColor('#666666').text(date, {
                width: contentWidth,
                align: 'right',
                wordSpacing: 0.15,
              });
              doc.y = Math.max(afterTitleY, doc.y);
            } else {
              doc.moveDown(0.1);
            }

            if (organization) {
              doc.font('Helvetica-Oblique').fontSize(9.2).fillColor('#666666').text(organization, {
                width: contentWidth,
                lineGap: 1,
              });
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
            doc.font('Helvetica-Bold').fontSize(9.2).fillColor('#111111').text(`${label}: `, {
              continued: true,
            });
            doc.font('Helvetica').fontSize(9.2).fillColor('#111111').text(value, {
              ...bodyTextOptions,
            });
          } else {
            doc.font('Helvetica').fontSize(9.2).fillColor('#111111').text(item, {
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
        doc.font('Helvetica').fontSize(9.2).fillColor('#555555').text(contact.map((part) => cleanItem(part)).filter(Boolean).join('  |  '), {
          width: contentWidth,
          align: 'center',
          wordSpacing: 0.15,
          lineGap: 0,
        });
      }

      if (sections.SUMMARY.length) {
        writeSectionHeading('Summary');
        writeParagraph(sections.SUMMARY.join(' '));
      }

      if (sections.SKILLS.length) {
        writeSectionHeading('Skills');
        writeSkills(sections.SKILLS);
      }

      if (sections.EXPERIENCE.length) {
        writeSectionHeading('Experience');
        writeExperience(sections.EXPERIENCE);
      }

      if (sections.EDUCATION.length) {
        writeSectionHeading('Education');
        writeEducation(sections.EDUCATION);
      }

      if (sections.PROJECTS.length) {
        writeSectionHeading('Projects');
        writeExperience(sections.PROJECTS);
      }

      if (sections.ACHIEVEMENTS.length) {
        writeSectionHeading('Achievements');
        writeBullets(sections.ACHIEVEMENTS);
      }

      if (sections.CERTIFICATIONS.length) {
        writeSectionHeading('Certifications');
        writeSkills(sections.CERTIFICATIONS);
      }

      if (sections.TOOLS.length) {
        writeSectionHeading('Tools');
        writeSkills(sections.TOOLS);
      }

      if (sections.LANGUAGES.length) {
        writeSectionHeading('Languages');
        writeSkills(sections.LANGUAGES);
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
    .filter((part) => !/^address\s*:/i.test(part))
    .filter((part) => !/\b(not available|n\/a|none|null)\b/i.test(part));
};

const isPlaceholderLine = (value = '') => /^(?:[-*]\s*)?(?:none|not available|n\/a|null|nil|no\s+.+\s+mentioned\.?)$/i.test(stripMarkdown(value));

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
    ['languages', 'LANGUAGES'],
    ['language', 'LANGUAGES'],
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
    LANGUAGES: [],
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

    if (/^(professional summary|summary of qualifications|career summary|education|academic background|work experience|professional experience|career experience|employment history|work history|skills|technical skills|core competencies|key skills|technical expertise|projects|selected projects|key projects|achievements|certifications|certificates|awards|honors|additional information|tools\s*&\s*platforms|tools and platforms|tools|platforms|languages|language)\b/i.test(normalizedHeading)) {
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
      if (isPlaceholderLine(line)) continue;
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

const toTitleCase = (value = '') => stripMarkdown(value)
  .replace(/[_/-]+/g, ' ')
  .replace(/[^a-zA-Z0-9+#. ]+/g, ' ')
  .split(/\s+/)
  .filter(Boolean)
  .map((word) => {
    const lower = word.toLowerCase();
    if (['seo', 'sem', 'ppc', 'crm', 'saas', 'd2c', 'b2b', 'b2c', 'fmcg'].includes(lower)) return lower.toUpperCase();
    if (lower === 'ecommerce' || lower === 'e-commerce') return 'Ecommerce';
    return lower.charAt(0).toUpperCase() + lower.slice(1);
  })
  .join(' ');

const normalizeKeyword = (value = '') => toTitleCase(value)
  .replace(/\bE Commerce\b/g, 'Ecommerce')
  .replace(/\bGoogle Analytics\b/i, 'Google Analytics')
  .replace(/\bGoogle Ads\b/i, 'Google Ads')
  .replace(/\bMeta Ads\b/i, 'Meta Ads')
  .replace(/\bFacebook Ads\b/i, 'Facebook Ads')
  .trim();

const unique = (items = []) => [...new Set(items.map((item) => String(item || '').trim()).filter(Boolean))];

const detectKnownKeywords = (text = '') => {
  const keywordChecks = [
    'Performance Marketing', 'Digital Marketing', 'Growth Marketing', 'Social Media',
    'Content Strategy', 'Content Marketing', 'Meta Ads', 'Facebook Ads', 'Instagram Ads',
    'Google Ads', 'Google Analytics', 'SEO', 'SEM', 'PPC', 'Shopify', 'E-commerce',
    'Ecommerce', 'D2C', 'SaaS', 'FMCG', 'Lead Generation', 'Campaign Optimisation',
    'Campaign Optimization', 'Campaign Management', 'Social Media Management',
    'Email Marketing', 'CRM', 'Copywriting', 'Analytics', 'Conversion Optimization',
  ];
  const lower = String(text).toLowerCase();
  return unique(keywordChecks
    .filter((keyword) => lower.includes(keyword.toLowerCase()))
    .map(normalizeKeyword));
};

const inferRoleTitle = (jobDescription = '') => {
  const lines = String(jobDescription)
    .replace(/\r\n/g, '\n')
    .split('\n')
    .map((line) => stripMarkdown(line).trim())
    .filter(Boolean);
  const patterns = [
    /\b(?:job title|role|position|opening|hiring)\s*(?:for|:|-)?\s*([A-Za-z0-9 &/+.-]{4,80})/i,
    /\b([A-Za-z0-9 &/+.-]{4,72}\b(?:Intern|Executive|Associate|Specialist|Analyst|Manager|Senior|Lead|Director|Coordinator))\b/i,
  ];

  for (const line of lines.slice(0, 10)) {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        const role = match[1].split(/[.;|]/)[0].replace(/\bresponsibilities\b.*$/i, '').trim();
        return normalizeKeyword(role).split(/\s+/).slice(0, 5).join(' ');
      }
    }
  }

  const fallback = detectKnownKeywords(jobDescription).find((keyword) => /Marketing|Media|Content|Growth/.test(keyword));
  return fallback ? `${fallback} Role` : 'Target Role';
};

const parseJobDescription = (jobDescription = '') => {
  const knownKeywords = detectKnownKeywords(jobDescription);
  const domains = unique(knownKeywords.filter((keyword) => ['D2C', 'SaaS', 'FMCG', 'Ecommerce', 'E-commerce'].includes(keyword)));
  const hardSkills = unique(knownKeywords.filter((keyword) => !domains.includes(keyword)));
  const seniorityMatch = String(jobDescription).match(/\b(Intern|Executive|Associate|Specialist|Analyst|Manager|Senior|Lead|Director|Coordinator)\b/i);
  const responsibilities = unique(knownKeywords.filter((keyword) => /Lead Generation|Campaign|Social Media|Content|Marketing|Analytics|CRM/.test(keyword))).slice(0, 6);

  return {
    roleTitle: inferRoleTitle(jobDescription),
    hardSkills: hardSkills.length ? hardSkills : extractFallbackKeywords(jobDescription, 8).map(normalizeKeyword),
    industryDomain: domains,
    responsibilities,
    seniority: seniorityMatch ? normalizeKeyword(seniorityMatch[1]) : '',
  };
};

const getCandidateNamePrefix = (markdownResume = '', currentResume = '') => {
  const parsed = parseResumeMarkdown(markdownResume || currentResume || '');
  const parts = stripMarkdown(parsed.name || 'FirstName LastName')
    .replace(/[^a-zA-Z ]+/g, ' ')
    .split(/\s+/)
    .filter(Boolean);
  const firstName = parts[0] || 'FirstName';
  const lastName = parts.length > 1 ? parts[parts.length - 1] : 'LastName';
  return `${toTitleCase(firstName).replace(/\s+/g, '')}_${toTitleCase(lastName).replace(/\s+/g, '')}`;
};

const buildOutputFilename = (jobDescription = '', markdownResume = '', currentResume = '') => {
  const jd = parseJobDescription(jobDescription);
  const prefix = getCandidateNamePrefix(markdownResume, currentResume);
  const roleWords = normalizeKeyword(jd.roleTitle || 'Target Role').split(/\s+/).filter(Boolean);
  const extraKeywordWords = unique([
    ...jd.industryDomain,
    ...jd.hardSkills,
    jd.seniority,
  ]).flatMap((keyword) => normalizeKeyword(keyword).split(/\s+/).slice(0, 2));

  const filenameWords = [];
  for (const word of [...roleWords, ...extraKeywordWords]) {
    const cleaned = word.replace(/[^A-Za-z0-9]/g, '');
    if (!cleaned || filenameWords.includes(cleaned)) continue;
    filenameWords.push(cleaned);
    if (filenameWords.length >= 6) break;
  }

  return `${prefix}_${filenameWords.join('_') || 'Target_Role'}.pdf`;
};

const buildTailoringReport = (jobDescription = '', markdownResume = '', currentResume = '') => {
  const jd = parseJobDescription(jobDescription);
  const resumeText = `${markdownResume}\n${currentResume}`.toLowerCase();
  const matchedKeywords = unique([
    jd.roleTitle,
    jd.seniority,
    ...jd.hardSkills,
    ...jd.industryDomain,
    ...jd.responsibilities,
  ]).filter((keyword) => {
    const normalized = keyword.toLowerCase();
    return normalized && resumeText.includes(normalized);
  });

  return {
    jdAnalysis: jd,
    filename: buildOutputFilename(jobDescription, markdownResume, currentResume),
    filenameKeywords: unique([jd.roleTitle, ...jd.industryDomain, ...jd.hardSkills, jd.seniority]).slice(0, 6),
    tailored: {
      summaryRewrite: 'Summary rewritten into 3-4 role-aligned ATS sentences using JD language and existing resume facts.',
      skillReordering: 'Skills ordered with the most JD-relevant categories first.',
      bulletOptimization: 'Experience bullets reordered or lightly rephrased to prioritize JD-relevant outcomes without inventing metrics.',
    },
    matchedKeywords: matchedKeywords.slice(0, 14),
  };
};

const normalizeResumeMarkdown = (markdownResume = '') => {
  const parsed = parseResumeMarkdown(markdownResume);
  const lines = [parsed.name || 'Tailored Resume'];
  if (parsed.contact.length) lines.push(parsed.contact.join(' | '));

  const appendSection = (heading, sectionLines, bullet = true) => {
    const cleaned = sectionLines.filter((line) => !isPlaceholderLine(line));
    if (!cleaned.length) return;
    lines.push('', heading);
    lines.push(...cleaned.map((line) => (bullet && !/^[-*]/.test(line) ? `- ${line}` : line)));
  };

  appendSection('Summary', parsed.sections.SUMMARY, false);
  appendSection('Skills', parsed.sections.SKILLS);
  appendSection('Experience', parsed.sections.EXPERIENCE);
  appendSection('Education', parsed.sections.EDUCATION, false);
  appendSection('Projects', parsed.sections.PROJECTS);
  appendSection('Achievements', parsed.sections.ACHIEVEMENTS);
  appendSection('Certifications', parsed.sections.CERTIFICATIONS);
  appendSection('Tools', parsed.sections.TOOLS);
  appendSection('Languages', parsed.sections.LANGUAGES);

  return lines
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
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

const buildOfflineResumeMarkdown = (jobDescription, currentResume) => {
  const parsed = parseResumeMarkdown(currentResume);
  const jd = parseJobDescription(jobDescription);
  const resumeSnippets = collectResumeSnippets(currentResume, 4);

  const contactLine = parsed.contact.length
    ? parsed.contact.join(' | ')
    : 'Phone | Email | LinkedIn | GitHub';

  const summary = [
    `${parsed.name || 'Candidate'} is aligned to ${jd.roleTitle}.`,
    jd.hardSkills.length ? `Relevant JD keywords include ${jd.hardSkills.slice(0, 5).join(', ')}.` : '',
    resumeSnippets[0] ? `Resume evidence: ${resumeSnippets[0]}` : '',
  ].filter(Boolean).join(' ');

  const sectionLines = (key) => parsed.sections[key].map((line) => `- ${line}`);

  return [
    parsed.name || 'Tailored Resume',
    contactLine,
    '',
    'Summary',
    summary,
    '',
    'Skills',
    ...sectionLines('SKILLS'),
    '',
    'Experience',
    ...sectionLines('EXPERIENCE'),
    '',
    'Education',
    ...parsed.sections.EDUCATION,
    '',
    'Projects',
    ...sectionLines('PROJECTS'),
    '',
    'Achievements',
    ...sectionLines('ACHIEVEMENTS'),
    '',
    'Certifications',
    ...sectionLines('CERTIFICATIONS'),
    '',
    'Tools',
    ...sectionLines('TOOLS'),
    '',
    'Languages',
    ...sectionLines('LANGUAGES'),
  ].filter((line, index, arr) => line || arr[index - 1]).join('\n');
};

const buildLatexResume = (markdownResume) => {
  const { name, contact, sections } = parseResumeMarkdown(markdownResume);
  const sectionOrder = [
    ['Summary', sections.SUMMARY],
    ['Skills', sections.SKILLS],
    ['Experience', sections.EXPERIENCE],
    ['Education', sections.EDUCATION],
    ['Projects', sections.PROJECTS],
    ['Achievements', sections.ACHIEVEMENTS],
    ['Certifications', sections.CERTIFICATIONS],
    ['Tools', sections.TOOLS],
    ['Languages', sections.LANGUAGES],
  ];
  const renderLines = (lines = []) => lines
    .filter(Boolean)
    .map((line) => {
      const cleaned = escapeLatex(line);
      return /^[-*]/.test(line) ? `\\item ${cleaned.replace(/^[-*]\s*/, '')}` : `\\item ${cleaned}`;
    })
    .join('\n');
  const renderSection = ([heading, lines]) => {
    if (!lines.length) return '';
    return `\\section*{${escapeLatex(heading)}}\n\\begin{itemize}[leftmargin=16pt]\n${renderLines(lines)}\n\\end{itemize}`;
  };

  return `\\documentclass[a4paper,10pt]{article}
\\usepackage[margin=1.85cm,top=1.60cm,bottom=1.60cm]{geometry}
\\usepackage{enumitem}
\\usepackage{xcolor}
\\usepackage[T1]{fontenc}
\\usepackage{helvet}
\\renewcommand{\\familydefault}{\\sfdefault}
\\pagestyle{empty}
\\definecolor{deepnavy}{HTML}{1A3C5E}
\\setlength{\\parindent}{0pt}
\\setlist[itemize]{noitemsep,topsep=2pt,leftmargin=16pt}
\\newcommand{\\ressection}[1]{\\vspace{6pt}{\\fontsize{9.5}{11}\\selectfont\\textbf{\\textcolor{deepnavy}{#1}}}\\par\\vspace{2pt}\\textcolor{deepnavy}{\\hrule}\\vspace{4pt}}
\\begin{document}
\\begin{center}
{\\fontsize{22}{26}\\selectfont\\textbf{${escapeLatex(name || 'Full Name')}}}\\\\
\\vspace{3pt}
{\\fontsize{9.2}{15}\\selectfont ${contact.map(escapeLatex).join(' | ')}}
\\end{center}
${sectionOrder.map(renderSection).filter(Boolean).join('\n\n').replace(/\\section\*\{([^}]+)\}/g, '\\ressection{$1}')}
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
    /* ── Step 1: LLM call — ATS Resume Rewriter ── */
    log('📝 Step 1: Calling LLM for ATS resume rewrite…');

    const jdAnalysis = parseJobDescription(jobDescription);
    const step1Prompt = `## ATS Resume Skill - Dynamic JD-Based Resume Tailoring

You are an expert resume writer and ATS optimization specialist.

Your task is to generate a tailored, ATS-optimized resume by matching fixed resume data to the job description.

1. **Job Description**
2. **Current Resume**

---

## **Inputs**

**Job Description:**
${jobDescription}

**Current Resume:**
${currentResume}

**Parsed JD Signals:**
Role Title: ${jdAnalysis.roleTitle}
Core Hard Skills: ${jdAnalysis.hardSkills.join(', ') || 'Not specified'}
Industry / Domain: ${jdAnalysis.industryDomain.join(', ') || 'Not specified'}
Key Responsibilities: ${jdAnalysis.responsibilities.join(', ') || 'Not specified'}
Seniority: ${jdAnalysis.seniority || 'Not specified'}

---

## **Core Objective**

Transform the provided resume into a targeted, keyword-optimized resume that aligns strongly with the JD while preserving factual accuracy.

The output must:
* Maximize **ATS keyword matching**
* Improve **clarity, impact, and structure**
* Present experience in concise, achievement-oriented wording
* Use only facts, tools, certifications, projects, and metrics present in the current resume

---

## **Execution Guidelines**

### Step 1: Parse the JD
Use the parsed JD signals above:
* Role Title
* Core Hard Skills
* Industry / Domain
* Key Responsibilities
* Seniority

### Step 2: Plan the Tailoring
Compare JD keywords against the candidate's real skills, experience, and projects.
* Professional Summary: rewrite 3-4 concise sentences mirroring the JD role title and language.
* Skills Order: move the most JD-relevant skill categories to the top.
* Experience Bullets: reorder or lightly rephrase existing outcomes to prioritize JD relevance.
* Skills Wording: map existing skills to JD terminology only when factually supported.

### Critical factual rules
* Never invent experience, tools, certifications, projects, or metrics.
* Do not add numbers, percentages, budgets, company names, dates, platforms, or certifications unless present in the current resume.
* Only rephrase, reorder, or optimize existing information.
* Keep all content ATS-friendly and naturally keyword aligned.
* Preserve readability for human recruiters.

---

## **Output Format (Strictly Follow)**

**[Full Name]**

**Address:** [Full Address]

**Phone No:** [Phone Number] | **Email:** [Email Address] | **LinkedIn:** [LinkedIn URL] | **GitHub:** [GitHub URL]

---

### **Summary**
[3-4 ATS-optimized, role-aligned sentences]

---

### **Skills**
* **[Most JD-Relevant Category]:** [Existing relevant skills]
* **[Next Category]:** [Existing relevant skills]

---

### **Experience**
**[Company Name] | [Location] | [Job Title]** | [Start Date] - [End Date]
* [Existing factual bullet reordered or lightly rephrased for JD relevance]
* [Existing factual bullet reordered or lightly rephrased for JD relevance]
* [Existing factual bullet reordered or lightly rephrased for JD relevance]

---

### **Education**
**[Degree]**
[College Name] | [Location] | [Start Date] - [End Date]

---

### **Projects**
**[Project Title]**
* [Existing project description rephrased for JD relevance]

---

### **Achievements**
* [Existing achievement only]

---

### **Certifications**
* [Existing certification only]

---

### **Tools**
* [Existing tools only]

---

### **Languages**
* [Existing languages only]

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
    markdownResume = normalizeResumeMarkdown(markdownResume);

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
        const report = buildTailoringReport(jobDescription, markdownResume, currentResume);
        log('✅ PDF rendering succeeded; returning PDF.');
        return res.json({
          status: 'success',
          message: '✅ Resume generated with locally rendered PDF',
          pdfBase64,
          projectUrl: null,
          pdfUrl: null,
          latexCode,
          markdownResume,
          ...report,
        });
      }
      log('⚠️ PDF renderer did not produce a PDF.');
    } catch (localErr) {
      logError('⚠️ PDF rendering attempt failed: ' + String(localErr.message || localErr));
    }

    const report = buildTailoringReport(jobDescription, markdownResume, currentResume);
    return res.json({
      status: 'success',
      pdfBase64: pdfBase64,
      projectUrl: null,
      pdfUrl: null,
      message: pdfBase64 ? '✅ Resume generated with PDF' : '⚠️ Resume generated (PDF compilation skipped or failed)',
      latexCode,
      markdownResume,
      ...report,
    });
  } catch (err) {
    logError('❌ Error:', err.message);
    log('📄 Returning error response but keeping server alive');

    const fallbackMarkdownResume = normalizeResumeMarkdown(buildOfflineResumeMarkdown(jobDescription, currentResume, err.message));
    const fallbackLatexCode = buildLatexResume(fallbackMarkdownResume);

    try {
      const fallbackPdfBase64 = await compileResumeToPDF(fallbackMarkdownResume);
      const report = buildTailoringReport(jobDescription, fallbackMarkdownResume, currentResume);
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
        ...report,
      });
    } catch (fallbackErr) {
      logError('⚠️ Fallback generation also failed: ' + String(fallbackErr.message || fallbackErr));
    }
    
    // If we at least have LaTeX, return it
    if (latexCode) {
      const report = buildTailoringReport(jobDescription, markdownResume, currentResume);
      return res.status(200).json({
        status: 'partial',
        message: `✅ Resume generated! Error during PDF compilation: ${err.message}`,
        pdfBase64: null,
        projectUrl: null,
        pdfUrl: null,
        latexCode: latexCode,
        markdownResume: markdownResume,
        ...report,
      });
    }
    
    // If we have markdown but no LaTeX, return markdown
    if (markdownResume) {
      const report = buildTailoringReport(jobDescription, markdownResume, currentResume);
      return res.status(200).json({
        status: 'partial',
        message: `✅ Resume content generated! Error building LaTeX: ${err.message}`,
        pdfBase64: null,
        projectUrl: null,
        pdfUrl: null,
        latexCode: null,
        markdownResume: markdownResume,
        ...report,
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
