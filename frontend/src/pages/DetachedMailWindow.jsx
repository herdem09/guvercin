import { useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../utils/api'
import './DashboardPage.css'

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

export default function DetachedMailWindow() {
  const [windowLabel, setWindowLabel] = useState('')
  const [data, setData] = useState(null)
  const [mailContent, setMailContent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')

  const accountId = data?.accountId
  const mail = data?.mail
  const mailbox = data?.mailbox

  const subject = useMemo(() => mailContent?.subject || mail?.subject || '(Konu Yok)', [mailContent, mail])
  const fromLine = useMemo(() => {
    if (!mail) return '-'
    if (mailContent?.from_name && mailContent?.from_address) {
      return `${mailContent.from_name} <${mailContent.from_address}>`
    }
    return mail?.address || mail?.name || '-'
  }, [mail, mailContent])

  useEffect(() => {
    document.body.style.padding = '0'
    document.body.style.margin = '0'
    document.body.style.overflow = 'hidden'
    return () => {
      document.body.style.padding = ''
      document.body.style.margin = ''
      document.body.style.overflow = ''
    }
  }, [])

  // Step 1: get window label from Tauri
  useEffect(() => {
    let active = true
    const detectLabel = async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const label = getCurrentWebviewWindow().label
        if (!active) return
        setWindowLabel(label)
      } catch {
        // not running on Tauri
      }
    }
    detectLabel()
    return () => { active = false }
  }, [])

  // Step 2: once we have the label, fetch mail data from Rust app state
  useEffect(() => {
    if (!windowLabel) return
    let active = true
    const fetchData = async () => {
      try {
        const { invoke } = await import('@tauri-apps/api/core')
        const json = await invoke('get_mail_window_data', { label: windowLabel })
        if (!active) return
        if (json) {
          const parsed = safeParse(json)
          setData(parsed)
          setMailContent(parsed?.mailContent || null)
        }
      } catch {
        // not running in Tauri or command not available
      }
    }
    fetchData()
    return () => { active = false }
  }, [windowLabel])

  useEffect(() => {
    if (!mail || !accountId || mailContent) return
    let active = true
    const timeoutId = setTimeout(() => {
      if (!active) return
      setError('İçerik yükleme zaman aşımına uğradı.')
      setLoading(false)
    }, 20000)
    setLoading(true)
    setError('')
    const mailboxParam = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ''
    fetch(apiUrl(`/api/mail/${accountId}/content/${mail.id}${mailboxParam}`), { cache: 'no-store' })
      .then(async (res) => {
        if (!res.ok) {
          let message = 'İçerik yüklenemedi'
          try {
            const body = await res.json()
            if (typeof body?.error === 'string' && body.error.trim()) {
              message = body.error
            }
          } catch {
            // ignore
          }
          throw new Error(message)
        }
        return res.json()
      })
      .then((json) => {
        if (!active) return
        clearTimeout(timeoutId)
        setMailContent(json)
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        clearTimeout(timeoutId)
        setError(err?.message || 'Bilinmeyen hata')
        setLoading(false)
      })
    return () => {
      active = false
      clearTimeout(timeoutId)
    }
  }, [accountId, mail, mailContent])

  const closeWindow = async () => {
    try {
      const { invoke } = await import('@tauri-apps/api/core')
      if (!windowLabel) {
        window.close()
        return
      }
      await invoke('close_mail_window', { label: windowLabel })
    } catch {
      window.close()
    }
  }

  if (!mail || !accountId) {
    return (
      <div className="startup-router">
        <p>Bu pencere için e-posta verisi bulunamadı.</p>
        <div className="startup-router__actions">
          <button type="button" onClick={closeWindow}>Kapat</button>
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard-page" style={{ height: '100vh' }}>
      <div className="db-navbar">
        <div className="db-logo-icon">🕊️</div>
        <span className="db-logo-text">Güvercin</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="db-icon-btn" title="Kapat" onClick={closeWindow}>✕</button>
        </div>
      </div>

      <div className="db-section-area">
        <div className="db-right-panel" style={{ flex: 1 }}>
          {loading ? (
            <div className="db-loading" style={{ paddingTop: 60 }}>
              <div className="db-spinner" />
              İçerik yükleniyor…
            </div>
          ) : error ? (
            <div className="db-empty-state">
              <div className="db-empty-icon">⚠️</div>
              <div className="db-empty-text">{error}</div>
            </div>
          ) : (
            <div className="db-mail-content">
              <div className="db-mail-content-header">
                <div className="db-mail-content-subject">{subject}</div>
              </div>
              <div className="db-mail-meta"><strong>Kimden:</strong> {fromLine}</div>
              <hr className="db-mail-divider" />
              {mailContent?.html_body ? (
                <div className="db-mail-body-html">
                  <iframe
                    key={mail?.id}
                    title="mail-content"
                    sandbox="allow-same-origin"
                    srcDoc={mailContent.html_body}
                  />
                </div>
              ) : (
                <div className="db-mail-body">{mailContent?.plain_body || '(İçerik yok)'}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
