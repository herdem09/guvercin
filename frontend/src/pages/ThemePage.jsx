import { useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../context/ThemeContext.jsx'
import { importThemeFromFile } from '../theme/importThemeFile.js'
import './ThemePage.css'

const BUILTIN = [
  { name: 'light', labelKey: 'Light', swatches: ['#FFF5CA', '#FFCB08', '#343a40'] },
  { name: 'dark', labelKey: 'Dark', swatches: ['#0f1115', '#3b3f46', '#e9eaec'] },
]

function ThemePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { setThemeMode, setThemeName, themeMode, themeName, refreshThemes } = useTheme()
  const themeImportInputRef = useRef(null)
  const [importBusy, setImportBusy] = useState(false)
  const [importMsg, setImportMsg] = useState(null)

  const initial = useMemo(() => {
    const storedMode = localStorage.getItem('temp_theme_mode') || themeMode || 'system'
    const storedName = localStorage.getItem('temp_theme_name') || themeName || 'light'
    return { storedMode, storedName }
  }, [themeMode, themeName])

  const [mode, setMode] = useState(initial.storedMode)
  const [selected, setSelected] = useState(initial.storedName)

  const chooseManual = async (name) => {
    setMode('manual')
    setSelected(name)
    localStorage.setItem('temp_theme_mode', 'manual')
    localStorage.setItem('temp_theme_name', name)
    await setThemeMode('manual')
    await setThemeName(name)
  }

  const chooseSystem = async () => {
    setMode('system')
    localStorage.setItem('temp_theme_mode', 'system')
    localStorage.removeItem('temp_theme_name')
    await setThemeMode('system')
  }

  const handleContinue = () => {
    if (mode !== 'manual') {
      localStorage.setItem('temp_theme_mode', 'system')
      localStorage.removeItem('temp_theme_name')
    } else {
      localStorage.setItem('temp_theme_mode', 'manual')
      localStorage.setItem('temp_theme_name', selected || 'light')
    }
    navigate('/offline-setup')
  }

  const handleOthersClick = () => {
    setImportMsg(null)
    themeImportInputRef.current?.click()
  }

  const handleImportFile = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    if (!file) return
    setImportBusy(true)
    setImportMsg(null)
    try {
      const result = await importThemeFromFile(file)
      if (!result.ok) {
        setImportMsg({ type: 'error', text: t('Theme file is invalid.') })
        return
      }
      await refreshThemes()
      await setThemeMode('manual')
      await setThemeName(result.themeName)
      setMode('manual')
      setSelected(result.themeName)
      setImportMsg({ type: 'success', text: t('Theme imported successfully.') })
    } catch {
      setImportMsg({ type: 'error', text: t('Theme file is invalid.') })
    } finally {
      setImportBusy(false)
    }
  }

  return (
    <div className="theme-page">
      <div className="theme-container">
        <h2 className="sticky-title">{t('Theme')}</h2>
        <p className="theme-subtitle">{t('Choose a theme')}</p>

        <div className="theme-grid">
          {BUILTIN.map((theme) => (
            <button
              key={theme.name}
              type="button"
              className={`theme-card ${mode === 'manual' && selected === theme.name ? 'active' : ''}`}
              onClick={() => chooseManual(theme.name)}
            >
              <div className="theme-card__label">{t(theme.labelKey)}</div>
              <div className="theme-card__swatches">
                {theme.swatches.map((color) => (
                  <span key={color} className="theme-swatch" style={{ background: color }} aria-hidden="true" />
                ))}
              </div>
            </button>
          ))}
        </div>

        <div className="theme-actions">
          <button type="button" className={`theme-system ${mode === 'system' ? 'active' : ''}`} onClick={chooseSystem}>
            {t('System (default)')}
          </button>
          <input
            ref={themeImportInputRef}
            type="file"
            accept="application/json,.json"
            className="theme-hidden-file-input"
            aria-hidden
            tabIndex={-1}
            onChange={handleImportFile}
          />
          <button type="button" className="theme-others" onClick={handleOthersClick} disabled={importBusy}>
            {t('Others')}
          </button>
        </div>

        {importMsg?.type === 'error' && (
          <div className="theme-import-inline-msg theme-import-inline-msg--error" role="alert">
            {importMsg.text}
          </div>
        )}
        {importMsg?.type === 'success' && (
          <div className="theme-import-inline-msg theme-import-inline-msg--success" role="status">
            {importMsg.text}
          </div>
        )}

        <button type="button" className="continue-button" onClick={handleContinue}>
          {t('Continue')}
        </button>
      </div>
    </div>
  )
}

export default ThemePage
