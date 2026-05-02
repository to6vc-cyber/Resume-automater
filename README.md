# ATS Resume Tailor

**Beat the ATS. Land the interview.**

A full-stack web application that takes a Job Description and your Current Resume, uses Groq AI to rewrite it as an ATS-optimized resume, converts it to LaTeX, and compiles it into a beautiful PDF via Overleaf — all in under a minute.

## Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React + Tailwind CSS v4 (Vite) |
| Backend | Node.js / Express |
| AI Model | Groq (`llama-3.3-70b-versatile`) |
| PDF Rendering | Overleaf (LaTeX → PDF via authenticated HTTP) |

## Prerequisites

- **Node.js** v18+
- **Groq API Key** — get one at [console.groq.com](https://console.groq.com)
- **Overleaf Account** — you need session cookies from an authenticated Overleaf session

## Setup

### 1. Install dependencies

```bash
npm install
```

### 2. Configure environment variables

Copy the example file and fill in your keys:

```bash
cp .env.example .env
```

Edit `.env`:

```env
GROQ_API_KEY=your-groq-api-key-here
OVERLEAF_SESSION_COOKIE=your-overleaf-session-cookie
OVERLEAF_GCLB_TOKEN=your-gclb-token
```

#### How to get Overleaf cookies:

1. Log in to [overleaf.com](https://www.overleaf.com)
2. Open browser DevTools → Application → Cookies
3. Copy the value of `overleaf_session2` → paste as `OVERLEAF_SESSION_COOKIE`
4. Copy the value of `GCLB` → paste as `OVERLEAF_GCLB_TOKEN`

### 3. Run the app

Open **two terminals**:

```bash
# Terminal 1: Frontend (Vite dev server)
npm run dev

# Terminal 2: Backend (Express API)
npm run server
```

The frontend runs at `http://localhost:5173` and proxies `/api` calls to the backend on port `3001`.

## How It Works

1. **Paste** your current resume and the target job description
2. **Groq** rewrites your resume with ATS-optimized keywords and structure
3. **Groq** converts the optimized resume into LaTeX using a professional template
4. **Overleaf** compiles the LaTeX into a polished PDF
5. **Download** your tailored resume or open the project in Overleaf

## Project Structure

```
├── index.html          # Entry HTML with SEO meta tags
├── vite.config.js      # Vite + Tailwind CSS + API proxy config
├── package.json
├── .env.example        # Environment variable template
├── public/
│   └── favicon.svg     # Branded favicon
├── src/
│   ├── main.jsx        # React entry point
│   ├── index.css       # Design system (Tailwind v4 + custom CSS)
│   └── App.jsx         # Landing page component
└── server/
    └── index.js        # Express API (7-step pipeline)
```

## Privacy

🔒 Your resume and job description are processed in-memory and **never stored**.
