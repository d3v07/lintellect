import { useState, useEffect, useCallback, useRef } from 'react'
import './App.css'

/* ── Types ── */
interface AuthUser { userId: string; login: string; name: string; avatar: string }
interface GHRepo { full_name: string; name: string; owner: { login: string; avatar_url: string }; description?: string; private?: boolean }
interface GHPull { number: number; title: string; state: string; user: { login: string; avatar_url: string }; created_at: string; updated_at: string; merged_at: string | null; head: { ref: string }; base: { ref: string }; body: string; additions: number; deletions: number; changed_files: number; mergeable: boolean | null; mergeable_state: string; merged: boolean; comments: number; review_comments: number; html_url: string }
interface GHFile { sha: string; filename: string; status: string; additions: number; deletions: number; changes: number; patch?: string }
interface ReviewComment { filePath: string; lineNumber: number; endLineNumber?: number; codeSnippet: string; severity: string; category: string; message: string; suggestion?: string; confidence: number }
interface ReviewOutput { jobId: string; acceptedComments: ReviewComment[]; evidenceMetrics: { totalComments: number; acceptedCount: number; rejectedCount: number; passRate: number }; totalTokens: { input: number; output: number; total: number }; totalDurationMs: number }
interface LintReview { found: boolean; job?: any; output?: ReviewOutput; allJobs?: any[] }
interface UsageInfo { count: number; limit: number; degradedLimit: number; hardLimit: number; period: string; tier: 'free' | 'pro'; status: 'ok' | 'warning' | 'degraded' | 'blocked' }
interface Stats { totalReviews: number; completed: number; failed: number; pending: number; repos: string[]; usage?: UsageInfo }
interface Job { jobId: string; status: string; repository: string; prNumber: number; prUrl: string; createdAt: string; updatedAt: string; durationMs?: number; evidenceMetrics?: { passRate: number; acceptedCount: number } }

type View = 'landing' | 'wizard' | 'dashboard' | 'pulls' | 'pr' | 'settings' | 'setup'
type SettingsTab = 'repos' | 'llm' | 'aws' | 'github'

const AWS_REGIONS = ['us-east-1', 'us-west-2', 'eu-west-1', 'eu-central-1', 'ap-southeast-1', 'ap-northeast-1'] as const

interface LLMProvider { id: string; name: string; defaultModel?: string }

const PROVIDER_HELP: Record<string, string> = {
  openrouter: 'Get your API key at openrouter.ai/keys',
  openai: 'Get your API key at platform.openai.com/api-keys',
  anthropic: 'Get your API key at console.anthropic.com/settings/keys',
  gemini: 'Get your API key at aistudio.google.com/apikey',
  mistral: 'Get your API key at console.mistral.ai/api-keys',
  groq: 'Get your API key at console.groq.com/keys (free tier available)',
  together: 'Get your API key at api.together.xyz/settings/api-keys',
  fireworks: 'Get your API key at fireworks.ai/account/api-keys',
  ollama: 'Run Ollama locally: ollama serve (no API key needed)',
  custom: 'Enter your provider base URL and API key',
}

const PROVIDER_ICONS: Record<string, string> = {
  openrouter: 'OR', openai: 'OA', anthropic: 'An', gemini: 'Gm',
  mistral: 'Mi', groq: 'Gq', together: 'TG', fireworks: 'FW',
  ollama: 'OL', custom: '?',
}

/* ── Auth-aware fetch helper ── */
async function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(path, { ...init, credentials: 'include' })
  if (res.status === 401) {
    window.dispatchEvent(new CustomEvent('lintellect-logout'))
  }
  return res
}
type PRTab = 'files' | 'review' | 'overview'

const SEV: Record<string, { color: string; bg: string }> = {
  critical: { color: '#ef4444', bg: 'rgba(239,68,68,0.12)' },
  warning:  { color: '#f59e0b', bg: 'rgba(245,158,11,0.12)' },
  suggestion: { color: '#6366f1', bg: 'rgba(99,102,241,0.12)' },
  nitpick:  { color: '#8b5cf6', bg: 'rgba(139,92,246,0.12)' },
}

/* ── Diff parser ── */
interface DiffLine { type: 'hunk' | 'add' | 'del' | 'ctx'; text: string; oldNum?: number; newNum?: number }

function parsePatch(patch: string): DiffLine[] {
  if (!patch) return []
  const out: DiffLine[] = []
  let oldN = 0, newN = 0
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('@@')) {
      const m = raw.match(/@@ -(\d+),?\d* \+(\d+),?\d* @@/)
      if (m) { oldN = +m[1]; newN = +m[2] }
      out.push({ type: 'hunk', text: raw })
    } else if (raw.startsWith('+')) {
      out.push({ type: 'add', text: raw.slice(1), newNum: newN })
      newN++
    } else if (raw.startsWith('-')) {
      out.push({ type: 'del', text: raw.slice(1), oldNum: oldN })
      oldN++
    } else {
      out.push({ type: 'ctx', text: raw.startsWith(' ') ? raw.slice(1) : raw, oldNum: oldN, newNum: newN })
      oldN++; newN++
    }
  }
  return out
}

function timeAgo(d: string): string {
  const s = Math.floor((Date.now() - new Date(d).getTime()) / 1000)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)}m ago`
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`
  return `${Math.floor(s / 86400)}d ago`
}

/* ── Search icon SVG ── */
const SearchIcon = () => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
)

export default function App() {
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authChecked, setAuthChecked] = useState(false)

  const [view, setView] = useState<View>('landing')
  const [stats, setStats] = useState<Stats | null>(null)

  // Onboarding / Wizard state
  const [wizardStep, setWizardStep] = useState(1)
  const [llmProvider, setLlmProvider] = useState('')
  const [llmApiKey, setLlmApiKey] = useState('')
  const [llmModel, setLlmModel] = useState('')
  const [llmBaseUrl, setLlmBaseUrl] = useState('')
  const [showApiKey, setShowApiKey] = useState(false)
  const [showHelp, setShowHelp] = useState(false)
  const [verifying, setVerifying] = useState(false)
  const [verifyError, setVerifyError] = useState('')
  const [verifySuccess, setVerifySuccess] = useState(false)
  const [awsAccessKeyId, setAwsAccessKeyId] = useState('')
  const [awsSecretAccessKey, setAwsSecretAccessKey] = useState('')
  const [awsRegion, setAwsRegion] = useState('us-east-1')
  const [showAwsSecret, setShowAwsSecret] = useState(false)
  const [awsMode, setAwsMode] = useState<'choose' | 'configure' | 'skip'>('choose')
  const [providerList, setProviderList] = useState<LLMProvider[]>([])

  // App config (setup)
  const [appConfigured, setAppConfigured] = useState<boolean | null>(null)
  const [setupClientId, setSetupClientId] = useState('')
  const [setupClientSecret, setSetupClientSecret] = useState('')
  const [setupShowSecret, setSetupShowSecret] = useState(false)
  const [setupError, setSetupError] = useState('')
  const [setupSaving, setSetupSaving] = useState(false)
  const [setupShowInstructions, setSetupShowInstructions] = useState(false)

  // Settings tabs
  const [settingsTab, setSettingsTab] = useState<SettingsTab>('repos')
  const [settingsLlm, setSettingsLlm] = useState<any>(null)
  const [settingsAws, setSettingsAws] = useState<any>(null)
  const [settingsGithub, setSettingsGithub] = useState<any>(null)
  const [jobs, setJobs] = useState<Job[]>([])
  const [repos, setRepos] = useState<GHRepo[]>([])
  const [pulls, setPulls] = useState<GHPull[]>([])
  const [pullFilter, setPullFilter] = useState<'all' | 'open' | 'closed'>('all')
  const [selectedRepo, setSelectedRepo] = useState<string>('')

  // PR detail
  const [pr, setPr] = useState<GHPull | null>(null)
  const [prFiles, setPrFiles] = useState<GHFile[]>([])
  const [lintReview, setLintReview] = useState<LintReview | null>(null)
  const [prTab, setPrTab] = useState<PRTab>('files')
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set())
  const [prLoading, setPrLoading] = useState(false)

  // Settings: repo connection
  const [allRepos, setAllRepos] = useState<GHRepo[]>([])
  const [connectedRepos, setConnectedRepos] = useState<Set<string>>(new Set())
  const [connectingRepo, setConnectingRepo] = useState<string>('')

  // Search state
  const [prSearch, setPrSearch] = useState('')
  const [settingsRepoSearch, setSettingsRepoSearch] = useState('')

  // Reviewed PRs tracking
  const [reviewedPRs, setReviewedPRs] = useState<Set<number>>(new Set())

  const [loading, setLoading] = useState(true)
  const [actionLoading, setActionLoading] = useState('')
  const [toast, setToast] = useState<{ msg: string; type: 'ok' | 'err' } | null>(null)
  const toastTimer = useRef<ReturnType<typeof setTimeout>>()

  const showToast = (msg: string, type: 'ok' | 'err' = 'ok') => {
    if (toastTimer.current) clearTimeout(toastTimer.current)
    setToast({ msg, type })
    toastTimer.current = setTimeout(() => setToast(null), 3500)
  }

  const logout = useCallback(async () => {
    try { await fetch('/api/auth/logout', { method: 'POST', credentials: 'include' }) } catch {}
    setUser(null)
  }, [])

  /* ── Scroll to top on view change ── */
  const prevView = useRef(view)
  useEffect(() => {
    if (prevView.current !== view) {
      window.scrollTo({ top: 0, behavior: 'smooth' })
      prevView.current = view
    }
  }, [view])

  /* ── Keyboard shortcuts ── */
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement || e.target instanceof HTMLSelectElement) return
      if (e.key === '1') setView('dashboard')
      else if (e.key === '2') setView('pulls')
      else if (e.key === '3') setView('settings')
      else if (e.key === 'Escape' && view === 'pr') { setView('pulls'); setPr(null); setLintReview(null) }
    }
    window.addEventListener('keydown', handler)
    return () => window.removeEventListener('keydown', handler)
  }, [view])

  /* ── Listen for 401 events from apiFetch ── */
  useEffect(() => {
    const handler = () => { setUser(null) }
    window.addEventListener('lintellect-logout', handler)
    return () => window.removeEventListener('lintellect-logout', handler)
  }, [])

  /* ── Boot: check setup status, then auth, then onboarding ── */
  useEffect(() => {
    // Handle redirect from /api/auth/github when not configured
    const params = new URLSearchParams(window.location.search)
    if (params.get('setup') === 'required') {
      window.history.replaceState({}, '', window.location.pathname)
    }

    fetch('/api/setup/status')
      .then(r => r.json())
      .then(async (setup) => {
        if (!setup.configured || params.get('setup') === 'required') {
          setAppConfigured(false)
          setView('setup')
          setAuthChecked(true)
          return
        }
        setAppConfigured(true)

        // Normal auth check
        const data = await fetch('/api/auth/me', { credentials: 'include' }).then(r => r.json())
        if (data.authenticated && data.user) {
          setUser(data.user)
          if (data.onboardingCompleted) {
            setView('dashboard')
          } else {
            try {
              const obRes = await apiFetch('/api/onboarding/status').then(r => r.json())
              setWizardStep(obRes.step ?? 1)
              setView('wizard')
            } catch {
              setView('wizard')
            }
          }
        } else {
          setView('landing')
        }
        setAuthChecked(true)
      })
      .catch(() => {
        // API unreachable — show setup if we can't verify config
        setAppConfigured(false)
        setView('setup')
        setAuthChecked(true)
      })
  }, [])

  /* ── Load dashboard data after auth (only for dashboard views) ── */
  useEffect(() => {
    if (!user || view === 'landing' || view === 'wizard') { setLoading(false); return }
    setLoading(true)
    Promise.all([
      apiFetch('/api/stats').then(r => r.json()),
      apiFetch('/api/jobs').then(r => r.json()),
      apiFetch('/api/github/repos').then(r => r.json()),
    ]).then(([s, j, r]) => {
      setStats(s)
      setJobs(j.jobs ?? [])
      const repoList = Array.isArray(r) ? r : []
      setRepos(repoList)
      if (repoList.length > 0 && !selectedRepo) setSelectedRepo(repoList[0].full_name)
      setLoading(false)
    }).catch(() => setLoading(false))
  }, [user, view])

  /* ── Auto-refresh dashboard every 30s ── */
  useEffect(() => {
    if (!user || view !== 'dashboard') return
    const interval = setInterval(() => {
      Promise.all([
        apiFetch('/api/stats').then(r => r.json()),
        apiFetch('/api/jobs').then(r => r.json()),
      ]).then(([s, j]) => {
        setStats(s)
        setJobs(j.jobs ?? [])
      }).catch(() => {})
    }, 30000)
    return () => clearInterval(interval)
  }, [user, view])

  /* ── Load repos for settings view ── */
  const loadSettingsRepos = useCallback(async () => {
    try {
      const [reposRes, connRes] = await Promise.all([
        apiFetch('/api/repos').then(r => r.json()),
        apiFetch('/api/repos/connected').then(r => r.json()),
      ])
      setAllRepos(Array.isArray(reposRes) ? reposRes : [])
      setConnectedRepos(new Set(connRes.connected ?? []))
    } catch {}
  }, [])

  useEffect(() => { if (view === 'settings') loadSettingsRepos() }, [view, loadSettingsRepos])

  const toggleRepoConnection = async (fullName: string, isConnected: boolean) => {
    const [o, r] = fullName.split('/')
    setConnectingRepo(fullName)
    try {
      const endpoint = isConnected ? 'disconnect' : 'connect'
      const res = await apiFetch(`/api/repos/${o}/${r}/${endpoint}`, { method: 'POST' })
      const data = await res.json()
      if (data.ok || data.webhookId) {
        setConnectedRepos(prev => {
          const next = new Set(prev)
          isConnected ? next.delete(fullName) : next.add(fullName)
          return next
        })
        showToast(isConnected ? `Disconnected ${fullName}` : `Connected ${fullName}`)
      } else {
        showToast(data.error ?? 'Failed', 'err')
      }
    } catch { showToast('Connection failed', 'err') }
    setConnectingRepo('')
  }

  /* ── Load PRs when repo or filter changes ── */
  const loadPulls = useCallback(() => {
    if (!selectedRepo) return
    const [o, r] = selectedRepo.split('/')
    apiFetch(`/api/github/${o}/${r}/pulls?state=${pullFilter}`)
      .then(r => r.json())
      .then(data => {
        const pullList = Array.isArray(data) ? data : []
        setPulls(pullList)
        // Bulk check which PRs have been reviewed
        if (pullList.length > 0) {
          const [ow, re] = selectedRepo.split('/')
          Promise.all(
            pullList.map((p: GHPull) =>
              apiFetch(`/api/review/${ow}/${re}/${p.number}`).then(r => r.json()).then(d => d.found ? p.number : null).catch(() => null)
            )
          ).then(results => {
            setReviewedPRs(new Set(results.filter((n): n is number => n !== null)))
          })
        }
      })
      .catch(() => setPulls([]))
  }, [selectedRepo, pullFilter])

  useEffect(() => { loadPulls() }, [loadPulls])

  /* ── Open PR detail ── */
  const openPR = async (prNum: number) => {
    if (!selectedRepo) return
    setPrLoading(true)
    setView('pr')
    setPrTab('files')
    setExpandedFiles(new Set())
    const [o, r] = selectedRepo.split('/')
    try {
      const [detail, files, review] = await Promise.all([
        apiFetch(`/api/github/${o}/${r}/pulls/${prNum}`).then(x => x.json()),
        apiFetch(`/api/github/${o}/${r}/pulls/${prNum}/files`).then(x => x.json()),
        apiFetch(`/api/review/${o}/${r}/${prNum}`).then(x => x.json()),
      ])
      setPr(detail)
      setPrFiles(Array.isArray(files) ? files : [])
      setLintReview(review)
      // auto-expand first 5 files
      const first5 = (Array.isArray(files) ? files : []).slice(0, 5).map((f: GHFile) => f.filename)
      setExpandedFiles(new Set(first5))
    } catch { showToast('Failed to load PR', 'err') }
    setPrLoading(false)
  }

  /* ── Actions ── */
  const approvePR = async () => {
    if (!pr || !selectedRepo) return
    setActionLoading('approve')
    try {
      const [o, r] = selectedRepo.split('/')
      await apiFetch(`/api/github/${o}/${r}/pulls/${pr.number}/approve`, { method: 'POST' })
      showToast('PR approved!')
    } catch { showToast('Failed to approve', 'err') }
    setActionLoading('')
  }

  const mergePR = async () => {
    if (!pr || !selectedRepo) return
    setActionLoading('merge')
    try {
      const [o, r] = selectedRepo.split('/')
      const res = await apiFetch(`/api/github/${o}/${r}/pulls/${pr.number}/merge`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ merge_method: 'squash' }),
      })
      const data = await res.json()
      if (data.merged) {
        showToast('PR merged successfully!')
        setPr({ ...pr, state: 'closed', merged: true })
      } else {
        showToast(data.message ?? 'Merge failed', 'err')
      }
    } catch { showToast('Merge failed', 'err') }
    setActionLoading('')
  }

  const closePR = async () => {
    if (!pr || !selectedRepo) return
    setActionLoading('close')
    try {
      const [o, r] = selectedRepo.split('/')
      await apiFetch(`/api/github/${o}/${r}/pulls/${pr.number}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state: 'closed' }),
      })
      showToast('PR closed')
      setPr({ ...pr, state: 'closed' })
    } catch { showToast('Failed to close PR', 'err') }
    setActionLoading('')
  }

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text).then(() => showToast('Copied!')).catch(() => showToast('Copy failed', 'err'))
  }

  const toggleFile = (f: string) => {
    setExpandedFiles(prev => {
      const next = new Set(prev)
      next.has(f) ? next.delete(f) : next.add(f)
      return next
    })
  }

  /* ── Filtered lists ── */
  const filteredPulls = pulls.filter(p => {
    if (!prSearch) return true
    const q = prSearch.toLowerCase()
    return p.title.toLowerCase().includes(q) || `#${p.number}`.includes(q) || p.user.login.toLowerCase().includes(q)
  })

  const filteredSettingsRepos = allRepos.filter(r => {
    if (!settingsRepoSearch) return true
    const q = settingsRepoSearch.toLowerCase()
    return r.full_name.toLowerCase().includes(q) || (r.description ?? '').toLowerCase().includes(q)
  })

  /* ── Wizard helpers ── */
  const verifyLlm = async () => {
    setVerifying(true); setVerifyError(''); setVerifySuccess(false)
    try {
      const res = await apiFetch('/api/onboarding/llm/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: llmProvider, apiKey: llmApiKey, baseUrl: llmBaseUrl || undefined, model: llmModel || undefined }),
      })
      const data = await res.json()
      if (!res.ok) { setVerifyError(data.error ?? 'Verification failed'); setVerifying(false); return }
      // Save to backend
      await apiFetch('/api/onboarding/llm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ provider: llmProvider, apiKey: llmApiKey, baseUrl: llmBaseUrl || undefined, model: llmModel || undefined }),
      })
      setVerifySuccess(true); setVerifying(false)
      setTimeout(() => { setWizardStep(2); setVerifySuccess(false) }, 1000)
    } catch (err: any) { setVerifyError(err.message ?? 'Failed'); setVerifying(false) }
  }

  const verifyAws = async () => {
    setVerifying(true); setVerifyError(''); setVerifySuccess(false)
    try {
      const res = await apiFetch('/api/onboarding/aws/verify', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey, region: awsRegion }),
      })
      const data = await res.json()
      if (!res.ok) { setVerifyError(data.error ?? 'Verification failed'); setVerifying(false); return }
      await apiFetch('/api/onboarding/aws', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey, region: awsRegion }),
      })
      setVerifySuccess(true); setVerifying(false)
      setTimeout(() => { setWizardStep(3); setVerifySuccess(false); setVerifyError('') }, 1000)
    } catch (err: any) { setVerifyError(err.message ?? 'Failed'); setVerifying(false) }
  }

  const skipAws = async () => {
    try {
      await apiFetch('/api/onboarding/aws/skip', { method: 'POST' })
      setWizardStep(3)
    } catch { showToast('Failed to skip', 'err') }
  }

  const completeOnboarding = async () => {
    try {
      await apiFetch('/api/onboarding/complete', { method: 'POST' })
      setView('dashboard')
    } catch { showToast('Failed to complete', 'err') }
  }

  /* ── Setup: save GitHub OAuth creds ── */
  const saveSetup = async () => {
    setSetupSaving(true); setSetupError('')
    try {
      const res = await fetch('/api/setup/github', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ clientId: setupClientId, clientSecret: setupClientSecret }),
      })
      const data = await res.json()
      if (!res.ok) { setSetupError(data.error ?? 'Failed to save'); setSetupSaving(false); return }
      setAppConfigured(true)
      setView('landing')
    } catch (err: any) { setSetupError(err.message ?? 'Failed to save') }
    setSetupSaving(false)
  }

  /* ── Load wizard repos (step 3) ── */
  useEffect(() => {
    if (view === 'wizard' && wizardStep === 3) loadSettingsRepos()
  }, [view, wizardStep, loadSettingsRepos])

  /* ── Load settings tab data ── */
  const loadSettingsLlm = useCallback(async () => {
    try {
      const data = await apiFetch('/api/settings/llm').then(r => r.json())
      setSettingsLlm(data)
      setProviderList(data.providers ?? [])
      if (data.provider) setLlmProvider(data.provider)
      if (data.model) setLlmModel(data.model)
      if (data.baseUrl) setLlmBaseUrl(data.baseUrl)
    } catch {}
  }, [])

  const loadSettingsAws = useCallback(async () => {
    try { setSettingsAws(await apiFetch('/api/settings/aws').then(r => r.json())) } catch {}
  }, [])

  const loadSettingsGithub = useCallback(async () => {
    try { setSettingsGithub(await apiFetch('/api/settings/github').then(r => r.json())) } catch {}
  }, [])

  useEffect(() => {
    if (view === 'settings' && settingsTab === 'llm') loadSettingsLlm()
    if (view === 'settings' && settingsTab === 'aws') loadSettingsAws()
    if (view === 'settings' && settingsTab === 'github') loadSettingsGithub()
  }, [view, settingsTab, loadSettingsLlm, loadSettingsAws, loadSettingsGithub])

  /* ── Load provider list on wizard mount ── */
  useEffect(() => {
    if (view === 'wizard' && providerList.length === 0) {
      apiFetch('/api/settings/llm').then(r => r.json()).then(d => setProviderList(d.providers ?? [])).catch(() => {})
    }
  }, [view, providerList.length])

  /* ── Auth checking screen ── */
  if (!authChecked) return (
    <div className="boot-screen">
      <div className="boot-logo">
        <span className="bl">{'<'}</span>Lintellect<span className="bl">{'>'}</span>
      </div>
      <div className="spinner" />
      <p className="boot-msg">Loading...</p>
    </div>
  )

  /* ── Setup page (first-time config) ── */
  if (view === 'setup') return (
    <div className="wizard-page">
      <div className="login-bg-grid" />
      <div className="wizard-container">
        <div className="wizard-header">
          <div className="sb-logo" style={{ padding: 0, border: 'none', marginBottom: 20 }}>
            <span className="bl">{'<'}</span>Lintellect<span className="bl">{'>'}</span>
          </div>
        </div>

        <div className="wizard-body">
          <div className="wiz-card">
            <h2 className="wiz-title">First-Time Setup</h2>
            <p className="wiz-desc">Before you can sign in with GitHub, we need your GitHub OAuth App credentials.</p>

            <button className="wiz-help-toggle" onClick={() => setSetupShowInstructions(!setupShowInstructions)}>
              {setupShowInstructions ? 'Hide instructions' : 'How to create a GitHub OAuth App'}
            </button>
            {setupShowInstructions && (
              <div className="wiz-help-text setup-instructions">
                <ol className="setup-steps">
                  <li>Go to <strong>github.com/settings/developers</strong></li>
                  <li>Click <strong>"New OAuth App"</strong></li>
                  <li>Set Homepage URL to <code>http://localhost:5180</code></li>
                  <li>Set Authorization callback URL to <code>http://localhost:5180/api/auth/callback</code></li>
                  <li>Click "Register application", then copy Client ID and generate a Client Secret</li>
                </ol>
              </div>
            )}

            <div className="wiz-fields">
              <div className="wiz-field">
                <label>Client ID</label>
                <input type="text" value={setupClientId} onChange={e => { setSetupClientId(e.target.value); setSetupError('') }} placeholder="Ov23li..." />
              </div>
              <div className="wiz-field">
                <label>Client Secret</label>
                <div className="wiz-input-wrap">
                  <input type={setupShowSecret ? 'text' : 'password'} value={setupClientSecret} onChange={e => { setSetupClientSecret(e.target.value); setSetupError('') }} placeholder="Enter your Client Secret..." />
                  <button className="wiz-toggle-vis" onClick={() => setSetupShowSecret(!setupShowSecret)}>{setupShowSecret ? 'Hide' : 'Show'}</button>
                </div>
              </div>

              {setupError && <div className="wiz-error">{setupError}</div>}

              <button className="wiz-primary-btn" onClick={saveSetup} disabled={setupSaving || !setupClientId || !setupClientSecret}>
                {setupSaving ? 'Saving...' : 'Save & Continue'}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  )

  /* ── Landing page ── */
  if (view === 'landing') return (
    <div className="login-page">
      <div className="login-bg-grid" />
      <div className="login-card landing-card">
        <div className="login-logo">
          <span className="bl">{'<'}</span>Lintellect<span className="bl">{'>'}</span>
        </div>
        <p className="login-tagline">AI-powered code review for teams that ship</p>

        <div className="landing-requirements">
          <div className="landing-req">
            <div className="landing-req-icon">
              <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
            </div>
            <div className="landing-req-title">GitHub Account</div>
            <div className="landing-req-desc">Connect repos securely via OAuth</div>
          </div>
          <div className="landing-req">
            <div className="landing-req-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            </div>
            <div className="landing-req-title">LLM API Key</div>
            <div className="landing-req-desc">Bring your own key from 10+ providers</div>
          </div>
          <div className="landing-req">
            <div className="landing-req-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/></svg>
            </div>
            <div className="landing-req-title">AWS Credentials</div>
            <div className="landing-req-desc">Optional: use your own infrastructure</div>
          </div>
        </div>

        <a href="/api/auth/github" className="login-btn">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M12 0C5.37 0 0 5.37 0 12c0 5.31 3.435 9.795 8.205 11.385.6.105.825-.255.825-.57 0-.285-.015-1.23-.015-2.235-3.015.555-3.795-.735-4.035-1.41-.135-.345-.72-1.41-1.23-1.695-.42-.225-1.02-.78-.015-.795.945-.015 1.62.87 1.845 1.23 1.08 1.815 2.805 1.305 3.495.99.105-.78.42-1.305.765-1.605-2.67-.3-5.46-1.335-5.46-5.925 0-1.305.465-2.385 1.23-3.225-.12-.3-.54-1.53.12-3.18 0 0 1.005-.315 3.3 1.23.96-.27 1.98-.405 3-.405s2.04.135 3 .405c2.295-1.56 3.3-1.23 3.3-1.23.66 1.65.24 2.88.12 3.18.765.84 1.23 1.905 1.23 3.225 0 4.605-2.805 5.625-5.475 5.925.435.375.81 1.095.81 2.22 0 1.605-.015 2.895-.015 3.3 0 .315.225.69.825.57A12.02 12.02 0 0024 12c0-6.63-5.37-12-12-12z"/></svg>
          Get Started
        </a>
        <a href="/api/auth/github" className="landing-signin">Already have an account? Sign In</a>

        <div className="login-features">
          <div className="login-feature">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="2" width="20" height="8" rx="2"/><rect x="2" y="14" width="20" height="8" rx="2"/><line x1="6" y1="6" x2="6" y2="6"/><line x1="6" y1="18" x2="6" y2="18"/></svg>
            </div>
            <div className="login-feature-title">Multi-Pass Analysis</div>
            <div className="login-feature-desc">Structural, logic, style & security passes</div>
          </div>
          <div className="login-feature">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><polyline points="9 12 11 14 15 10"/></svg>
            </div>
            <div className="login-feature-title">Evidence Gate</div>
            <div className="login-feature-desc">Every comment validated against actual diff</div>
          </div>
          <div className="login-feature">
            <div className="login-feature-icon">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
            </div>
            <div className="login-feature-title">Full PR Management</div>
            <div className="login-feature-desc">Review diffs, approve & merge from dashboard</div>
          </div>
        </div>
        <div className="login-powered">
          <span className="login-powered-label">Powered by</span>
          <span className="tech-badge">AWS</span>
          <span className="tech-badge">GitHub</span>
          <span className="tech-badge">AI</span>
        </div>
      </div>
    </div>
  )

  /* ── Wizard ── */
  if (view === 'wizard') return (
    <div className="wizard-page">
      <div className="login-bg-grid" />
      <div className="wizard-container">
        <div className="wizard-header">
          <div className="sb-logo" style={{ padding: 0, border: 'none', marginBottom: 20 }}>
            <span className="bl">{'<'}</span>Lintellect<span className="bl">{'>'}</span>
          </div>
          <div className="wizard-progress">
            {['LLM Provider', 'AWS Config', 'Connect Repos', 'Ready!'].map((label, i) => (
              <div key={i} className={`wiz-step ${wizardStep > i + 1 ? 'done' : wizardStep === i + 1 ? 'active' : ''}`}>
                <div className="wiz-step-num">{wizardStep > i + 1 ? '\u2713' : i + 1}</div>
                <div className="wiz-step-label">{label}</div>
              </div>
            ))}
          </div>
        </div>

        <div className="wizard-body">
          {/* Step 1: LLM Provider */}
          {wizardStep === 1 && (
            <div className="wiz-card">
              <h2 className="wiz-title">Choose your LLM Provider</h2>
              <p className="wiz-desc">Select an AI provider for code reviews. Bring your own API key.</p>

              <div className="provider-grid">
                {(providerList.length > 0 ? providerList : [
                  { id: 'openrouter', name: 'OpenRouter' }, { id: 'openai', name: 'OpenAI' },
                  { id: 'anthropic', name: 'Anthropic' }, { id: 'gemini', name: 'Google Gemini' },
                  { id: 'mistral', name: 'Mistral' }, { id: 'groq', name: 'Groq' },
                  { id: 'together', name: 'Together AI' }, { id: 'fireworks', name: 'Fireworks AI' },
                  { id: 'ollama', name: 'Ollama (local)' }, { id: 'custom', name: 'Custom' },
                ]).map(p => (
                  <div key={p.id} className={`provider-card ${llmProvider === p.id ? 'selected' : ''}`} onClick={() => { setLlmProvider(p.id); setLlmModel(p.defaultModel ?? ''); setVerifyError(''); setVerifySuccess(false) }}>
                    <div className="provider-icon">{PROVIDER_ICONS[p.id] ?? '?'}</div>
                    <div className="provider-name">{p.name}</div>
                  </div>
                ))}
              </div>

              {llmProvider && (
                <div className="wiz-fields">
                  {llmProvider !== 'ollama' && (
                    <div className="wiz-field">
                      <label>API Key</label>
                      <div className="wiz-input-wrap">
                        <input type={showApiKey ? 'text' : 'password'} value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="Enter your API key..." />
                        <button className="wiz-toggle-vis" onClick={() => setShowApiKey(!showApiKey)}>{showApiKey ? 'Hide' : 'Show'}</button>
                      </div>
                    </div>
                  )}
                  <div className="wiz-field">
                    <label>Model (optional)</label>
                    <input type="text" value={llmModel} onChange={e => setLlmModel(e.target.value)} placeholder={providerList.find(p => p.id === llmProvider)?.defaultModel ?? 'Default model'} />
                  </div>
                  {llmProvider === 'custom' && (
                    <div className="wiz-field">
                      <label>Base URL</label>
                      <input type="text" value={llmBaseUrl} onChange={e => setLlmBaseUrl(e.target.value)} placeholder="https://your-provider.com/v1" />
                    </div>
                  )}

                  <button className="wiz-help-toggle" onClick={() => setShowHelp(!showHelp)}>
                    {showHelp ? 'Hide instructions' : 'How to get your key'}
                  </button>
                  {showHelp && <div className="wiz-help-text">{PROVIDER_HELP[llmProvider] ?? 'Check your provider dashboard for API keys.'}</div>}

                  {verifyError && <div className="wiz-error">{verifyError}</div>}
                  {verifySuccess && <div className="wiz-success">Connected successfully!</div>}

                  <button className="wiz-primary-btn" onClick={verifyLlm} disabled={verifying || (!llmApiKey && llmProvider !== 'ollama')}>
                    {verifying ? 'Verifying...' : verifySuccess ? 'Verified!' : 'Verify & Continue'}
                  </button>
                </div>
              )}
            </div>
          )}

          {/* Step 2: AWS Configuration */}
          {wizardStep === 2 && (
            <div className="wiz-card">
              <h2 className="wiz-title">AWS Configuration</h2>
              <p className="wiz-desc">Optional: use your own AWS infrastructure for processing, or skip to use platform defaults.</p>

              {awsMode === 'choose' && (
                <div className="aws-choice">
                  <div className="aws-choice-card" onClick={() => setAwsMode('configure')}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 16V8a2 2 0 00-1-1.73l-7-4a2 2 0 00-2 0l-7 4A2 2 0 002 8v8a2 2 0 001 1.73l7 4a2 2 0 002 0l7-4A2 2 0 0022 16z"/></svg>
                    <div className="aws-choice-title">Use my AWS</div>
                    <div className="aws-choice-desc">Provide IAM credentials for your account</div>
                  </div>
                  <div className="aws-choice-card" onClick={skipAws}>
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="13 17 18 12 13 7"/><polyline points="6 17 11 12 6 7"/></svg>
                    <div className="aws-choice-title">Skip</div>
                    <div className="aws-choice-desc">Use platform defaults (can configure later)</div>
                  </div>
                </div>
              )}

              {awsMode === 'configure' && (
                <div className="wiz-fields">
                  <div className="wiz-field">
                    <label>Access Key ID</label>
                    <input type="text" value={awsAccessKeyId} onChange={e => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." />
                  </div>
                  <div className="wiz-field">
                    <label>Secret Access Key</label>
                    <div className="wiz-input-wrap">
                      <input type={showAwsSecret ? 'text' : 'password'} value={awsSecretAccessKey} onChange={e => setAwsSecretAccessKey(e.target.value)} placeholder="Enter secret key..." />
                      <button className="wiz-toggle-vis" onClick={() => setShowAwsSecret(!showAwsSecret)}>{showAwsSecret ? 'Hide' : 'Show'}</button>
                    </div>
                  </div>
                  <div className="wiz-field">
                    <label>Region</label>
                    <select value={awsRegion} onChange={e => setAwsRegion(e.target.value)}>
                      {AWS_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                    </select>
                  </div>

                  <button className="wiz-help-toggle" onClick={() => setShowHelp(!showHelp)}>
                    {showHelp ? 'Hide instructions' : 'How to create IAM credentials'}
                  </button>
                  {showHelp && <div className="wiz-help-text">Go to AWS Console &gt; IAM &gt; Users &gt; Create User &gt; Attach policies &gt; Create Access Key. Recommended: use a dedicated user with least-privilege permissions.</div>}

                  {verifyError && <div className="wiz-error">{verifyError}</div>}
                  {verifySuccess && <div className="wiz-success">AWS credentials verified!</div>}

                  <div className="wiz-btn-row">
                    <button className="wiz-secondary-btn" onClick={() => { setAwsMode('choose'); setVerifyError('') }}>Back</button>
                    <button className="wiz-primary-btn" onClick={verifyAws} disabled={verifying || !awsAccessKeyId || !awsSecretAccessKey}>
                      {verifying ? 'Verifying...' : verifySuccess ? 'Verified!' : 'Verify & Continue'}
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Step 3: Connect Repos */}
          {wizardStep === 3 && (
            <div className="wiz-card">
              <h2 className="wiz-title">Connect Repositories</h2>
              <p className="wiz-desc">Select at least one repository to enable AI code review.</p>
              <div className="wiz-repo-counter">{connectedRepos.size} of {allRepos.length} repos connected</div>

              {allRepos.length === 0 ? (
                <div className="empty-block"><div className="spinner" /><p>Loading repositories...</p></div>
              ) : (
                <>
                  <div className="search-wrap">
                    <SearchIcon />
                    <input className="search-input" placeholder="Search repositories..." value={settingsRepoSearch} onChange={e => setSettingsRepoSearch(e.target.value)} style={{ maxWidth: '100%' }} />
                  </div>
                  <div className="repo-list wiz-repo-list">
                    {filteredSettingsRepos.map(r => {
                      const isConn = connectedRepos.has(r.full_name)
                      const isLoading = connectingRepo === r.full_name
                      return (
                        <div key={r.full_name} className={`repo-card ${isConn ? 'connected' : ''}`}>
                          <div className="repo-card-left">
                            <img className="repo-avatar" src={r.owner.avatar_url} alt={r.owner.login} />
                            <div className="repo-info">
                              <div className="repo-name">{r.full_name}</div>
                              {r.description && <div className="repo-desc">{r.description}</div>}
                            </div>
                          </div>
                          <button className={`toggle-btn ${isConn ? 'on' : 'off'}`} onClick={() => toggleRepoConnection(r.full_name, isConn)} disabled={isLoading}>
                            {isLoading ? '...' : isConn ? 'Connected' : 'Connect'}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                </>
              )}

              <button className="wiz-primary-btn" onClick={() => setWizardStep(4)} disabled={connectedRepos.size === 0} style={{ marginTop: 20 }}>
                Continue
              </button>
            </div>
          )}

          {/* Step 4: Tour / Complete */}
          {wizardStep === 4 && (
            <div className="wiz-card wiz-tour">
              <div className="wiz-celebration">
                <svg viewBox="0 0 64 64" fill="none" stroke="var(--accent)" strokeWidth="2"><circle cx="32" cy="32" r="28" /><polyline points="22 32 30 40 44 24" strokeWidth="3"/></svg>
              </div>
              <h2 className="wiz-title">You're all set!</h2>
              <p className="wiz-desc">Here's a quick overview of what you can do:</p>

              <div className="tour-cards">
                <div className="tour-card">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
                  <div><strong>Dashboard</strong><br/>See review stats and activity at a glance</div>
                </div>
                <div className="tour-card">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/></svg>
                  <div><strong>Pull Requests</strong><br/>View AI-powered review comments on your PRs</div>
                </div>
                <div className="tour-card">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
                  <div><strong>Settings</strong><br/>Manage repos, update credentials, configure preferences</div>
                </div>
                <div className="tour-card">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
                  <div><strong>Line-by-Line Feedback</strong><br/>Each PR gets detailed inline code review</div>
                </div>
              </div>

              <button className="wiz-primary-btn" onClick={completeOnboarding}>Go to Dashboard</button>
            </div>
          )}
        </div>
      </div>
    </div>
  )

  /* ── Loading skeleton ── */
  if (loading) return (
    <div className="skel-dashboard">
      <div className="skel-sidebar">
        <div className="skeleton skel-sidebar-item" style={{ height: 40 }} />
        <div className="skeleton skel-sidebar-item" />
        <div className="skeleton skel-sidebar-item" />
        <div className="skeleton skel-sidebar-item" />
      </div>
      <div className="skel-main">
        <div className="skeleton skel-heading" />
        <div className="skel-stats">
          <div className="skeleton skel-stat-card" />
          <div className="skeleton skel-stat-card" />
          <div className="skeleton skel-stat-card" />
          <div className="skeleton skel-stat-card" />
        </div>
        <div className="skeleton skel-panel" />
        <div className="skeleton skel-panel" />
      </div>
    </div>
  )

  /* ── Build inline comment map for diff viewer ── */
  const commentsByFile: Record<string, ReviewComment[]> = {}
  if (lintReview?.output) {
    for (const c of lintReview.output.acceptedComments) {
      if (!commentsByFile[c.filePath]) commentsByFile[c.filePath] = []
      commentsByFile[c.filePath].push(c)
    }
  }

  return (
    <div className="layout">
      {/* ── Sidebar ── */}
      <aside className="sidebar">
        <div className="sb-logo" onClick={() => setView('dashboard')}>
          <span className="bl">{'<'}</span>L<span className="bl">{'>'}</span>
        </div>
        <nav className="sb-nav">
          <button className={`sb-btn ${view === 'dashboard' ? 'active' : ''}`} onClick={() => setView('dashboard')} title="Dashboard">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg>
            <span>Dashboard</span>
          </button>
          <button className={`sb-btn ${view === 'pulls' || view === 'pr' ? 'active' : ''}`} onClick={() => setView('pulls')} title="Pull Requests">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
            <span>Pull Requests</span>
            {stats && stats.pending > 0 && <span className="sb-badge">{stats.pending}</span>}
          </button>
          <button className={`sb-btn ${view === 'settings' ? 'active' : ''}`} onClick={() => setView('settings')} title="Settings">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            <span>Settings</span>
          </button>
        </nav>
        <div className="sb-bottom">
          <div className="sb-status">
            <span className="pulse-dot" />
            <span>Live</span>
          </div>
          <div className="sb-user">
            <img src={user.avatar} alt={user.login} />
            <span className="sb-user-name">{user.login}</span>
            <button className="sb-logout" onClick={logout} title="Sign out">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 21H5a2 2 0 01-2-2V5a2 2 0 012-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/></svg>
            </button>
          </div>
        </div>
      </aside>

      {/* ── Main content ── */}
      <main className="content">
        {toast && (
          <div className={`toast toast-${toast.type}`}>
            {toast.type === 'ok' ? (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
            ) : (
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            )}
            {toast.msg}
          </div>
        )}

        {/* ── Dashboard View ── */}
        {view === 'dashboard' && (
          <div className="page">
            <div className="page-header">
              <h1>Dashboard</h1>
              <span className="page-sub">Evidence-Validated AI Code Review</span>
            </div>

            {stats && (
              <div className="stats-row">
                <div className="scard"><div className="scard-num">{stats.totalReviews}</div><div className="scard-label">Total Reviews</div></div>
                <div className="scard sc-green"><div className="scard-num">{stats.completed}</div><div className="scard-label">Completed</div></div>
                <div className="scard sc-red"><div className="scard-num">{stats.failed}</div><div className="scard-label">Failed</div></div>
                <div className="scard sc-blue"><div className="scard-num">{stats.repos.length}</div><div className="scard-label">Repositories</div></div>
              </div>
            )}

            {stats?.usage && stats.usage.tier === 'free' && (
              <div className={`usage-panel usage-${stats.usage.status}`}>
                <div className="usage-header">
                  <span className="usage-title">Monthly Usage</span>
                  <span className="usage-count">{stats.usage.count} / {stats.usage.hardLimit} reviews</span>
                </div>
                <div className="usage-bar-track">
                  <div className="usage-bar-fill" style={{ width: `${Math.min((stats.usage.count / stats.usage.hardLimit) * 100, 100)}%` }} />
                  <div className="usage-bar-marker" style={{ left: `${(stats.usage.limit / stats.usage.hardLimit) * 100}%` }} title={`Quality limit: ${stats.usage.limit}`} />
                </div>
                <div className="usage-labels">
                  <span>{stats.usage.status === 'ok' ? 'Full quality' : stats.usage.status === 'warning' ? 'Approaching limit' : stats.usage.status === 'degraded' ? 'Degraded quality (lighter model)' : 'Limit reached'}</span>
                  <span className="usage-cta" onClick={() => setView('settings')}>Connect AWS to remove limits</span>
                </div>
              </div>
            )}

            <div className="panel">
              <h2 className="panel-title">Review Pipeline</h2>
              <div className="pipeline">
                {['Webhook', 'Parse Diff', 'Context', '4x LLM', 'Merge', 'Evidence Gate', 'Post'].map((s, i) => (
                  <div key={s} className="pipe-step">
                    <div className="pipe-node">{i + 1}</div>
                    <div className="pipe-label">{s}</div>
                    {i < 6 && <div className="pipe-arrow">&#8594;</div>}
                  </div>
                ))}
              </div>
            </div>

            <div className="panel">
              <h2 className="panel-title">Recent Activity</h2>
              {jobs.length === 0 ? (
                <div className="empty-state">
                  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                  <div className="empty-state-title">No reviews yet</div>
                  <div className="empty-state-desc">Open a pull request on a connected repository to trigger your first AI code review.</div>
                </div>
              ) : (
                <div className="activity-list">
                  {jobs.slice(0, 10).map(j => (
                    <div key={j.jobId} className="act-row" onClick={() => { setSelectedRepo(j.repository); openPR(j.prNumber) }}>
                      <div className="act-left">
                        <span className="act-repo">{j.repository}</span>
                        <span className="act-pr">PR #{j.prNumber}</span>
                      </div>
                      <div className="act-right">
                        <span className={`badge badge-${j.status}`}>{j.status}</span>
                        <span className="act-time">{timeAgo(j.createdAt)}</span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Pull Requests View ── */}
        {view === 'pulls' && (
          <div className="page">
            <div className="page-header">
              <h1>Pull Requests</h1>
              <div className="header-controls">
                <select className="repo-select" value={selectedRepo} onChange={e => setSelectedRepo(e.target.value)}>
                  {repos.map(r => <option key={r.full_name} value={r.full_name}>{r.full_name}</option>)}
                </select>
              </div>
            </div>

            <div className="filter-bar">
              {(['all', 'open', 'closed'] as const).map(f => (
                <button key={f} className={`filter-btn ${pullFilter === f ? 'active' : ''}`} onClick={() => setPullFilter(f)}>
                  {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Closed'}
                </button>
              ))}
            </div>

            <div className="search-wrap">
              <SearchIcon />
              <input className="search-input" placeholder="Search by title, #number, or author..." value={prSearch} onChange={e => setPrSearch(e.target.value)} />
            </div>

            {filteredPulls.length === 0 ? (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/><line x1="6" y1="9" x2="6" y2="21"/></svg>
                <div className="empty-state-title">No pull requests found</div>
                <div className="empty-state-desc">{prSearch ? 'Try a different search term.' : 'No PRs match the current filter.'}</div>
              </div>
            ) : (
              <div className="pr-list">
                {filteredPulls.map(p => (
                  <div key={p.number} className="pr-card" onClick={() => openPR(p.number)}>
                    <div className="pr-card-left">
                      <span className={`pr-state-icon ${p.merged_at ? 'merged' : p.state}`}>
                        {p.merged_at ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/></svg>
                        ) : p.state === 'open' ? (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="12" y1="9" x2="12" y2="15"/></svg>
                        ) : (
                          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                        )}
                      </span>
                      <div className="pr-card-info">
                        <div className="pr-card-title">
                          {p.title}
                          {reviewedPRs.has(p.number) && <span className="badge badge-reviewed">Reviewed</span>}
                        </div>
                        <div className="pr-card-meta">
                          #{p.number} by {p.user.login} &middot; {timeAgo(p.updated_at)} &middot; {p.head.ref} &#8594; {p.base.ref}
                        </div>
                      </div>
                    </div>
                    <div className="pr-card-right">
                      {p.review_comments > 0 && <span className="pr-comments">{p.review_comments} comments</span>}
                      <span className={`badge badge-${p.merged_at ? 'merged' : p.state}`}>
                        {p.merged_at ? 'merged' : p.state}
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── PR Detail View ── */}
        {view === 'pr' && (
          <div className="page">
            <button className="back-link" onClick={() => { setView('pulls'); setPr(null); setLintReview(null) }}>
              &#8592; Back to Pull Requests
            </button>

            {prLoading ? (
              <div className="skel-pr">
                <div className="skeleton skel-breadcrumb" />
                <div className="skeleton skel-pr-header" />
                <div className="skeleton skel-tab-bar" />
                <div className="skeleton skel-file-card" />
                <div className="skeleton skel-file-card" />
                <div className="skeleton skel-file-card" />
              </div>
            ) : pr ? (
              <>
                {/* PR header */}
                <div className="pr-header">
                  <div className="pr-h-top">
                    <span className={`pr-state-icon big ${pr.merged ? 'merged' : pr.state}`}>
                      {pr.merged ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M6 9v6a3 3 0 0 0 3 3h3"/></svg>
                      ) : pr.state === 'open' ? (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="6" r="3"/><circle cx="12" cy="18" r="3"/><line x1="12" y1="9" x2="12" y2="15"/></svg>
                      ) : (
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                      )}
                    </span>
                    <div style={{ flex: 1 }}>
                      <h1 className="pr-title">{pr.title} <span className="pr-num">#{pr.number}</span></h1>
                      <div className="pr-meta">
                        <span className={`badge badge-${pr.merged ? 'merged' : pr.state}`}>{pr.merged ? 'Merged' : pr.state}</span>
                        <span>{pr.user.login} wants to merge <strong>{pr.head.ref}</strong> into <strong>{pr.base.ref}</strong></span>
                        <span>&middot; {timeAgo(pr.created_at)}</span>
                      </div>
                    </div>
                    {pr.html_url && (
                      <a className="gh-link" href={pr.html_url} target="_blank" rel="noopener noreferrer">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 13v6a2 2 0 01-2 2H5a2 2 0 01-2-2V8a2 2 0 012-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>
                        View on GitHub
                      </a>
                    )}
                  </div>

                  {/* Actions */}
                  {pr.state === 'open' && !pr.merged && (
                    <div className="pr-actions">
                      <button className="act-btn act-approve" onClick={approvePR} disabled={!!actionLoading}>
                        {actionLoading === 'approve' ? 'Approving...' : 'Approve'}
                      </button>
                      <button className="act-btn act-merge" onClick={mergePR} disabled={!!actionLoading}>
                        {actionLoading === 'merge' ? 'Merging...' : 'Squash & Merge'}
                      </button>
                      <button className="act-btn act-close" onClick={closePR} disabled={!!actionLoading}>
                        {actionLoading === 'close' ? 'Closing...' : 'Close PR'}
                      </button>
                    </div>
                  )}

                  {/* Quick stats */}
                  <div className="pr-qstats">
                    <span className="qs qs-green">+{pr.additions}</span>
                    <span className="qs qs-red">-{pr.deletions}</span>
                    <span className="qs">{pr.changed_files} files</span>
                    {lintReview?.output && (
                      <span className="qs qs-accent">{lintReview.output.acceptedComments.length} issues found</span>
                    )}
                  </div>
                </div>

                {/* Tabs */}
                <div className="tab-bar">
                  <button className={`tab ${prTab === 'overview' ? 'active' : ''}`} onClick={() => setPrTab('overview')}>Overview</button>
                  <button className={`tab ${prTab === 'files' ? 'active' : ''}`} onClick={() => setPrTab('files')}>
                    Files Changed <span className="tab-count">{prFiles.length}</span>
                  </button>
                  <button className={`tab ${prTab === 'review' ? 'active' : ''}`} onClick={() => setPrTab('review')}>
                    Lintellect Review
                    {lintReview?.output && <span className="tab-count">{lintReview.output.acceptedComments.length}</span>}
                  </button>
                </div>

                {/* Tab: Overview */}
                {prTab === 'overview' && (
                  <div className="panel">
                    <h3 className="panel-title">Description</h3>
                    {pr.body ? (
                      <div className="pr-body">{pr.body}</div>
                    ) : (
                      <p className="empty-msg">No description provided.</p>
                    )}

                    {lintReview?.found && lintReview.job && (
                      <div className="lint-summary">
                        <h3 className="panel-title">Lintellect Review Summary</h3>
                        <div className="lint-sum-row">
                          <span>Status: <strong className={`badge badge-${lintReview.job.status}`}>{lintReview.job.status}</strong></span>
                          {lintReview.output && (
                            <>
                              <span>Issues: <strong>{lintReview.output.acceptedComments.length}</strong></span>
                              <span>Evidence Rate: <strong>{Math.round(lintReview.output.evidenceMetrics.passRate * 100)}%</strong></span>
                              <span>Duration: <strong>{(lintReview.output.totalDurationMs / 1000).toFixed(1)}s</strong></span>
                              <span>Tokens: <strong>{lintReview.output.totalTokens.total.toLocaleString()}</strong></span>
                            </>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Tab: Files Changed */}
                {prTab === 'files' && (
                  <div className="diff-section">
                    <div className="file-tree-bar">
                      <button className="ftb-btn" onClick={() => setExpandedFiles(new Set(prFiles.map(f => f.filename)))}>Expand All</button>
                      <button className="ftb-btn" onClick={() => setExpandedFiles(new Set())}>Collapse All</button>
                    </div>
                    {prFiles.map(file => {
                      const isOpen = expandedFiles.has(file.filename)
                      const fileComments = commentsByFile[file.filename] ?? []
                      const lines = isOpen ? parsePatch(file.patch ?? '') : []
                      return (
                        <div key={file.filename} className={`diff-file ${fileComments.length > 0 ? 'has-comments' : ''}`}>
                          <div className="diff-file-header" onClick={() => toggleFile(file.filename)}>
                            <span className="df-chevron">{isOpen ? '\u25BC' : '\u25B6'}</span>
                            <span className={`df-status df-status-${file.status}`}>{file.status[0].toUpperCase()}</span>
                            <span className="df-name">{file.filename}</span>
                            <span className="df-stats">
                              <span className="df-add">+{file.additions}</span>
                              <span className="df-del">-{file.deletions}</span>
                            </span>
                            {fileComments.length > 0 && (
                              <span className="df-issues">{fileComments.length} issue{fileComments.length > 1 ? 's' : ''}</span>
                            )}
                          </div>
                          {isOpen && (
                            <div className="diff-body">
                              {file.patch ? (
                                <table className="diff-table">
                                  <tbody>
                                    {lines.map((line, li) => {
                                      const inlineComments = fileComments.filter(c => c.lineNumber === line.newNum)
                                      return (
                                        <DiffRow key={li} line={line} comments={inlineComments} />
                                      )
                                    })}
                                  </tbody>
                                </table>
                              ) : (
                                <div className="diff-binary">Binary file or no diff available</div>
                              )}
                            </div>
                          )}
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Tab: Lintellect Review */}
                {prTab === 'review' && (
                  <div className="review-section">
                    {!lintReview?.found ? (
                      <div className="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        <div className="empty-state-title">No Lintellect review found</div>
                        <div className="empty-state-desc">Push a commit to trigger an automatic evidence-validated code review.</div>
                      </div>
                    ) : !lintReview.output ? (
                      <div className="empty-block">
                        <div className="spinner" />
                        <p>Review is {lintReview.job?.status ?? 'in progress'}...</p>
                      </div>
                    ) : (
                      <>
                        {/* Evidence Gate */}
                        <div className="evidence-panel">
                          <div className="ev-header">
                            <span className="ev-title">Evidence Gate</span>
                            <span className="ev-pct">{Math.round(lintReview.output.evidenceMetrics.passRate * 100)}%</span>
                          </div>
                          <div className="ev-bar">
                            <div className="ev-fill" style={{ width: `${lintReview.output.evidenceMetrics.passRate * 100}%` }} />
                          </div>
                          <div className="ev-detail">
                            {lintReview.output.evidenceMetrics.acceptedCount} of {lintReview.output.evidenceMetrics.totalComments} comments passed validation
                          </div>
                        </div>

                        {/* Severity breakdown */}
                        <div className="sev-bar">
                          {Object.entries(
                            lintReview.output.acceptedComments.reduce((a, c) => { a[c.severity] = (a[c.severity] ?? 0) + 1; return a }, {} as Record<string, number>)
                          ).sort(([a], [b]) => ['critical','warning','suggestion','nitpick'].indexOf(a) - ['critical','warning','suggestion','nitpick'].indexOf(b))
                          .map(([sev, count]) => (
                            <div key={sev} className="sev-chip" style={{ background: SEV[sev]?.bg, color: SEV[sev]?.color, border: `1px solid ${SEV[sev]?.color}` }}>
                              {sev}: {count}
                            </div>
                          ))}
                        </div>

                        {/* Metrics row */}
                        <div className="metrics-row">
                          <div className="metric"><span className="metric-val">{lintReview.output.acceptedComments.length}</span><span className="metric-label">Issues</span></div>
                          <div className="metric"><span className="metric-val">{(lintReview.output.totalDurationMs / 1000).toFixed(1)}s</span><span className="metric-label">Duration</span></div>
                          <div className="metric"><span className="metric-val">{lintReview.output.totalTokens.total.toLocaleString()}</span><span className="metric-label">Tokens</span></div>
                        </div>

                        {/* Comment cards */}
                        <div className="review-comments">
                          {lintReview.output.acceptedComments.map((c, i) => (
                            <div key={i} className="rc-card" style={{ borderLeftColor: SEV[c.severity]?.color ?? '#666' }}>
                              <div className="rc-top">
                                <span className="rc-sev" style={{ background: SEV[c.severity]?.color, color: '#fff' }}>{c.severity}</span>
                                <span className="rc-cat">{c.category}</span>
                                <span className="rc-loc" onClick={() => { setPrTab('files'); setExpandedFiles(prev => new Set([...prev, c.filePath])) }}>
                                  {c.filePath}:{c.lineNumber}
                                </span>
                                <span className="rc-conf">{Math.round(c.confidence * 100)}%</span>
                              </div>
                              <div className="rc-body">{c.message}</div>
                              {c.codeSnippet && (
                                <div className="rc-code-wrap">
                                  <button className="copy-btn" onClick={() => copyToClipboard(c.codeSnippet)}>Copy</button>
                                  <pre className="rc-code"><code>{c.codeSnippet}</code></pre>
                                </div>
                              )}
                              {c.suggestion && (
                                <div className="rc-suggestion">
                                  <div className="rc-sug-label">Suggestion</div>
                                  <div className="rc-sug-text">{c.suggestion}</div>
                                </div>
                              )}
                            </div>
                          ))}
                        </div>
                      </>
                    )}
                  </div>
                )}
              </>
            ) : (
              <div className="empty-state">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9"/><line x1="9" y1="9" x2="15" y2="15"/><line x1="15" y1="9" x2="9" y2="15"/></svg>
                <div className="empty-state-title">PR not found</div>
                <div className="empty-state-desc">This pull request may have been deleted or you may not have access.</div>
              </div>
            )}
          </div>
        )}
        {/* ── Settings View (Tabbed) ── */}
        {view === 'settings' && (
          <div className="page">
            <div className="page-header">
              <h1>Settings</h1>
              <span className="page-sub">Manage repos, credentials, and preferences</span>
            </div>

            <div className="trust-banner">
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" width="16" height="16"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
              Your API keys and credentials are encrypted with AES-256-GCM before storage. We never store or see your plaintext keys.
            </div>

            <div className="settings-tabs">
              <button className={`settings-tab ${settingsTab === 'repos' ? 'active' : ''}`} onClick={() => setSettingsTab('repos')}>Repositories</button>
              <button className={`settings-tab ${settingsTab === 'llm' ? 'active' : ''}`} onClick={() => setSettingsTab('llm')}>LLM Provider</button>
              <button className={`settings-tab ${settingsTab === 'aws' ? 'active' : ''}`} onClick={() => setSettingsTab('aws')}>AWS Config</button>
              <button className={`settings-tab ${settingsTab === 'github' ? 'active' : ''}`} onClick={() => setSettingsTab('github')}>GitHub OAuth</button>
            </div>

            {/* Repos tab */}
            {settingsTab === 'repos' && (
              <>
                {allRepos.length === 0 ? (
                  <div className="empty-block"><div className="spinner" /><p>Loading repositories...</p></div>
                ) : (
                  <>
                    <div className="search-wrap">
                      <SearchIcon />
                      <input className="search-input" placeholder="Search repositories..." value={settingsRepoSearch} onChange={e => setSettingsRepoSearch(e.target.value)} />
                    </div>
                    {filteredSettingsRepos.length === 0 ? (
                      <div className="empty-state">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>
                        <div className="empty-state-title">No matching repositories</div>
                        <div className="empty-state-desc">Try a different search term.</div>
                      </div>
                    ) : (
                      <div className="repo-list">
                        {filteredSettingsRepos.map(r => {
                          const isConn = connectedRepos.has(r.full_name)
                          const isLoading = connectingRepo === r.full_name
                          return (
                            <div key={r.full_name} className={`repo-card ${isConn ? 'connected' : ''}`}>
                              <div className="repo-card-left">
                                <img className="repo-avatar" src={r.owner.avatar_url} alt={r.owner.login} />
                                <div className="repo-info">
                                  <div className="repo-name">{r.full_name}</div>
                                  {r.description && <div className="repo-desc">{r.description}</div>}
                                  <div className="repo-meta">
                                    {r.private && <span className="badge badge-dim">Private</span>}
                                  </div>
                                </div>
                              </div>
                              <button className={`toggle-btn ${isConn ? 'on' : 'off'}`} onClick={() => toggleRepoConnection(r.full_name, isConn)} disabled={isLoading}>
                                {isLoading ? '...' : isConn ? 'Connected' : 'Connect'}
                              </button>
                            </div>
                          )
                        })}
                      </div>
                    )}
                  </>
                )}
              </>
            )}

            {/* LLM Provider tab */}
            {settingsTab === 'llm' && (
              <div className="settings-panel">
                {settingsLlm ? (
                  <>
                    <div className="settings-current">
                      <div className="settings-row"><span className="settings-label">Provider</span><span className="settings-val">{settingsLlm.provider ?? 'Not configured'}</span></div>
                      <div className="settings-row"><span className="settings-label">Model</span><span className="settings-val">{settingsLlm.model || '-'}</span></div>
                      <div className="settings-row"><span className="settings-label">API Key</span><span className="settings-val mono">{settingsLlm.apiKeyMasked || 'Not set'} <span className="security-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>AES-256-GCM</span></span></div>
                    </div>

                    <h3 className="panel-title" style={{ marginTop: 24 }}>Update LLM Configuration</h3>
                    <div className="provider-grid provider-grid-sm">
                      {(settingsLlm.providers ?? []).map((p: LLMProvider) => (
                        <div key={p.id} className={`provider-card ${llmProvider === p.id ? 'selected' : ''}`} onClick={() => { setLlmProvider(p.id); setLlmModel(p.defaultModel ?? ''); setVerifyError('') }}>
                          <div className="provider-icon">{PROVIDER_ICONS[p.id] ?? '?'}</div>
                          <div className="provider-name">{p.name}</div>
                        </div>
                      ))}
                    </div>

                    {llmProvider && (
                      <div className="wiz-fields">
                        {llmProvider !== 'ollama' && (
                          <div className="wiz-field">
                            <label>API Key (leave blank to keep existing)</label>
                            <div className="wiz-input-wrap">
                              <input type={showApiKey ? 'text' : 'password'} value={llmApiKey} onChange={e => setLlmApiKey(e.target.value)} placeholder="Enter new API key..." />
                              <button className="wiz-toggle-vis" onClick={() => setShowApiKey(!showApiKey)}>{showApiKey ? 'Hide' : 'Show'}</button>
                            </div>
                          </div>
                        )}
                        <div className="wiz-field">
                          <label>Model</label>
                          <input type="text" value={llmModel} onChange={e => setLlmModel(e.target.value)} />
                        </div>
                        {llmProvider === 'custom' && (
                          <div className="wiz-field">
                            <label>Base URL</label>
                            <input type="text" value={llmBaseUrl} onChange={e => setLlmBaseUrl(e.target.value)} />
                          </div>
                        )}
                        {verifyError && <div className="wiz-error">{verifyError}</div>}
                        {verifySuccess && <div className="wiz-success">Updated successfully!</div>}
                        <button className="wiz-primary-btn" onClick={async () => {
                          setVerifying(true); setVerifyError(''); setVerifySuccess(false)
                          try {
                            const res = await apiFetch('/api/settings/llm', {
                              method: 'PUT',
                              headers: { 'Content-Type': 'application/json' },
                              body: JSON.stringify({ provider: llmProvider, apiKey: llmApiKey || undefined, baseUrl: llmBaseUrl || undefined, model: llmModel || undefined }),
                            })
                            if (!res.ok) { const d = await res.json(); setVerifyError(d.error ?? 'Failed'); }
                            else { setVerifySuccess(true); setLlmApiKey(''); loadSettingsLlm() }
                          } catch (e: any) { setVerifyError(e.message) }
                          setVerifying(false)
                        }} disabled={verifying}>
                          {verifying ? 'Updating...' : 'Update'}
                        </button>
                      </div>
                    )}
                  </>
                ) : (
                  <div className="empty-block"><div className="spinner" /><p>Loading LLM settings...</p></div>
                )}
              </div>
            )}

            {/* AWS Config tab */}
            {settingsTab === 'aws' && (
              <div className="settings-panel">
                {settingsAws ? (
                  <>
                    <div className="settings-current">
                      <div className="settings-row"><span className="settings-label">Status</span><span className="settings-val">{settingsAws.configured ? 'Configured' : 'Not configured'}</span></div>
                      {settingsAws.configured && (
                        <>
                          <div className="settings-row"><span className="settings-label">Region</span><span className="settings-val">{settingsAws.region}</span></div>
                          <div className="settings-row"><span className="settings-label">Access Key</span><span className="settings-val mono">{settingsAws.accessKeyIdMasked} <span className="security-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Encrypted</span></span></div>
                          <div className="settings-row"><span className="settings-label">Secret Key</span><span className="settings-val mono">{settingsAws.secretAccessKeyMasked} <span className="security-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Encrypted</span></span></div>
                        </>
                      )}
                    </div>

                    <h3 className="panel-title" style={{ marginTop: 24 }}>{settingsAws.configured ? 'Update' : 'Configure'} AWS Credentials</h3>
                    <div className="wiz-fields">
                      <div className="wiz-field">
                        <label>Access Key ID</label>
                        <input type="text" value={awsAccessKeyId} onChange={e => setAwsAccessKeyId(e.target.value)} placeholder="AKIA..." />
                      </div>
                      <div className="wiz-field">
                        <label>Secret Access Key</label>
                        <div className="wiz-input-wrap">
                          <input type={showAwsSecret ? 'text' : 'password'} value={awsSecretAccessKey} onChange={e => setAwsSecretAccessKey(e.target.value)} placeholder="Enter secret key..." />
                          <button className="wiz-toggle-vis" onClick={() => setShowAwsSecret(!showAwsSecret)}>{showAwsSecret ? 'Hide' : 'Show'}</button>
                        </div>
                      </div>
                      <div className="wiz-field">
                        <label>Region</label>
                        <select value={awsRegion} onChange={e => setAwsRegion(e.target.value)}>
                          {AWS_REGIONS.map(r => <option key={r} value={r}>{r}</option>)}
                        </select>
                      </div>
                      {verifyError && <div className="wiz-error">{verifyError}</div>}
                      {verifySuccess && <div className="wiz-success">Updated successfully!</div>}
                      <button className="wiz-primary-btn" onClick={async () => {
                        setVerifying(true); setVerifyError(''); setVerifySuccess(false)
                        try {
                          const res = await apiFetch('/api/settings/aws', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ accessKeyId: awsAccessKeyId, secretAccessKey: awsSecretAccessKey, region: awsRegion }),
                          })
                          if (!res.ok) { const d = await res.json(); setVerifyError(d.error ?? 'Failed'); }
                          else { setVerifySuccess(true); setAwsAccessKeyId(''); setAwsSecretAccessKey(''); loadSettingsAws() }
                        } catch (e: any) { setVerifyError(e.message) }
                        setVerifying(false)
                      }} disabled={verifying || !awsAccessKeyId || !awsSecretAccessKey}>
                        {verifying ? 'Updating...' : 'Update'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-block"><div className="spinner" /><p>Loading AWS settings...</p></div>
                )}
              </div>
            )}

            {/* GitHub OAuth tab */}
            {settingsTab === 'github' && (
              <div className="settings-panel">
                {settingsGithub ? (
                  <>
                    <div className="settings-current">
                      <div className="settings-row"><span className="settings-label">Status</span><span className="settings-val">{settingsGithub.configured ? 'Configured' : 'Not configured'}</span></div>
                      {settingsGithub.configured && (
                        <>
                          <div className="settings-row"><span className="settings-label">Client ID</span><span className="settings-val mono">{settingsGithub.clientId}</span></div>
                          <div className="settings-row"><span className="settings-label">Client Secret</span><span className="settings-val mono">{settingsGithub.clientSecretMasked} <span className="security-badge"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>Encrypted</span></span></div>
                        </>
                      )}
                    </div>

                    <h3 className="panel-title" style={{ marginTop: 24 }}>Update GitHub OAuth Credentials</h3>
                    <div className="wiz-fields">
                      <div className="wiz-field">
                        <label>Client ID</label>
                        <input type="text" value={setupClientId} onChange={e => { setSetupClientId(e.target.value); setSetupError('') }} placeholder="Ov23li..." />
                      </div>
                      <div className="wiz-field">
                        <label>Client Secret</label>
                        <div className="wiz-input-wrap">
                          <input type={setupShowSecret ? 'text' : 'password'} value={setupClientSecret} onChange={e => { setSetupClientSecret(e.target.value); setSetupError('') }} placeholder="Enter new Client Secret..." />
                          <button className="wiz-toggle-vis" onClick={() => setSetupShowSecret(!setupShowSecret)}>{setupShowSecret ? 'Hide' : 'Show'}</button>
                        </div>
                      </div>
                      {verifyError && <div className="wiz-error">{verifyError}</div>}
                      {verifySuccess && <div className="wiz-success">Updated successfully!</div>}
                      <button className="wiz-primary-btn" onClick={async () => {
                        setVerifying(true); setVerifyError(''); setVerifySuccess(false)
                        try {
                          const res = await apiFetch('/api/settings/github', {
                            method: 'PUT',
                            headers: { 'Content-Type': 'application/json' },
                            body: JSON.stringify({ clientId: setupClientId, clientSecret: setupClientSecret }),
                          })
                          if (!res.ok) { const d = await res.json(); setVerifyError(d.error ?? 'Failed'); }
                          else { setVerifySuccess(true); setSetupClientId(''); setSetupClientSecret(''); loadSettingsGithub() }
                        } catch (e: any) { setVerifyError(e.message) }
                        setVerifying(false)
                      }} disabled={verifying || !setupClientId || !setupClientSecret}>
                        {verifying ? 'Updating...' : 'Update'}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="empty-block"><div className="spinner" /><p>Loading GitHub OAuth settings...</p></div>
                )}
              </div>
            )}
          </div>
        )}
        {/* ── Security Footer ── */}
        <footer className="security-footer">
          <div className="security-footer-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0110 0v4"/></svg>
            Data encrypted at rest (AES-256-GCM)
          </div>
          <div className="security-footer-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
            90-day automatic data cleanup
          </div>
          <div className="security-footer-item">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 19c-5 1.5-5-2.5-7-3m14 6v-3.87a3.37 3.37 0 00-.94-2.61c3.14-.35 6.44-1.54 6.44-7A5.44 5.44 0 0020 4.77 5.07 5.07 0 0019.91 1S18.73.65 16 2.48a13.38 13.38 0 00-7 0C6.27.65 5.09 1 5.09 1A5.07 5.07 0 005 4.77a5.44 5.44 0 00-1.5 3.78c0 5.42 3.3 6.61 6.44 7A3.37 3.37 0 009 18.13V22"/></svg>
            Open source
          </div>
        </footer>
      </main>
    </div>
  )
}

/* ── Diff Row Component ── */
function DiffRow({ line, comments }: { line: DiffLine; comments: ReviewComment[] }) {
  return (
    <>
      <tr className={`diff-line diff-${line.type}`}>
        <td className="ln ln-old">{line.type === 'del' || line.type === 'ctx' ? line.oldNum : ''}</td>
        <td className="ln ln-new">{line.type === 'add' || line.type === 'ctx' ? line.newNum : ''}</td>
        <td className="diff-marker">
          {line.type === 'add' ? '+' : line.type === 'del' ? '-' : line.type === 'hunk' ? '@@' : ' '}
        </td>
        <td className="diff-text">
          <pre>{line.text}</pre>
        </td>
      </tr>
      {comments.map((c, ci) => (
        <tr key={ci} className="diff-inline-comment">
          <td colSpan={4}>
            <div className="dic-card" style={{ borderLeftColor: SEV[c.severity]?.color ?? '#666' }}>
              <span className="dic-sev" style={{ background: SEV[c.severity]?.color, color: '#fff' }}>{c.severity}</span>
              <span className="dic-cat">{c.category}</span>
              <span className="dic-conf">{Math.round(c.confidence * 100)}%</span>
              <div className="dic-msg">{c.message}</div>
              {c.suggestion && <div className="dic-sug">Suggestion: {c.suggestion}</div>}
            </div>
          </td>
        </tr>
      ))}
    </>
  )
}
