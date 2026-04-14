import React from 'react'
import ReactDOM from 'react-dom/client'
import { BrowserRouter } from 'react-router-dom'
import App from './App.jsx'
import './index.css'
import './i18n'

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
