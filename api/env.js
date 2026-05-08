export default function handler(req, res) {
  // Safe environment check — DO NOT return secret values. Only booleans.
  const groq = !!process.env.GROQ_API_KEY;
  const gemini = !!process.env.GEMINI_API_KEY;
  const vercel = process.env.VERCEL === '1' || process.env.VERCEL === 'true';

  return res.json({
    groqConfigured: groq,
    geminiConfigured: gemini,
    runningOnVercel: vercel,
  });
}
