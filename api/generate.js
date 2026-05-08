import app from '../server/index.js';

export default function handler(req, res) {
  // In Vercel's file-based function route (/api/generate), req.url can be '/'.
  // Normalize to the existing Express route expected by the app.
  if (req.url === '/' || req.url.startsWith('/?')) {
    req.url = `/api/generate${req.url.slice(1)}`;
  }

  return app(req, res);
}
