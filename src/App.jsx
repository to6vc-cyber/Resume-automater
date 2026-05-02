import { useState, useEffect, useRef } from 'react'
import heroAsset from './assets/hero.png'

const CheckIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M16.2 6.2 8.5 13.9 4.8 10.2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const FileIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M5 2.8h6.2L15 6.6v10.6H5V2.8Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="M11.2 2.8v4h3.9M7.4 10.1h5.2M7.4 13h5.2" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const SparkIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M10.7 2.9 12 7.6l4.5 1.5-4.5 1.5-1.3 4.5-1.4-4.5-4.4-1.5 4.4-1.5 1.4-4.7Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" />
    <path d="m4.8 13.2.5 1.7 1.7.6-1.7.6-.5 1.7-.6-1.7-1.7-.6 1.7-.6.6-1.7Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
  </svg>
)

const CodeIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="m7.5 6-3.8 4 3.8 4M12.5 6l3.8 4-3.8 4M11 4.5 9 15.5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const DownloadIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M10 3.3v8.2m0 0L6.9 8.4m3.1 3.1 3.1-3.1M4.2 15.2v1.1c0 .7.6 1.2 1.2 1.2h9.2c.7 0 1.2-.6 1.2-1.2v-1.1" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ExternalIcon = ({ size = 16 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M8 5H4.8v10.2h10.2V12M11.5 4.8h3.7v3.7M15.2 4.8 9.3 10.7" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const ArrowIcon = ({ size = 18 }) => (
  <svg width={size} height={size} viewBox="0 0 20 20" fill="none" aria-hidden="true">
    <path d="M4 10h11.5m0 0-4.1-4.1m4.1 4.1-4.1 4.1" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
  </svg>
)

const STATUS_STEPS = [
  { label: 'Analyzing target role', Icon: FileIcon },
  { label: 'Rewriting resume content', Icon: SparkIcon },
  { label: 'Building LaTeX document', Icon: CodeIcon },
  { label: 'Compiling polished PDF', Icon: DownloadIcon },
  { label: 'Ready to download', Icon: CheckIcon },
]

const WORKFLOW = [
  {
    title: 'Match',
    desc: 'Finds the role-specific language and skills that matter.',
  },
  {
    title: 'Rewrite',
    desc: 'Turns your experience into sharper, ATS-friendly bullets.',
  },
  {
    title: 'Package',
    desc: 'Creates a finished PDF through your Overleaf pipeline.',
  },
]

export default function App() {
  const [jobDesc, setJobDesc] = useState('')
  const [resume, setResume] = useState('')
  const [isLoading, setIsLoading] = useState(false)
  const [currentStep, setCurrentStep] = useState(-1)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)
  const formRef = useRef(null)

  const jobCount = jobDesc.trim().length
  const resumeCount = resume.trim().length
  const isValid = jobCount > 0 && resumeCount > 0

  useEffect(() => {
    if (!isLoading) return
    const timings = [3000, 8000, 18000, 28000]
    const timers = timings.map((delay, idx) =>
      setTimeout(() => setCurrentStep(idx + 1), delay)
    )
    return () => timers.forEach(clearTimeout)
  }, [isLoading])

  const scrollToForm = () => {
    formRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }

  const parseApiResponse = async (res) => {
    const body = await res.text()

    if (!body.trim()) {
      throw new Error(
        res.status === 502
          ? 'The backend is not reachable. Start it with npm run server, then try again.'
          : res.ok
          ? 'The server returned an empty response. Please try again.'
          : `The server returned an empty error response (${res.status}). Make sure the backend is running.`
      )
    }

    try {
      return JSON.parse(body)
    } catch {
      throw new Error(
        res.ok
          ? 'The server returned a response the app could not read.'
          : `The server returned ${res.status}: ${body.slice(0, 160)}`
      )
    }
  }

  const handleGenerate = async () => {
    if (!isValid || isLoading) return
    setCurrentStep(0)
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
      const data = await parseApiResponse(res)

      if (res.ok && data.status === 'success') {
        setCurrentStep(4)
        setTimeout(() => setResult(data), 500)
      } else {
        setError(data.message || `Request failed with status ${res.status}.`)
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
    <div className="app-shell">
      <nav className="topbar">
        <div className="brand-lockup">
          <div className="brand-mark">A</div>
          <div>
            <p className="brand-title">ATS Resume Tailor</p>
            <p className="brand-subtitle">Resume generator</p>
          </div>
        </div>
        <button type="button" onClick={scrollToForm} className="ghost-button">
          Open generator
          <ArrowIcon size={16} />
        </button>
      </nav>

      <main>
        <section className="workspace-hero" ref={formRef}>
          <div className="hero-copy reveal">
            <div className="signal-pill">
              <span />
              AI resume pipeline
            </div>
            <h1>Build a cleaner, sharper resume for the exact role.</h1>
            <p className="hero-lede">
              Drop in the job description and your current resume. The app rewrites the content,
              formats it in LaTeX, and returns a ready-to-send PDF.
            </p>

            <div className="hero-metrics" aria-label="App highlights">
              <div>
                <strong>ATS</strong>
                <span>Keyword aligned</span>
              </div>
              <div>
                <strong>PDF</strong>
                <span>Overleaf compiled</span>
              </div>
              <div>
                <strong>Fast</strong>
                <span>Single workflow</span>
              </div>
            </div>

            <div className="visual-stack" aria-hidden="true">
              <img src={heroAsset} alt="" />
              <div className="document-preview">
                <div />
                <span />
                <span />
                <span />
                <span />
              </div>
            </div>
          </div>

          <div className="generator-panel reveal reveal-delay">
            <div className="panel-header">
              <div>
                <p className="eyebrow">Generator</p>
                <h2>Tailor your resume</h2>
              </div>
              <div className="panel-status">
                <span className={isValid ? 'status-dot ready' : 'status-dot'} />
                {isValid ? 'Ready' : 'Waiting'}
              </div>
            </div>

            <div className="input-grid">
              <label className="field-block" htmlFor="job-desc">
                <span>
                  Job description
                  <small>{jobCount.toLocaleString()} chars</small>
                </span>
                <textarea
                  id="job-desc"
                  value={jobDesc}
                  onChange={(e) => setJobDesc(e.target.value)}
                  placeholder="Paste the job description here..."
                  disabled={isLoading}
                />
              </label>

              <label className="field-block" htmlFor="current-resume">
                <span>
                  Current resume
                  <small>{resumeCount.toLocaleString()} chars</small>
                </span>
                <textarea
                  id="current-resume"
                  value={resume}
                  onChange={(e) => setResume(e.target.value)}
                  placeholder="Paste your current resume text here..."
                  disabled={isLoading}
                />
              </label>
            </div>

            <div className="action-row">
              <button
                id="generate-btn"
                type="button"
                onClick={handleGenerate}
                disabled={!isValid || isLoading}
                className="primary-button"
              >
                {isLoading ? <span className="loader" /> : <SparkIcon size={18} />}
                {isLoading ? 'Generating resume' : 'Generate ATS resume'}
              </button>
              <p>{isValid ? 'Inputs look good.' : 'Both fields are required.'}</p>
            </div>

            {isLoading && currentStep >= 0 && (
              <div className="progress-card">
                <div className="progress-bar">
                  <span style={{ width: `${Math.min((currentStep + 1) * 20, 100)}%` }} />
                </div>
                <div className="status-list">
                  {STATUS_STEPS.map(({ label, Icon }, idx) => {
                    const isDone = idx < currentStep || (idx === 4 && currentStep === 4)
                    const isActive = idx === currentStep && !isDone
                    return (
                      <div
                        key={label}
                        className={`status-item ${isDone ? 'done' : ''} ${isActive ? 'active' : ''}`}
                      >
                        <div className="status-icon">
                          {isDone ? <CheckIcon size={16} /> : <Icon size={16} />}
                        </div>
                        <span>{label}</span>
                      </div>
                    )
                  })}
                </div>
              </div>
            )}

            {result && (
              <div className="result-card success-card">
                <div className="result-icon">
                  <CheckIcon size={24} />
                </div>
                <div>
                  <h3>Your tailored resume is ready</h3>
                  <p>Download the finished PDF or open the Overleaf project.</p>
                </div>
                <div className="result-actions">
                  <button id="download-pdf-btn" type="button" onClick={handleDownload} className="primary-button compact">
                    <DownloadIcon size={17} />
                    Download PDF
                  </button>
                  <a id="overleaf-link" href={result.projectUrl} target="_blank" rel="noopener noreferrer" className="secondary-button">
                    Open Overleaf
                    <ExternalIcon size={15} />
                  </a>
                </div>
              </div>
            )}

            {error && (
              <div className="result-card error-card">
                <div className="result-icon">!</div>
                <div>
                  <h3>Something went wrong</h3>
                  <p>{error}</p>
                </div>
                <button
                  type="button"
                  onClick={() => {
                    setError(null)
                    setResult(null)
                    setCurrentStep(-1)
                  }}
                  className="secondary-button"
                >
                  Try again
                </button>
              </div>
            )}
          </div>
        </section>

        <section className="workflow-section" aria-label="Workflow">
          {WORKFLOW.map((item, index) => (
            <article key={item.title} className="workflow-card">
              <span>{String(index + 1).padStart(2, '0')}</span>
              <h3>{item.title}</h3>
              <p>{item.desc}</p>
            </article>
          ))}
        </section>
      </main>
    </div>
  )
}
