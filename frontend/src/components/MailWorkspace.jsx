import { useState, useEffect, useCallback, useRef } from 'react'
import Avatar from './Avatar.jsx'

const FOLDER_MAP = {
  INBOX: { icon: <img src="/img/icons/inbox.svg" className="svg-icon-inline" />, href: '#inbox' },
  'Inbox': { icon: <img src="/img/icons/inbox.svg" className="svg-icon-inline" />, href: '#inbox' },
  'Spam': { icon: <img src="/img/icons/spambox.svg" className="svg-icon-inline" />, href: '#junk' },
  Spam: { icon: <img src="/img/icons/spambox.svg" className="svg-icon-inline" />, href: '#junk' },
  Drafts: { icon: <img src="/img/icons/draft.svg" className="svg-icon-inline" />, href: '#drafts' },
  Drafts: { icon: <img src="/img/icons/draft.svg" className="svg-icon-inline" />, href: '#drafts' },
  'Sent Items': { icon: <img src="/img/icons/sentbox.svg" className="svg-icon-inline" />, href: '#sent' },
  Sent: { icon: <img src="/img/icons/sentbox.svg" className="svg-icon-inline" />, href: '#sent' },
  'Trash': { icon: <img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" />, href: '#deleted' },
  Trash: { icon: <img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" />, href: '#deleted' },
  Archive: { icon: <img src="/img/icons/archive.svg" className="svg-icon-inline" />, href: '#archive' },
  Archive: { icon: <img src="/img/icons/archive.svg" className="svg-icon-inline" />, href: '#archive' },
}

function folderIcon(name) {
  return FOLDER_MAP[name]?.icon ?? <img src="/img/icons/inbox.svg" className="svg-icon-inline" />
}

function getShortTime() {
  const now = new Date()
  return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
}

export default function MailWorkspace({ accountId, email }) {
  const [connected, setConnected] = useState(false)
  const [folders, setFolders] = useState([])
  const [selectedFolder, setSelectedFolder] = useState('INBOX')
  const [mails, setMails] = useState([])
  const [selectedMail, setSelectedMail] = useState(null)
  const [mailContent, setMailContent] = useState(null)
  const [loadingMails, setLoadingMails] = useState(false)
  const [loadingContent, setLoadingContent] = useState(false)
  const iframeRef = useRef(null)

  useEffect(() => {
    if (accountId) {
      setConnected(true)
    }
  }, [accountId])

  const loadFolders = useCallback(async () => {
    if (!accountId) return
    try {
      const response = await fetch(`/api/mail/${accountId}/mailboxes`)
      const data = await response.json()
      setFolders(data.mailboxes || [])
    } catch (err) {
      console.error(err)
    }
  }, [accountId])

  const loadMails = useCallback(
    async (folder) => {
      if (!accountId || !connected) return
      setLoadingMails(true)
      setMails([])
      setSelectedMail(null)
      setMailContent(null)
      try {
        const response = await fetch(
          `/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=1&per_page=50`,
        )
        const data = await response.json()
        setMails(data.mails || [])
      } catch (err) {
        console.error(err)
      } finally {
        setLoadingMails(false)
      }
    },
    [accountId, connected],
  )

  useEffect(() => {
    if (connected) {
      loadFolders()
    }
  }, [connected, loadFolders])

  useEffect(() => {
    if (connected) {
      loadMails(selectedFolder)
    }
  }, [connected, selectedFolder, loadMails])

  const openMail = async (mail) => {
    setSelectedMail(mail)
    setMailContent(null)
    setLoadingContent(true)
    try {
      const response = await fetch(`/api/mail/${accountId}/content/${mail.id}`)
      if (response.ok) {
        const data = await response.json()
        setMailContent(data)
      }
    } catch (err) {
      console.error(err)
    } finally {
      setLoadingContent(false)
    }
  }

  useEffect(() => {
    if (iframeRef.current && mailContent?.html_body) {
      const doc = iframeRef.current.contentDocument
      doc.open()
      doc.write(mailContent.html_body)
      doc.close()
    }
  }, [mailContent])

  return (
    <div className="db-mail-area">
      <div className="db-folder-panel">
        {connected ? (
          <>
            <div className="db-folder-header">
              <span className="db-folder-title">{email || 'Mailbox'}</span>
              <button className="db-folder-menu-btn"><img src="/img/icons/three-point.svg" className="svg-icon-inline" /></button>
            </div>
            <ul className="db-folder-list">
              {(folders.length > 0 ? folders : ['INBOX']).map((folder) => (
                <li
                  key={folder}
                  className={`db-folder-item${selectedFolder === folder ? ' selected' : ''}`}
                >
                  <a
                    onClick={(event) => {
                      event.preventDefault()
                      setSelectedFolder(folder)
                    }}
                  >
                    <span className="db-folder-icon">{folderIcon(folder)}</span>
                    {folder}
                  </a>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <div style={{ padding: '14px', color: '#999', fontSize: '13px' }}>No connection</div>
        )}
      </div>

      <div className="db-center-panel">
        <div className="db-mail-toolbar">
          <button className="db-mail-toolbar-btn">
            <span className="db-mail-toolbar-icon"><img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" /></span>
            Select
          </button>
          <button className="db-mail-toolbar-btn">
            <span className="db-mail-toolbar-icon"><img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline" /></span>
            Jump
          </button>
          <button className="db-mail-toolbar-btn">
            <span className="db-mail-toolbar-icon"><img src="/img/icons/filter.svg" className="svg-icon-inline" /></span>
            Filter
          </button>
          <button className="db-mail-toolbar-btn" onClick={() => loadMails(selectedFolder)}>
            <span className="db-mail-toolbar-icon"><img src="/img/icons/reload.svg" className="svg-icon-inline" /></span>
            Refresh
          </button>
        </div>

        {!connected ? (
          <div className="db-empty-state">
            <div className="db-empty-icon"><img src="/img/icons/inbox.svg" className="svg-icon-inline" /></div>
            <div className="db-empty-text">Connect first</div>
          </div>
        ) : loadingMails ? (
          <div className="db-loading">
            <div className="db-spinner" />
            Loading...
          </div>
        ) : mails.length === 0 ? (
          <div className="db-empty-state">
            <div className="db-empty-icon"><img src="/img/icons/inbox.svg" className="svg-icon-inline" /></div>
            <div className="db-empty-text">This folder is empty</div>
          </div>
        ) : (
          <ul className="db-mail-list">
            {mails.map((mail) => (
              <li
                key={mail.id}
                className={`db-mail-item${!mail.seen ? ' unread' : ''}${selectedMail?.id === mail.id ? ' selected' : ''}`}
                onClick={() => openMail(mail)}
              >
                <div
                  className="db-mail-avatar"
                  title={mail.name || mail.address || 'Unknown'}
                >
                  <Avatar
                    email={mail.address}
                    name={mail.name}
                    accountId={accountId}
                    size={36}
                  />
                </div>
                <div className="db-mail-item-content">
                  <span className="db-mail-sender">{mail.name || mail.address || 'Unknown'}</span>
                  <span className="db-mail-subject">{mail.subject || '(No Subject)'}</span>
                  <span className="db-mail-time">{getShortTime()}</span>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="db-right-panel">
        {!connected ? (
          <div className="db-loading" style={{ paddingTop: 100 }}>
            <div className="db-spinner" />
            Connecting to IMAP Server...
          </div>
        ) : !selectedMail ? (
          <div className="db-empty-state">
            <div className="db-empty-icon"><img src="/img/logo/guvercin-notext-nobackground.svg" alt="Guvercin" style={{width: '48px', height: '48px'}} /></div>
            <div className="db-empty-text">Select an email</div>
          </div>
        ) : loadingContent ? (
          <div className="db-loading" style={{ paddingTop: 60 }}>
            <div className="db-spinner" />
            Loading content...
          </div>
        ) : (
          <div className="db-mail-content">
            <div className="db-mail-content-subject">
              {mailContent?.subject || selectedMail.subject || '(No Subject)'}
            </div>
            <div className="db-mail-meta">
              <strong>From:</strong>{' '}
              {mailContent?.from_name
                ? `${mailContent.from_name} <${mailContent.from_address}>`
                : selectedMail.address}
            </div>
            {mailContent?.date && (
              <div className="db-mail-meta">
                <strong>Date:</strong> {mailContent.date}
              </div>
            )}
            <hr className="db-mail-divider" />
            {mailContent?.html_body ? (
              <div className="db-mail-body-html">
                <iframe ref={iframeRef} title="mail-content" sandbox="allow-same-origin" />
              </div>
            ) : (
              <div className="db-mail-body">{mailContent?.plain_body || '(No content)'}</div>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
