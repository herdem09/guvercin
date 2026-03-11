import { createContext, useCallback, useContext, useLayoutEffect, useMemo, useState } from 'react'
import {
  applyThemePreference,
  getAvailableThemes,
  getStoredThemePreference,
  listenToSystemThemeChanges,
  setStoredThemePreference,
} from '../theme/themeManager.js'

const ThemeContext = createContext(null)

export function ThemeProvider({ children }) {
  const [themeMode, setThemeModeState] = useState(() => getStoredThemePreference().mode)
  const [themeName, setThemeNameState] = useState(() => getStoredThemePreference().name)
  const [availableThemes, setAvailableThemes] = useState(() => [])

  const refreshThemes = useCallback(async () => {
    const names = await getAvailableThemes()
    setAvailableThemes(names)
  }, [])

  const apply = useCallback(async (nextMode, nextName) => {
    const pref = { mode: nextMode, name: nextName }
    setStoredThemePreference(nextMode, nextName)
    await applyThemePreference(pref)
  }, [])

  const setThemeMode = useCallback(async (mode) => {
    const nextMode = mode || 'system'
    setThemeModeState(nextMode)
    await apply(nextMode, themeName)
  }, [apply, themeName])

  const setThemeName = useCallback(async (name) => {
    const nextName = name || 'light'
    setThemeNameState(nextName)
    await apply(themeMode, nextName)
  }, [apply, themeMode])

  useLayoutEffect(() => {
    let unsubscribe = () => {}
    let active = true
    const handleExternalChange = async () => {
      if (!active) return
      const pref = getStoredThemePreference()
      setThemeModeState(pref.mode)
      setThemeNameState(pref.name)
      try {
        await refreshThemes()
        await applyThemePreference(pref)
      } catch {
        
      }
    }

    const run = async () => {
      try {
        await refreshThemes()
        await apply(themeMode, themeName)
      } catch {
        
      }

      unsubscribe = listenToSystemThemeChanges(async () => {
        if (!active) return
        if (getStoredThemePreference().mode !== 'system') return
        try {
          await applyThemePreference(getStoredThemePreference())
        } catch {
          
        }
      })
    }

    run()
    window.addEventListener('guvercin-theme-changed', handleExternalChange)
    return () => {
      active = false
      unsubscribe()
      window.removeEventListener('guvercin-theme-changed', handleExternalChange)
    }
  }, [apply, refreshThemes, themeMode, themeName])

  const value = useMemo(() => ({
    themeMode,
    themeName,
    availableThemes,
    refreshThemes,
    setThemeMode,
    setThemeName,
  }), [availableThemes, refreshThemes, setThemeMode, setThemeName, themeMode, themeName])

  return <ThemeContext.Provider value={value}>{children}</ThemeContext.Provider>
}

export function useTheme() {
  const ctx = useContext(ThemeContext)
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider')
  return ctx
}
