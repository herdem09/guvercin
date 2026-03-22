import { validateTheme, upsertCustomTheme } from './themeManager.js'

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

/**
 * Reads a theme JSON file, writes it (Tauri or web), sets temp_theme_* in localStorage.
 * Caller should call refreshThemes + setThemeMode('manual') + setThemeName(name).
 * @param {object} [options]
 * @param {boolean} [options.skipTempKeys] — if true, do not write temp_theme_* to localStorage (e.g. settings preview until Save).
 * @returns {Promise<{ ok: true, themeName: string } | { ok: false, error: 'invalid' | 'read_failed' }>}
 */
export async function importThemeFromFile(file, options = {}) {
    const skipTempKeys = options.skipTempKeys === true
    if (!file) return { ok: false, error: 'invalid' }
    try {
        const text = await readFileText(file)
        const validated = validateTheme(text)
        if (!validated.ok) {
            return { ok: false, error: 'invalid' }
        }

        const theme = validated.theme
        if (await isTauri()) {
            const { invoke } = await import('@tauri-apps/api/core')
            await invoke('write_user_theme', { name: theme.name, json: JSON.stringify(theme) })
        } else {
            const res = upsertCustomTheme(theme)
            if (!res.ok) {
                return { ok: false, error: 'invalid' }
            }
        }

        if (!skipTempKeys) {
            localStorage.setItem('temp_theme_mode', 'manual')
            localStorage.setItem('temp_theme_name', theme.name)
        }

        return { ok: true, themeName: theme.name }
    } catch {
        return { ok: false, error: 'invalid' }
    }
}
