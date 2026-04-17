import { useEffect, useMemo, useState } from 'react'
import { getUrlDomain } from '../utils/externalLinks.js'
import './ExternalLinkPrompt.css'

function truncateMiddle(value, maxLen = 86) {
  const s = String(value || '')
  if (s.length <= maxLen) return s
  const keep = Math.max(8, Math.floor((maxLen - 3) / 2))
  return `${s.slice(0, keep)}...${s.slice(-keep)}`
}

export default function ExternalLinkPrompt({
  open,
  url,
  onCancel,
  onSelect,
}) {
  const [remember, setRemember] = useState(false)
  const [rememberDomain, setRememberDomain] = useState(false)

  useEffect(() => {
    if (open) {
      setRemember(false)
      setRememberDomain(false)
    }
  }, [open, url])

  useEffect(() => {
    if (!open) return undefined
    const onKey = (e) => {
      if (e.key === 'Escape') onCancel?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onCancel])

  const urlLabel = useMemo(() => truncateMiddle(url, 96), [url])
  const domain = useMemo(() => getUrlDomain(url), [url])

  if (!open) return null

  return (
    <div className="elp-overlay" role="dialog" aria-modal="true">
      <div className="elp-modal">
        <div className="elp-title">Bu link ile ne yapılsın?</div>
        <div className="elp-url" title={url || ''}>{urlLabel}</div>

        <div className="elp-remember-container">
          <label className="elp-remember">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => {
                setRemember(e.target.checked)
                if (e.target.checked) setRememberDomain(false)
              }}
            />
            Tüm linkler için hatırla
          </label>

          {domain && (
            <label className="elp-remember">
              <input
                type="checkbox"
                checked={rememberDomain}
                onChange={(e) => {
                  setRememberDomain(e.target.checked)
                  if (e.target.checked) setRemember(false)
                }}
              />
              Bu site ({domain}) için hatırla
            </label>
          )}
        </div>

        <div className="elp-actions">
          <button type="button" className="elp-btn" onClick={() => onCancel?.()}>
            İptal
          </button>
          <button type="button" className="elp-btn" onClick={() => onSelect?.('copy', remember, rememberDomain)}>
            Kopyala
          </button>
          <button type="button" className="elp-btn elp-btn-primary" onClick={() => onSelect?.('open', remember, rememberDomain)}>
            Aç
          </button>
        </div>
      </div>
    </div>
  )
}

