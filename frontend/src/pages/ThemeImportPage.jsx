import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { validateTheme, upsertCustomTheme } from '../theme/themeManager.js'
import { useTheme } from '../context/ThemeContext.jsx'
import './ThemeImportPage.css'

async function isTauri() {
  return Boolean(window.__TAURI__)
}

function readFileText(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new Error('read_failed'))
    reader.onload = () => resolve(String(reader.result || ''))
    reader.readAsText(file)
  })
}

function ThemeImportPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const inputRef = useRef(null)
  const { refreshThemes, setThemeMode, setThemeName } = useTheme()

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [success, setSuccess] = useState('')

  const helper = useMemo(() => t('Select theme JSON'), [t])

  const handlePick = () => inputRef.current?.click()

  const handleFile = async (file) => {
    setError('')
    setSuccess('')
    if (!file) return
    setBusy(true)
    try {
      const text = await readFileText(file)
      const validated = validateTheme(text)
      if (!validated.ok) {
        setError(t('Theme file is invalid.'))
        return
      }

      const theme = validated.theme
      if (await isTauri()) {
        const { invoke } = await import('@tauri-apps/api/core')
        await invoke('write_user_theme', { name: theme.name, json: JSON.stringify(theme) })
      } else {
        const res = upsertCustomTheme(theme)
        if (!res.ok) {
          setError(t('Theme file is invalid.'))
          return
        }
      }

      localStorage.setItem('temp_theme_mode', 'manual')
      localStorage.setItem('temp_theme_name', theme.name)

      await refreshThemes()
      await setThemeMode('manual')
      await setThemeName(theme.name)

      setSuccess(t('Theme imported successfully.'))
    } catch (err) {
      console.error('Theme import failed:', err)
      setError(t('Theme file is invalid.'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="theme-import-page">
      <div className="theme-import-container">
        <h2 className="sticky-title">{t('Import Theme')}</h2>

        <p className="theme-import-helper">{helper}</p>

        <input
          ref={inputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={(e) => handleFile(e.target.files?.[0])}
        />

        <div className="theme-import-actions">
          <button type="button" className="continue-button" onClick={handlePick} disabled={busy}>
            {t('Select theme JSON')}
          </button>
          <button type="button" className="theme-import-back" onClick={() => navigate('/theme')} disabled={busy}>
            {t('Back')}
          </button>
        </div>

        {error && <div className="theme-import-error">{error}</div>}
        {success && (
          <div className="theme-import-success">
            <div>{success}</div>
            <button type="button" className="theme-import-apply" onClick={() => navigate('/theme')} disabled={busy}>
              {t('Apply Theme')}
            </button>
          </div>
        )}
      </div>
    </div>
  )
}

export default ThemeImportPage
