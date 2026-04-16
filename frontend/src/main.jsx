import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import './i18n'
import { installTauriTerminalLogging } from './utils/tauriTerminalLogging.js'

void installTauriTerminalLogging()

// Prevent accidental text selection while dragging/resizing.
// Skipped entirely for [draggable] elements so HTML5 drag & drop keeps working.
;(function installNoSelectGuard() {
  document.addEventListener('mousedown', (e) => {
    if (e.target.closest('[draggable="true"]')) return

    const startX = e.clientX
    const startY = e.clientY

    const onMove = (moveEvent) => {
      if (Math.abs(moveEvent.clientX - startX) > 3 || Math.abs(moveEvent.clientY - startY) > 3) {
        document.body.classList.add('no-select')
        document.removeEventListener('mousemove', onMove, true)
      }
    }

    const onUp = () => {
      document.body.classList.remove('no-select')
      document.removeEventListener('mousemove', onMove, true)
      document.removeEventListener('mouseup', onUp, true)
    }

    document.addEventListener('mousemove', onMove, true)
    document.addEventListener('mouseup', onUp, true)
  }, { capture: true, passive: true })
}())

// Disable the browser-like context menu (Back/Forward/Reload) on empty areas.
// Keep native context menus for editable fields (copy/paste, etc.).
;(function installContextMenuGuard() {
  // Only apply inside the Tauri runtime.
  try {
    if (!(window.__TAURI_INTERNALS__ || window.__TAURI__)) return
  } catch {
    return
  }

  const GUARD_FLAG = '__GUV_CONTEXT_MENU_GUARD_INSTALLED__'

  const installOnWindow = (win) => {
    try {
      if (!win || win[GUARD_FLAG]) return
      win[GUARD_FLAG] = true

      const shouldAllowNativeContextMenu = (eventTarget) => {
        const el = eventTarget && typeof eventTarget.closest === 'function' ? eventTarget : null
        if (!el) return false

        // Keep native context menus for editable fields (copy/paste, etc.).
        if (el.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])')) return true
        // Opt-out hook for future cases.
        if (el.closest('[data-allow-native-context-menu="true"]')) return true

        return false
      }

      const stop = (e) => {
        e.preventDefault()
        e.stopImmediatePropagation()
      }

      const onContextMenu = (e) => {
        if (!shouldAllowNativeContextMenu(e.target)) stop(e)
      }

      const onMouseDown = (e) => {
        if (e.button !== 2) return
        if (!shouldAllowNativeContextMenu(e.target)) stop(e)
      }

      win.addEventListener('contextmenu', onContextMenu, { capture: true })
      win.addEventListener('mousedown', onMouseDown, { capture: true })
      win.document?.addEventListener('contextmenu', onContextMenu, { capture: true })
      win.document?.addEventListener('mousedown', onMouseDown, { capture: true })
    } catch {
      // ignore (cross-origin / sandbox)
    }
  }

  const tryInstallInIframe = (iframe) => {
    try {
      const win = iframe?.contentWindow
      if (win) installOnWindow(win)
    } catch {
      // ignore (cross-origin / sandbox)
    }
  }

  const hookIframe = (iframe) => {
    if (!(iframe instanceof HTMLIFrameElement)) return
    tryInstallInIframe(iframe)
    iframe.addEventListener('load', () => tryInstallInIframe(iframe), { capture: true })
  }

  installOnWindow(window)

  // Existing iframes (mail body is rendered in sandboxed iframes).
  try {
    document.querySelectorAll('iframe').forEach(hookIframe)
  } catch {
    
  }

  // New iframes inserted later.
  try {
    const observer = new MutationObserver((records) => {
      for (const record of records) {
        for (const node of record.addedNodes) {
          if (node instanceof HTMLIFrameElement) {
            hookIframe(node)
            continue
          }
          if (node && typeof node.querySelectorAll === 'function') {
            node.querySelectorAll('iframe').forEach(hookIframe)
          }
        }
      }
    })
    observer.observe(document.documentElement, { childList: true, subtree: true })
  } catch {
    
  }
}())

import { OfflineSyncProvider } from './context/OfflineSyncContext.jsx'
import { ThemeProvider } from './context/ThemeContext.jsx'

function showFatalOverlay(title, details) {
  try {
    const overlay = document.createElement('div')
    overlay.style.position = 'fixed'
    overlay.style.inset = '0'
    overlay.style.zIndex = '2147483647'
    overlay.style.background = 'rgba(10, 10, 10, 0.92)'
    overlay.style.color = '#fff'
    overlay.style.padding = '16px'
    overlay.style.fontFamily =
      "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace"
    overlay.style.overflow = 'auto'

    const heading = document.createElement('div')
    heading.textContent = `Guvercin UI error: ${title || 'Unknown error'}`
    heading.style.fontSize = '14px'
    heading.style.fontWeight = '700'
    heading.style.marginBottom = '12px'

    const pre = document.createElement('pre')
    pre.textContent = details || ''
    pre.style.whiteSpace = 'pre-wrap'
    pre.style.wordBreak = 'break-word'
    pre.style.opacity = '0.95'
    pre.style.fontSize = '12px'

    overlay.appendChild(heading)
    overlay.appendChild(pre)
    document.body.appendChild(overlay)
  } catch {
    
  }
}

window.addEventListener('error', (event) => {
  const message = event?.message || 'Uncaught error'
  const stack = event?.error?.stack || ''
  showFatalOverlay(message, stack)
})

window.addEventListener('unhandledrejection', (event) => {
  const reason = event?.reason
  const message = typeof reason === 'string' ? reason : reason?.message || 'Unhandled promise rejection'
  const stack = reason?.stack || ''
  showFatalOverlay(message, stack)
})

try {
  ReactDOM.createRoot(document.getElementById('root')).render(
    <React.StrictMode>
      <ThemeProvider>
        <OfflineSyncProvider>
          <BrowserRouter>
            <App />
          </BrowserRouter>
        </OfflineSyncProvider>
      </ThemeProvider>
    </React.StrictMode>,
  )
} catch (err) {
  showFatalOverlay(err?.message || String(err), err?.stack || '')
}
