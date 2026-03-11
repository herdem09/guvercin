import { useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { useTheme } from '../context/ThemeContext.jsx'
import './ThemePage.css'

const BUILTIN = [
  { name: 'light', labelKey: 'Light', swatches: ['#FFF5CA', '#FFCB08', '#343a40'] },
  { name: 'dark', labelKey: 'Dark', swatches: ['#0f1115', '#3b3f46', '#e9eaec'] },
]

function ThemePage() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { setThemeMode, setThemeName, themeMode, themeName } = useTheme()

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
          <button type="button" className="theme-others" onClick={() => navigate('/theme-import')}>
            {t('Others')}
          </button>
        </div>

        <button type="button" className="continue-button" onClick={handleContinue}>
          {t('Continue')}
        </button>
      </div>
    </div>
  )
}

export default ThemePage
