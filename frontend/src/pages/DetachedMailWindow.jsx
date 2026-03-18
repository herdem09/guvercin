import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { apiUrl } from '../utils/api'
import { normalizeMailboxResponse } from '../utils/mailboxes'
import './DashboardPage.css'

function safeParse(json) {
  try {
    return JSON.parse(json)
  } catch {
    return null
  }
}

function isLabelMailbox(value) {
  return /^(Labels|Labels)(\/|$)/i.test((value || '').trim())
}

function isMoveTargetMailbox(value) {
  const mailbox = (value || '').trim()
  if (!mailbox || ['Folders', 'Labels', 'Labels'].includes(mailbox)) return false
  return !isLabelMailbox(mailbox)
}

function getMailboxNamespacePrefix(mailboxes, namespaceRoots) {
  const root = namespaceRoots.find((candidate) => (
    Array.isArray(mailboxes)
    && mailboxes.some((mailbox) => mailbox === candidate || mailbox.startsWith(`${candidate}/`))
  ))
  return root ? `${root}/` : ''
}

function applyMailboxNamespace(name, prefix) {
  const trimmed = (name || '').trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return ''
  if (!prefix || trimmed.startsWith(prefix)) return trimmed
  return `${prefix}${trimmed}`
}

export default function DetachedMailWindow() {
  const [windowLabel, setWindowLabel] = useState('')
  const [data, setData] = useState(null)
  const [mailContent, setMailContent] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [folders, setFolders] = useState([])
  const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false)
  const [movePopoverStyle, setMovePopoverStyle] = useState(null)
  const submenuScrollRef = useRef(null)
  const moveMenuRef = useRef(null)

  const accountId = data?.accountId
  const mail = data?.mail
  const mailbox = data?.mailbox
  const preferOffline = !!data?.preferOffline

  const subject = useMemo(() => mailContent?.subject || mail?.subject || '(No Subject)', [mailContent, mail])
  const fromLine = useMemo(() => {
    if (!mail) return '-'
    if (mailContent?.from_name && mailContent?.from_address) {
      return `${mailContent.from_name} <${mailContent.from_address}>`
    }
    return mail?.address || mail?.name || '-'
  }, [mail, mailContent])
  const readToggleLabel = mail?.seen === true ? 'Unread' : 'Read'
  const moveFolderOptions = useMemo(
    () => folders.filter(isMoveTargetMailbox),
    [folders],
  )

  const patchMail = (patch) => {
    setData((prev) => (
      prev?.mail ? { ...prev, mail: { ...prev.mail, ...patch } } : prev
    ))
  }

  const syncPopoverPosition = useCallback((menuRef, setStyle) => {
    const node = menuRef.current
    if (!node) {
      setStyle(null)
      return
    }

    const rect = node.getBoundingClientRect()
    const estimatedWidth = 220
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - estimatedWidth - 12),
    )

    setStyle({
      left: `${left}px`,
      top: `${rect.bottom + 6}px`,
    })
  }, [])

  const queueAction = async (actionType, payload = {}) => {
    if (!accountId || !mail?.id) return
    await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        action_type: actionType,
        target_uid: mail.id,
        target_folder: mailbox || 'INBOX',
        payload,
      }),
    })
  }

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

  useEffect(() => {
    let active = true
    const detectLabel = async () => {
      try {
        const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
        const label = getCurrentWebviewWindow().label
        if (!active) return
        setWindowLabel(label)
      } catch {
        
      }
    }
    detectLabel()
    return () => { active = false }
  }, [])

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
      setError('Content loading timed out.')
      setLoading(false)
    }, 20000)
    setLoading(true)
    setError('')
    const mailboxParam = mailbox ? `?mailbox=${encodeURIComponent(mailbox)}` : ''
    const fetchContent = async () => {
      const primaryPath = preferOffline
        ? `/api/offline/${accountId}/local-content/${mail.id}${mailboxParam}`
        : `/api/mail/${accountId}/content/${mail.id}${mailboxParam}`
      const fallbackPath = preferOffline
        ? `/api/mail/${accountId}/content/${mail.id}${mailboxParam}`
        : `/api/offline/${accountId}/local-content/${mail.id}${mailboxParam}`

      const loadFromPath = async (path) => {
        const res = await fetch(apiUrl(path), { cache: 'no-store' })
        if (!res.ok) {
          let message = 'Content could not be loaded'
          try {
            const body = await res.json()
            if (typeof body?.error === 'string' && body.error.trim()) {
              message = body.error
            }
          } catch {
            
          }
          throw new Error(message)
        }
        return res.json()
      }

      try {
        return await loadFromPath(primaryPath)
      } catch (primaryError) {
        if (primaryPath === fallbackPath) {
          throw primaryError
        }
        return loadFromPath(fallbackPath)
      }
    }

    fetchContent()
      .then((json) => {
        if (!active) return
        clearTimeout(timeoutId)
        setMailContent(json)
        setLoading(false)
      })
      .catch((err) => {
        if (!active) return
        clearTimeout(timeoutId)
        setError(err?.message || 'Unknown error')
        setLoading(false)
      })
    return () => {
      active = false
      clearTimeout(timeoutId)
    }
  }, [accountId, mail, mailContent, mailbox, preferOffline])

  useEffect(() => {
    if (!accountId) return
    let active = true
    const loadFolders = async () => {
      try {
        let res = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' })
        if (res.ok && active) {
          const json = await res.json()
          const normalized = normalizeMailboxResponse(json)
          setFolders(normalized.allMailboxes)
        }
        res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), { cache: 'no-store' })
        if (res.ok && active) {
          const json = await res.json()
          const normalized = normalizeMailboxResponse(json)
          setFolders(normalized.allMailboxes)
        }
      } catch {
        
      }
    }
    loadFolders()
    return () => { active = false }
  }, [accountId])

  useEffect(() => {
    if (!mail?.id || mail.seen === true || loading) return
    queueAction('mark_read').then(() => patchMail({ seen: true })).catch(() => {})
  }, [loading, mail?.id, mail?.seen])

  useEffect(() => {
    if (!isMoveMenuOpen) {
      setMovePopoverStyle(null)
      return
    }

    const sync = () => {
      syncPopoverPosition(moveMenuRef, setMovePopoverStyle)
    }

    const frameId = window.requestAnimationFrame(sync)
    const scrollNode = submenuScrollRef.current

    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    scrollNode?.addEventListener('scroll', sync)

    return () => {
      window.cancelAnimationFrame(frameId)
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
      scrollNode?.removeEventListener('scroll', sync)
    }
  }, [isMoveMenuOpen, syncPopoverPosition])

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

  const createMailbox = async (name) => {
    const mailboxName = (name || '').trim()
    if (!accountId || !mailboxName) return false
    try {
      const res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: mailboxName }),
      })
      if (!res.ok) return false
      setFolders((prev) => (prev.includes(mailboxName) ? prev : [...prev, mailboxName]))
      return true
    } catch {
      return false
    }
  }

  const openMailto = (params) => {
    const search = new URLSearchParams()
    Object.entries(params).forEach(([key, value]) => {
      if (value) search.set(key, value)
    })
    window.location.href = `mailto:${params.to || ''}?${search.toString()}`
  }

  const buildQuotedBody = () => {
    const body = mailContent?.plain_body || '(No content)'
    return [
      '',
      '',
      `From: ${fromLine}`,
      `Subject: ${subject}`,
      '',
      body,
    ].join('\n')
  }

  const handleDelete = async () => {
    await queueAction('delete')
    closeWindow()
  }

  const handleMove = async (destination) => {
    await queueAction('move', { destination })
    closeWindow()
  }

  const handleReply = () => {
    openMailto({
      to: mail?.address || '',
      subject: `Re: ${subject}`,
      body: buildQuotedBody(),
    })
  }

  const handleForward = () => {
    openMailto({
      subject: `Fwd: ${subject}`,
      body: buildQuotedBody(),
    })
  }

  const handleReadToggle = async () => {
    const nextSeen = mail?.seen !== true
    await queueAction(nextSeen ? 'mark_read' : 'mark_unread')
    patchMail({ seen: nextSeen })
  }

  const handleCreateFolderAndMove = async () => {
    const name = window.prompt('New folder name')
    if (!name) return
    const mailboxName = applyMailboxNamespace(name, getMailboxNamespacePrefix(folders, ['Folders']))
    const created = await createMailbox(mailboxName)
    if (created) {
      await handleMove(mailboxName)
    }
  }

  if (!mail || !accountId) {
    return (
      <div className="startup-router">
        <p>Email data not found for this window.</p>
        <div className="startup-router__actions">
          <button type="button" onClick={closeWindow}>Close</button>
        </div>
      </div>
    )
  }

  return (
    <div className="dashboard-page" style={{ height: '100vh' }}>
      <div className="db-navbar">
        <div className="db-logo-icon"><img src="../icon/guvercin-textless-unplanned.svg" alt="Guvercin" style={{width: '24px', height: '24px'}} /></div>
        <span className="db-logo-text">Guvercin</span>
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button className="db-icon-btn" title="Close" onClick={closeWindow}>✕</button>
        </div>
      </div>

      <div className="db-section-area">
        <div className="db-right-panel" style={{ flex: 1 }}>
          <div className="db-submenu">
            <div className="db-submenu-scroll" ref={submenuScrollRef}>
            <ul>
              <li><button type="button" onClick={handleDelete}>🗑️ Delete</button></li>
              <li><button type="button" onClick={() => handleMove('Trash')}>🗃️ Move to Trash</button></li>
              <li><button type="button" onClick={() => handleMove('Archive')}>📦 Archive</button></li>
              <li><button type="button" onClick={handleReply}>↩️ Reply</button></li>
              <li><button type="button" onClick={handleForward}>➡️ Forward</button></li>
              <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                <button
                  type="button"
                  className={isMoveMenuOpen ? 'submenu-open' : ''}
                  onClick={() => setIsMoveMenuOpen((prev) => !prev)}
                >
                  📁 Move
                </button>
                {isMoveMenuOpen && (
                  <div 
                    className="db-submenu-popover" 
                    style={movePopoverStyle || undefined}
                    onWheel={(e) => e.stopPropagation()}
                  >
                    {moveFolderOptions.map((folder) => (
                      <button key={folder} type="button" className="db-submenu-popover__item" onClick={() => handleMove(folder)}>
                        {folder}
                      </button>
                    ))}
                    <div className="db-submenu-popover__divider" />
                    <button type="button" className="db-submenu-popover__item" onClick={handleCreateFolderAndMove}>
                      + New Folder
                    </button>
                  </div>
                )}
              </li>
              <li><button type="button" onClick={handleReadToggle}>👁️ {readToggleLabel}</button></li>
            </ul>
            </div>
          </div>
          {loading ? (
            <div className="db-loading" style={{ paddingTop: 60 }}>
              <div className="db-spinner" />
              Loading content...
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
              <div className="db-mail-meta"><strong>From:</strong> {fromLine}</div>
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
                <div className="db-mail-body">{mailContent?.plain_body || '(No content)'}</div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
