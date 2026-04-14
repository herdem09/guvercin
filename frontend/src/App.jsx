import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import { apiUrl } from './utils/api'
import LoginPage from './pages/LoginPage.jsx'
import LanguagePage from './pages/LanguagePage.jsx'
import FontPage from './pages/FontPage.jsx'
import OfflineSetupPage from './pages/OfflineSetupPage.jsx'
import NotAuthPage from './pages/NotAuthPage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import AccountSelectionPage from './pages/AccountSelectionPage.jsx'
import DetachedMailWindow from './pages/DetachedMailWindow.jsx'
import DetachedComposeWindow from './pages/DetachedComposeWindow.jsx'
import LockScreen from './pages/LockScreen.jsx'
import i18n from './i18n'
import { useTranslation } from 'react-i18next'
import { hydrateAccountSession } from './utils/accountStorage.js'
import ThemePage from './pages/ThemePage.jsx'
import SettingsPage from './pages/SettingsPage.jsx'
import AccountSettingsPage from './pages/AccountSettingsPage.jsx'

function getDetachedHint() {
  try {
    const hint = typeof window !== 'undefined' ? window.__GUV_DETACHED__ : null
    if (!hint || typeof hint !== 'object') return null
    const kind = typeof hint.kind === 'string' ? hint.kind : ''
    const label = typeof hint.label === 'string' ? hint.label : ''
    if (!kind && !label) return null
    return { kind, label }
  } catch {
    return null
  }
}

function App() {
  const location = useLocation()
  const [windowLabel, setWindowLabel] = useState(() => getDetachedHint()?.label || '')

  useEffect(() => {
    let active = true
    const detectWindowLabel = async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const label = getCurrentWebviewWindow().label
        if (active) setWindowLabel(label)
      } catch {
        
      }
    }
    detectWindowLabel()
    return () => {
      active = false
    }
  }, [])

  useEffect(() => {
    const path = location.pathname
    const isDetachedWindow = (
      windowLabel === 'mail'
      || windowLabel.startsWith('mail-')
      || windowLabel === 'compose'
      || windowLabel.startsWith('compose-')
      || getDetachedHint()?.kind === 'mail'
      || getDetachedHint()?.kind === 'compose'
    )

    if (!isDetachedWindow && (path === '/login' || path === '/')) {
      localStorage.removeItem('temp_account_form')
      localStorage.removeItem('temp_language')
      localStorage.removeItem('temp_font')
      localStorage.removeItem('temp_theme_mode')
      localStorage.removeItem('temp_theme_name')
      localStorage.removeItem('temp_offline_config')
      i18n.changeLanguage('en')
    }

    const tempFont = localStorage.getItem('temp_font')
    const savedFont = localStorage.getItem('font')
    const onboardingPaths = ['/login', '/language', '/font', '/theme', '/offline-setup', '/not_auth', '/settings', '/account-settings']

    let fontToUse = "'Inter', sans-serif"

    if (onboardingPaths.includes(path)) {
      if (tempFont) {
        fontToUse = `"${tempFont}", sans-serif`
      }
    } else if (
      path.startsWith('/dashboard')
      || windowLabel === 'mail'
      || windowLabel.startsWith('mail-')
      || windowLabel === 'compose'
      || windowLabel.startsWith('compose-')
      || isDetachedWindow
    ) {
      if (savedFont) {
        fontToUse = `"${savedFont}", sans-serif`
      }
      
      document.body.style.padding = '0'
      document.body.style.margin = '0'
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.padding = ''
      document.body.style.margin = ''
      document.body.style.overflow = ''
    }

    document.body.style.fontFamily = fontToUse
  }, [location, windowLabel])

  if (windowLabel === 'mail' || windowLabel.startsWith('mail-')) {
    return <DetachedMailWindow initialLabel={windowLabel} />
  }

  if (windowLabel === 'compose' || windowLabel.startsWith('compose-')) {
    return <DetachedComposeWindow initialLabel={windowLabel} />
  }

  return (
    <Routes>
      <Route path="/" element={<StartupRouter />} />
      <Route path="/index.html" element={<Navigate to="/" replace />} />
      <Route path="/account-select" element={<AccountSelectionPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/language" element={<LanguagePage />} />
      <Route path="/font" element={<FontPage />} />
      <Route path="/theme" element={<ThemePage />} />
      <Route path="/offline-setup" element={<OfflineSetupPage />} />
      <Route path="/not_auth" element={<NotAuthPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route path="/settings" element={<SettingsPageWrapper />} />
      <Route path="/account-settings" element={<AccountSettingsPage />} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}

export default App

function StartupRouter() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [error, setError] = useState(null)
  const [retryCount, setRetryCount] = useState(0)
  // Lock-screen state
  const [lockAccount, setLockAccount] = useState(null) // { id, email, displayName }
  const [lockUnlocked, setLockUnlocked] = useState(false)

  useEffect(() => {
    if (lockUnlocked && lockAccount) {
      navigate('/dashboard', { replace: true })
    }
  }, [lockUnlocked, lockAccount, navigate])

  useEffect(() => {
    let active = true
    let retryTimer

    const fetchAccounts = async () => {
      try {
        setError(null)

        const response = await fetch(apiUrl('/api/auth/accounts'))
        if (!response.ok) {
          throw new Error('Failed to load accounts')
        }
        const data = await response.json()
        if (!active) {
          return
        }

        const accounts = Array.isArray(data.accounts) ? data.accounts : []
        if (accounts.length === 0) {
          navigate('/login', { replace: true })
        } else {
          // Pick the account to open
          const account = accounts.length === 1 ? accounts[0] : null
          if (account) {
            hydrateAccountSession(account)

            // Check security settings
            try {
              const secRes = await fetch(apiUrl('/api/security/settings'))
              if (secRes.ok) {
                const sec = await secRes.json()
                const policy = sec.login_policy || 'pc_only'
                if (policy === 'account_only' || policy === 'both') {
                  if (active) {
                    setLockAccount({
                      id: account.account_id,
                      email: account.email_address || '',
                      displayName: account.display_name || null,
                    })
                    return
                  }
                }
              }
            } catch {
              // If security check fails, just proceed
            }

            navigate('/dashboard', { replace: true })
          } else {
            navigate('/account-select', { replace: true })
          }
        }
      } catch {
        if (!active) {
          return
        }

        const errorMessage = t('Unable to load accounts. Retrying...')
        setError(errorMessage)

        setRetryCount(prev => prev + 1)
        retryTimer = setTimeout(fetchAccounts, 2000)
      } finally {
        
      }
    }

    fetchAccounts()
    return () => {
      active = false
      if (retryTimer) clearTimeout(retryTimer)
    }
  }, [navigate, t, retryCount])

  // Show lock screen when required
  if (lockAccount && !lockUnlocked) {
    return (
      <LockScreen
        accountId={lockAccount.id}
        accountEmail={lockAccount.email}
        displayName={lockAccount.displayName}
        onUnlocked={() => setLockUnlocked(true)}
      />
    )
  }

  if (error) {
    return (
      <div className="startup-router">
        <p>{error}</p>
        <div className="startup-router__actions">
          <button type="button" onClick={() => window.location.reload()}>
            {t('Try again')}
          </button>
          <button type="button" onClick={() => navigate('/login', { replace: true })}>
            {t('Back to Login')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div className="startup-router">
      <p>{t('Checking registered accounts...')}</p>
    </div>
  )
}

function SettingsPageWrapper() {
  const navigate = useNavigate()
  return <SettingsPage onClose={() => navigate(-1)} accountId={null} />
}
