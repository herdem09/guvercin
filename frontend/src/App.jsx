import { useEffect, useState } from 'react'
import { Routes, Route, Navigate, useLocation, useNavigate } from 'react-router-dom'
import LoginPage from './pages/LoginPage.jsx'
import LanguagePage from './pages/LanguagePage.jsx'
import FontPage from './pages/FontPage.jsx'
import AiChooserPage from './pages/AiChooserPage.jsx'
import NotAuthPage from './pages/NotAuthPage.jsx'
import DashboardPage from './pages/DashboardPage.jsx'
import AccountSelectionPage from './pages/AccountSelectionPage.jsx'
import i18n from './i18n'
import { useTranslation } from 'react-i18next'
import { hydrateAccountSession } from './utils/accountStorage.js'

function App() {
  const location = useLocation()

  useEffect(() => {
    const path = location.pathname

    // Clear temporary data if we are at the very start of onboarding
    if (path === '/login' || path === '/') {
      localStorage.removeItem('temp_account_form')
      localStorage.removeItem('temp_language')
      localStorage.removeItem('temp_font')
      i18n.changeLanguage('en')
    }

    const tempFont = localStorage.getItem('temp_font')
    const savedFont = localStorage.getItem('font')
    const onboardingPaths = ['/login', '/language', '/font', '/ai_chooser', '/not_auth']

    let fontToUse = "'Inter', sans-serif"

    if (onboardingPaths.includes(path)) {
      if (tempFont) {
        fontToUse = `"${tempFont}", sans-serif`
      }
    } else if (path.startsWith('/dashboard')) {
      if (savedFont) {
        fontToUse = `"${savedFont}", sans-serif`
      }
      // Dashboard manages its own full-page layout; remove body padding
      document.body.style.padding = '0'
      document.body.style.margin = '0'
      document.body.style.overflow = 'hidden'
    } else {
      document.body.style.padding = ''
      document.body.style.margin = ''
      document.body.style.overflow = ''
    }

    document.body.style.fontFamily = fontToUse
  }, [location])

  return (
    <Routes>
      <Route path="/" element={<StartupRouter />} />
      <Route path="/account-select" element={<AccountSelectionPage />} />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/language" element={<LanguagePage />} />
      <Route path="/font" element={<FontPage />} />
      <Route path="/ai_chooser" element={<AiChooserPage />} />
      <Route path="/not_auth" element={<NotAuthPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
    </Routes>
  )
}

export default App

function StartupRouter() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    let active = true

    const fetchAccounts = async () => {
      try {
        const response = await fetch('/api/auth/accounts')
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
        } else if (accounts.length === 1) {
          hydrateAccountSession(accounts[0])
          navigate('/dashboard', { replace: true })
        } else {
          navigate('/account-select', { replace: true })
        }
      } catch (err) {
        if (!active) {
          return
        }
        setError(t('Unable to load accounts. Please try again.'))
      } finally {
        if (active) {
          setLoading(false)
        }
      }
    }

    fetchAccounts()
    return () => {
      active = false
    }
  }, [navigate, t])

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
      <p>{loading ? t('Checking registered accounts...') : t('Checking registered accounts...')}</p>
    </div>
  )
}
