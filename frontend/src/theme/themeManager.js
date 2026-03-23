const THEME_MODE_KEY = 'theme_mode'
const THEME_NAME_KEY = 'theme_name'

const CUSTOM_THEME_INDEX_KEY = 'custom_themes_index'
const CUSTOM_THEME_PREFIX = 'custom_theme_'

export const BUILTIN_THEMES = ['light', 'dark']

export function getStoredThemePreference() {
  const mode = localStorage.getItem(THEME_MODE_KEY) || 'manual'
  const name = localStorage.getItem(THEME_NAME_KEY) || 'light'
  return { mode, name }
}

export function setStoredThemePreference(mode, name) {
  localStorage.setItem(THEME_MODE_KEY, mode)
  localStorage.setItem(THEME_NAME_KEY, name)
}

export function getSystemPreferredThemeName() {
  try {
    return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function resolveEffectiveThemeName(pref) {
  if (!pref || pref.mode !== 'manual') return getSystemPreferredThemeName()
  return pref.name || 'light'
}

async function isTauri() {
  return Boolean(window.__TAURI__)
}

async function invokeTauri(command, args) {
  const { invoke } = await import('@tauri-apps/api/core')
  return invoke(command, args)
}

function readCustomThemeJson(name) {
  const raw = localStorage.getItem(`${CUSTOM_THEME_PREFIX}${name}`)
  return raw || null
}

function getCustomThemeIndex() {
  try {
    const raw = localStorage.getItem(CUSTOM_THEME_INDEX_KEY)
    const parsed = raw ? JSON.parse(raw) : []
    return Array.isArray(parsed) ? parsed.filter(Boolean) : []
  } catch {
    return []
  }
}

function setCustomThemeIndex(names) {
  localStorage.setItem(CUSTOM_THEME_INDEX_KEY, JSON.stringify(names))
}

export function upsertCustomTheme(theme) {
  const validation = validateTheme(theme)
  if (!validation.ok) return validation

  const name = validation.theme.name
  localStorage.setItem(`${CUSTOM_THEME_PREFIX}${name}`, JSON.stringify(validation.theme))

  const index = new Set(getCustomThemeIndex())
  index.add(name)
  setCustomThemeIndex(Array.from(index).sort())

  return { ok: true, theme: validation.theme }
}

export async function getAvailableThemes() {
  const names = new Set(BUILTIN_THEMES)
  if (await isTauri()) {
    try {
      const user = await invokeTauri('list_user_themes', {})
      if (Array.isArray(user)) {
        user.forEach((n) => n && names.add(String(n)))
      }
    } catch {
      
    }
  } else {
    getCustomThemeIndex().forEach((n) => names.add(n))
  }
  return Array.from(names)
}

export function validateTheme(input) {
  let theme = input
  if (typeof input === 'string') {
    try {
      theme = JSON.parse(input)
    } catch {
      return { ok: false, error: 'invalid_json' }
    }
  }

  if (!theme || typeof theme !== 'object') return { ok: false, error: 'invalid_object' }

  const name = typeof theme.name === 'string' ? theme.name.trim() : ''
  const label = typeof theme.label === 'string' ? theme.label.trim() : ''
  const vars = theme.vars
  if (!name) return { ok: false, error: 'missing_name' }
  if (!vars || typeof vars !== 'object') return { ok: false, error: 'missing_vars' }

  const normalizedVars = {}
  for (const [key, value] of Object.entries(vars)) {
    if (typeof key !== 'string' || !key.startsWith('--')) continue
    if (typeof value !== 'string') continue
    normalizedVars[key] = value
  }

  if (Object.keys(normalizedVars).length === 0) return { ok: false, error: 'empty_vars' }

  return {
    ok: true,
    theme: {
      name,
      label: label || name,
      vars: normalizedVars,
    },
  }
}

export async function loadThemeJson(themeName) {
  if (!themeName) throw new Error('Theme name missing')

  const name = String(themeName)

  if (BUILTIN_THEMES.includes(name)) {
    const res = await fetch(`/themes/builtin/${encodeURIComponent(name)}.json`, { cache: 'no-store' })
    if (!res.ok) throw new Error(`Failed to load builtin theme: ${name}`)
    const json = await res.json()
    const v = validateTheme(json)
    if (!v.ok) throw new Error('Invalid builtin theme JSON')
    return v.theme
  }

  if (await isTauri()) {
    const raw = await invokeTauri('read_user_theme', { name })
    const v = validateTheme(raw)
    if (!v.ok) throw new Error('Invalid user theme JSON')
    return v.theme
  }

  const raw = readCustomThemeJson(name)
  const v = validateTheme(raw)
  if (!v.ok) throw new Error('Theme not found')
  return v.theme
}

export function applyThemeVars(vars) {
  if (!vars || typeof vars !== 'object') return
  const root = document.documentElement
  for (const [key, value] of Object.entries(vars)) {
    root.style.setProperty(key, value)
  }
}

export async function applyThemePreference(pref) {
  const effectiveName = resolveEffectiveThemeName(pref)
  if (!BUILTIN_THEMES.includes(effectiveName)) {
    const baseName = getSystemPreferredThemeName()
    try {
      const base = await loadThemeJson(BUILTIN_THEMES.includes(baseName) ? baseName : 'light')
      applyThemeVars(base.vars)
    } catch {
      
    }
  }

  const theme = await loadThemeJson(effectiveName)
  applyThemeVars(theme.vars)
  document.documentElement.dataset.theme = theme.name
  return { effectiveName: theme.name, theme }
}

export function listenToSystemThemeChanges(onChange) {
  if (!window.matchMedia) return () => {}
  const mql = window.matchMedia('(prefers-color-scheme: dark)')
  const handler = () => onChange?.()
  try {
    mql.addEventListener('change', handler)
    return () => mql.removeEventListener('change', handler)
  } catch {
    mql.addListener(handler)
    return () => mql.removeListener(handler)
  }
}
