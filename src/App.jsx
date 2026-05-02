import { useState, useEffect, useRef } from 'react'

/* ─── Inline SVG Icons ─── */
const CheckCircle = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <circle cx="9" cy="9" r="8" fill="rgba(16, 185, 129, 0.15)" stroke="#10b981" strokeWidth="1.5"/>
    <path d="M6 9l2 2 4-4" stroke="#10b981" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const LoadingDot = () => (
  <span className="inline-block w-2 h-2 rounded-full pulse" style={{ background: '#7c3aed' }} />
)

const DownloadIcon = () => (
  <svg width="18" height="18" viewBox="0 0 18 18" fill="none">
    <path d="M9 3v8m0 0l-3-3m3 3l3-3M3 14v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const ExternalIcon = () => (
  <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
    <path d="M5 2.5H2.5v9h9V9M8 2.5h3.5V6M12 2L6.5 7.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

const ArrowRight = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M3 8h10m0 0L9 4m4 4L9 12" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
)

/* ─── Status Steps ─── */
const STATUS_STEPS = [
  { label: 'Analyzing job description…', icon: '🔍' },
  { label: 'Rewriting resume with AI…', icon: '✨' },
  { label: 'Converting to LaTeX…', icon: '📐' },
  { label: 'Compiling PDF on Overleaf…', icon: '⚙️' },
  { label: 'Done!', icon: '🎉' },
]

/* ─── How It Works Steps ─── */
const STEPS = [
  {
    num: '01',
    title: 'Paste your inputs',
    desc: 'Drop in your current resume text and the target job description.',
    icon: '📋',
  },
  {
    num: '02',
    title: 'AI rewrites & optimizes',
    desc: 'AI extracts keywords, restructures bullets, and maximizes ATS score.',
    icon: '⚡',
  },
  {
    num: '03',
    title: 'Download PDF',
    desc: 'Get a polished, LaTeX-compiled resume via Overleaf — ready to send.',
    icon: '📄',
  },
]

/* ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
   APP COMPONENT
   ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━ */
export default function App() {
  const [jobDesc, setJobDesc] = useState('')
  const [resume, setResume] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const formRef = useRef(null)

  const isValid = jobDesc.trim().length > 0 && resume.trim().length > 0

  useEffect(() => {
    if (!isLoading) return
    setCurrentStep(0)
    const timings = [0, 3000, 8000, 18000, 28000]
    const timers = timings.map((delay, idx) =>
      setTimeout(() => setCurrentStep(idx), delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [isLoading])

  const scrollToForm = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const handleGenerate = async () => {
    if (!isValid || isLoading) return
    setIsLoading(true)
    setResult(null)
    setError(null)

    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobDescription: jobDesc.trim(),
          currentResume: resume.trim(),
        }),
      })
      const data = await res.json()

      if (data.status === 'success') {
        setCurrentStep(4)
        setTimeout(() => setResult(data), 500)
      } else {
        setError(data.message || 'Something went wrong.')
      }
    } catch (err) {
      setError(err.message || 'Network error.')
    } finally {
      setIsLoading(false)
    }
  }

  const handleDownload = () => {
    if (!result?.pdfBase64) return
    const bytes = atob(result.pdfBase64)
    const arr = new Uint8Array(bytes.length)
    for (let i = 0; i < bytes.length; i++) arr[i] = bytes.charCodeAt(i)
    const blob = new Blob([arr], { type: 'application/pdf' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'tailored_resume.pdf'
    a.click()
    URL.revokeObjectURL(url)
  }

  return (
    <div className="noise-overlay min-h-screen" style={{ background: 'var(--color-bg-primary)' }}>

      {/* ═══════════════ NAVBAR ═══════════════ */}
      <nav className="fixed top-0 left-0 right-0 z-50" style={{
        background: 'rgba(5, 5, 8, 0.75)',
        backdropFilter: 'blur(20px) saturate(1.4)',
        borderBottom: '1px solid var(--color-border-subtle)',
      }}>
        <div className="max-w-6xl mx-auto px-5 sm:px-8 h-[60px] flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 rounded-[10px] flex items-center justify-center text-white text-xs font-bold"
              style={{ background: 'linear-gradient(135deg, #7c3aed, #6366f1)' }}>
              A
            </div>
            <span className="text-[15px] font-semibold tracking-tight" style={{ color: 'var(--color-text-primary)' }}>
              ATS Resume Tailor
            </span>
          </div>
          <button onClick={scrollToForm} className="btn-primary" style={{ padding: '8px 18px', fontSize: '13px', borderRadius: '10px' }}>
            <span>Generate Resume</span>
          </button>
        </div>
      </nav>

      {/* ═══════════════ HERO ═══════════════ */}
      <section className="hero-bg relative pt-[140px] pb-[100px] sm:pt-[160px] sm:pb-[120px]">
        <div className="relative z-10 max-w-3xl mx-auto px-5 sm:px-8 text-center">
          {/* Badge */}
          <div className="inline-flex items-center gap-2 px-4 py-[6px] rounded-full text-[12px] font-medium mb-8"
            style={{
              background: 'var(--color-accent-light)',
              color: '#a78bfa',
              border: '1px solid rgba(124, 58, 237, 0.15)',
            }}>
            <span className="inline-block w-[6px] h-[6px] rounded-full pulse" style={{ background: '#a78bfa' }} />
            Powered by AI
          </div>

          {/* Headline */}
          <h1 className="text-[40px] sm:text-[52px] lg:text-[60px] font-extrabold leading-[1.1] tracking-tight mb-5"
            style={{ color: 'var(--color-text-primary)' }}>
            Beat the ATS.
            <br />
            <span className="gradient-text">Land the interview.</span>
          </h1>

          {/* Subheadline */}
          <p className="text-[16px] sm:text-[18px] leading-[1.7] max-w-xl mx-auto mb-10"
            style={{ color: 'var(--color-text-secondary)' }}>
            Paste your resume and a job description. Get a perfectly tailored,
            keyword-optimized, recruiter-ready PDF in under a minute.
          </p>

          {/* CTA */}
          <button
            onClick={scrollToForm}
            className="btn-primary"
            style={{ padding: '14px 32px', fontSize: '15px', borderRadius: '14px' }}
          >
            <span>Tailor My Resume</span>
            <ArrowRight />
          </button>
        </div>
      </section>

      {/* ═══════════════ HOW IT WORKS ═══════════════ */}
      <section className="py-[80px] sm:py-[100px]">
        <div className="section-divider max-w-5xl mx-auto mb-[80px]" />
        <div className="max-w-5xl mx-auto px-5 sm:px-8">
          <div className="text-center mb-14">
            <p className="text-[12px] font-semibold uppercase tracking-[0.15em] mb-3" style={{ color: '#a78bfa' }}>
              How it works
            </p>
            <h2 className="text-[28px] sm:text-[34px] font-bold tracking-tight" style={{ color: 'var(--color-text-primary)' }}>
              Three simple steps
            </h2>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-5">
            {STEPS.map((step) => (
              <div key={step.num} className="glass-card p-7">
                <div className="flex items-center gap-3 mb-5">
                  <span className="text-[22px]">{step.icon}</span>
                  <span className="step-badge">{step.num}</span>
                </div>
                <h3 className="text-[16px] font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>
                  {step.title}
                </h3>
                <p className="text-[14px] leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                  {step.desc}
                </p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ═══════════════ GENERATOR ═══════════════ */}
      <section ref={formRef} id="generator" className="py-[80px] sm:py-[100px]">
        <div className="section-divider max-w-5xl mx-auto mb-[80px]" />
        <div className="max-w-5xl mx-auto px-5 sm:px-8">
          <div className="text-center mb-12">
            <p className="text-[12px] font-semibold uppercase tracking-[0.15em] mb-3" style={{ color: '#a78bfa' }}>
              Generator
            </p>
            <h2 className="text-[28px] sm:text-[34px] font-bold tracking-tight mb-3" style={{ color: 'var(--color-text-primary)' }}>
              Generate Your ATS Resume
            </h2>
            <p className="text-[15px]" style={{ color: 'var(--color-text-secondary)' }}>
              Paste both fields below and let AI do the heavy lifting
            </p>
          </div>

          {/* Textareas */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-5 mb-8">
            <div>
              <label htmlFor="job-desc" className="input-label">Job Description</label>
              <textarea
                id="job-desc"
                className="custom-textarea"
                value={jobDesc}
                onChange={(e) => setJobDesc(e.target.value)}
                placeholder="Paste the full job description here…"
                disabled={isLoading}
              />
            </div>
            <div>
              <label htmlFor="current-resume" className="input-label">Your Current Resume</label>
              <textarea
                id="current-resume"
                className="custom-textarea"
                value={resume}
                onChange={(e) => setResume(e.target.value)}
                placeholder="Paste your current resume text here…"
                disabled={isLoading}
              />
            </div>
          </div>

          {/* Generate Button */}
          <div className="text-center">
            <button
              id="generate-btn"
              onClick={handleGenerate}
              disabled={!isValid || isLoading}
              className="btn-primary"
              style={{ padding: '14px 40px', fontSize: '15px', borderRadius: '14px' }}
            >
              {isLoading && <div className="spinner" />}
              <span>{isLoading ? 'Generating…' : 'Generate ATS Resume'}</span>
            </button>
          </div>

          {/* Status Steps */}
          {isLoading && currentStep >= 0 && (
            <div className="mt-10 max-w-sm mx-auto space-y-2.5">
              {STATUS_STEPS.map((step, idx) => (
                idx <= currentStep && (
                  <div
                    key={idx}
                    className="status-enter flex items-center gap-3 px-4 py-3 rounded-xl text-[13px] font-medium"
                    style={{
                      background: idx < currentStep
                        ? 'var(--color-success-light)'
                        : idx === 4
                        ? 'var(--color-success-light)'
                        : 'var(--color-accent-light)',
                      color: idx < currentStep || idx === 4
                        ? 'var(--color-success)'
                        : '#a78bfa',
                      animationDelay: `${idx * 0.05}s`,
                    }}
                  >
                    {idx < currentStep || idx === 4 ? <CheckCircle /> : <LoadingDot />}
                    <span>{step.icon} {step.label}</span>
                  </div>
                )
              ))}
            </div>
          )}

          {/* ─── Success Card ─── */}
          {result && (
            <div className="result-enter mt-12 max-w-md mx-auto glass-card p-8 text-center"
              style={{ borderColor: 'rgba(16, 185, 129, 0.2)' }}>
              <div className="w-14 h-14 mx-auto mb-5 rounded-2xl flex items-center justify-center text-2xl"
                style={{ background: 'var(--color-success-light)' }}>
                ✅
              </div>
              <h3 className="text-[18px] font-semibold mb-2" style={{ color: 'var(--color-text-primary)' }}>
                Your tailored resume is ready
              </h3>
              <p className="text-[13px] mb-7" style={{ color: 'var(--color-text-secondary)' }}>
                Optimized for ATS, compiled via Overleaf, and ready to download.
              </p>
              <button
                id="download-pdf-btn"
                onClick={handleDownload}
                className="btn-primary w-full mb-4"
                style={{ padding: '12px 24px', borderRadius: '12px' }}
              >
                <DownloadIcon />
                <span>Download PDF</span>
              </button>
              <a
                id="overleaf-link"
                href={result.projectUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary w-full justify-center"
              >
                <span>Open in Overleaf</span>
                <ExternalIcon />
              </a>
            </div>
          )}

          {/* ─── Error Card ─── */}
          {error && (
            <div className="result-enter mt-12 max-w-md mx-auto glass-card p-8 text-center"
              style={{ borderColor: 'rgba(239, 68, 68, 0.2)' }}>
              <div className="w-14 h-14 mx-auto mb-5 rounded-2xl flex items-center justify-center text-2xl"
                style={{ background: 'var(--color-error-light)' }}>
                ❌
              </div>
              <h3 className="text-[18px] font-semibold mb-2" style={{ color: '#fca5a5' }}>
                Something went wrong
              </h3>
              <p className="text-[13px] mb-7 leading-relaxed" style={{ color: 'var(--color-text-secondary)' }}>
                {error}
              </p>
              <button
                onClick={() => { setError(null); setResult(null); setCurrentStep(-1); }}
                className="btn-secondary w-full justify-center"
                style={{ borderColor: 'rgba(239, 68, 68, 0.2)', color: '#fca5a5' }}
              >
                Try again
              </button>
            </div>
          )}
        </div>
      </section>

      {/* ═══════════════ FOOTER ═══════════════ */}
      <footer className="py-12">
        <div className="section-divider max-w-5xl mx-auto mb-12" />
        <div className="max-w-5xl mx-auto px-5 sm:px-8 text-center">
          <p className="text-[13px]" style={{ color: 'var(--color-text-muted)' }}>
            © {new Date().getFullYear()} ATS Resume Tailor. All rights reserved.
          </p>
          <p className="text-[12px] mt-2" style={{ color: 'var(--color-text-muted)', opacity: 0.7 }}>
            🔒 Your resume and JD are processed in-memory and never stored.
          </p>
        </div>
      </footer>
    </div>
  )
}
