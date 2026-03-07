import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import { useOfflineSync } from '../context/OfflineSyncContext.jsx'
import './DashboardPage.css'

// ── Folder mappings ────────────────────
const FOLDER_MAP = {
    'INBOX': { icon: '📥', label: 'Inbox' },
    'Gelen Kutusu': { icon: '📥', label: 'Inbox' },
    'Starred': { icon: '⭐', label: 'Starred' },
    'Yıldızlı': { icon: '⭐', label: 'Starred' },
    'Snoozed': { icon: '🕒', label: 'Snoozed' },
    'Ertelenenler': { icon: '🕒', label: 'Snoozed' },
    'Sent': { icon: '✈️', label: 'Sent Items' },
    'Sent Items': { icon: '✈️', label: 'Sent Items' },
    'Gönderilmiş Öğeler': { icon: '✈️', label: 'Sent Items' },
    'Drafts': { icon: '📝', label: 'Drafts' },
    'Taslaklar': { icon: '📝', label: 'Drafts' },
    'Archive': { icon: '📦', label: 'Archive' },
    'Arşiv': { icon: '📦', label: 'Archive' },
    'Trash': { icon: '🗑️', label: 'Trash' },
    'Silinmiş Öğeler': { icon: '🗑️', label: 'Trash' },
    'Spam': { icon: '🚫', label: 'Spam' },
    'Junk': { icon: '🚫', label: 'Spam' },
    'Önemsiz E-posta': { icon: '🚫', label: 'Spam' },
    'All Mail': { icon: '📑', label: 'All Mail' },
    '[Gmail]/Tüm Postalar': { icon: '📑', label: 'All Mail' },
    '[Gmail]/All Mail': { icon: '📑', label: 'All Mail' },
}

function folderInfo(name) {
    const clean = name.replace(/^Folders\//i, '').replace(/^Labels\//i, '').replace(/^Etiketler\//i, '')
    return FOLDER_MAP[clean] || FOLDER_MAP[name] || { icon: '📁', label: clean }
}

function formatBytes(bytes) {
    if (!Number.isFinite(bytes) || bytes === 0) return '0 B'
    if (bytes < 1024) return `${bytes} B`
    const units = ['KB', 'MB', 'GB', 'TB']
    let index = 0
    while (bytes >= 1024 && index < units.length - 1) {
        bytes /= 1024
        index++
    }
    return `${bytes.toFixed(1)} ${units[index]}`
}

function attachmentUrl(accountId, uid, attachmentId, mailbox, online) {
    const path = online
        ? `/api/mail/${accountId}/content/${encodeURIComponent(uid)}/attachments/${attachmentId}`
        : `/api/offline/${accountId}/local-content/${encodeURIComponent(uid)}/attachments/${attachmentId}`
    return apiUrl(`${path}?mailbox=${encodeURIComponent(mailbox)}`)
}

function systemHour12Preference() {
    try {
        const resolved = new Intl.DateTimeFormat(undefined, { hour: 'numeric' }).resolvedOptions()
        if (typeof resolved.hour12 === 'boolean') return resolved.hour12
        if (typeof resolved.hourCycle === 'string') return resolved.hourCycle === 'h11' || resolved.hourCycle === 'h12'
        return undefined
    } catch {
        return undefined
    }
}

function useClock() {
    const [now, setNow] = useState(new Date())
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000)
        return () => clearInterval(timer)
    }, [])

    const hour12 = systemHour12Preference()
    const timeOptions = { hour: '2-digit', minute: '2-digit', second: '2-digit' }
    if (typeof hour12 === 'boolean') timeOptions.hour12 = hour12

    const timeStr = new Intl.DateTimeFormat(undefined, timeOptions).format(now)
    const dateStr = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit', year: 'numeric' }).format(now)
    return { time: timeStr, date: dateStr }
}

function CollapsedTab({ label, title, onClick }) {
    return (
        <button type="button" className="db-collapsed-tab" title={title} onClick={onClick}>
            <span className="db-collapsed-tab__label">{label}</span>
        </button>
    )
}

const DashboardPage = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { time, date } = useClock()
    const {
        networkOnline,
        backendReachable,
        imapReachable,
        smtpReachable,
        remoteMailAvailable,
        queueDepth,
        syncState,
        lastSyncAt,
        lastError,
        transfer,
        refreshStatus,
        flushQueue,
    } = useOfflineSync()

    const [activeSection, setActiveSection] = useState('mail')
    const [accountId, setAccountId] = useState(null)
    const [accountForm, setAccountForm] = useState({})
    const [email, setEmail] = useState('')

    const [connected, setConnected] = useState(false)
    const [connecting, setConnecting] = useState(false)
    const [folders, setFolders] = useState([])
    const [selectedFolder, setSelectedFolder] = useState('INBOX')
    const [mails, setMails] = useState([])
    const [cacheMailTotal, setCacheMailTotal] = useState(null)
    const [remoteMailTotal, setRemoteMailTotal] = useState(null)
    const [selectedMail, setSelectedMail] = useState(null)
    const [mailContent, setMailContent] = useState(null)
    const [loadingMails, setLoadingMails] = useState(false)
    const [loadingContent, setLoadingContent] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [perPage, setPerPage] = useState(50)
    const [composeOpen, setComposeOpen] = useState(false)
    const [composeForm, setComposeForm] = useState({ to: '', cc: '', bcc: '', subject: '', body: '' })

    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
    const [isMailFullscreen, setIsMailFullscreen] = useState(false)
    const [isSyncing, setIsSyncing] = useState(false)

    const accountButtonRef = useRef(null)
    const accountMenuRef = useRef(null)
    const iframeRef = useRef(null)
    const syncAbortRef = useRef(null)
    const isSyncingRef = useRef(false)
    const nextMailWindowId = useRef(0)
    const prevCanUseRemoteMailRef = useRef(false)
    const lastConnectAttemptAtRef = useRef(0)
    const canUseRemoteMail = backendReachable && networkOnline && (remoteMailAvailable || connected)
    const totalCount = canUseRemoteMail
        ? (remoteMailTotal ?? cacheMailTotal ?? 0)
        : (cacheMailTotal ?? 0)
    const perPageNum = Math.max(1, Number.parseInt(perPage, 10) || 50)
    const maxPage = Math.max(1, Math.ceil(totalCount / perPageNum))

    useEffect(() => {
        const storedId = localStorage.getItem('current_account_id')
        if (storedId) {
            setAccountId(storedId)
            fetchAccount(storedId)
            refreshStatus(storedId)
        } else {
            navigate('/login')
        }
    }, [navigate, refreshStatus])

    const fetchAccount = async (id) => {
        try {
            const res = await fetch(apiUrl('/api/auth/accounts'))
            const data = await res.json()
            const accounts = Array.isArray(data?.accounts) ? data.accounts : []
            const acc = accounts.find((a) => a.account_id?.toString() === id.toString())
            if (acc) {
                setAccountForm(acc)
                setEmail(acc.email_address || '')
            }
        } catch {
            // noop
        }
    }

    const accountLabel = accountForm.display_name || accountForm.email_address || 'User'
    const accountEmailLabel = accountForm.email_address || ''

    const handleAccountButtonClick = () => setAccountMenuOpen(!accountMenuOpen)
    const closeAccountMenu = () => setAccountMenuOpen(false)

    useEffect(() => {
        const handleClickOutside = (event) => {
            if (accountMenuRef.current && !accountMenuRef.current.contains(event.target) &&
                accountButtonRef.current && !accountButtonRef.current.contains(event.target)) {
                closeAccountMenu()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const handleAccountSettings = () => {
        closeAccountMenu()
        navigate('/account-select')
    }
    const handleLogout = () => {
        closeAccountMenu()
        localStorage.removeItem('current_account_id')
        localStorage.removeItem('saved_account_form')
        localStorage.removeItem('saved_email')
        navigate('/login', { replace: true })
    }

    const ensureImapConnected = useCallback(async () => {
        if (!backendReachable || !networkOnline || !accountId) return false
        if (connected) return true
        if (connecting) return false
        setConnecting(true)
        try {
            const res = await fetch(apiUrl(`/api/mail/${accountId}/connect-stored`), { method: 'POST' })
            if (res.ok) {
                setConnected(true)
                refreshStatus(accountId)
                return true
            }
            return false
        } catch {
            return false
        } finally {
            setConnecting(false)
        }
    }, [accountId, backendReachable, connected, connecting, networkOnline, refreshStatus])

    const loadFolders = useCallback(async () => {
        if (!accountId || !backendReachable) return
        try {
            // Offline cache'den hızlıca yükle
            let res = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json()
                setFolders(data.mailboxes || [])
            }

            // Eğer online'yız, remote'tan da senkronizasyon yap
            if (networkOnline) {
                const ok = canUseRemoteMail || (await ensureImapConnected())
                if (!ok) return
                res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), { cache: 'no-store' })
                if (res.ok) {
                    const data = await res.json()
                    setFolders(data.mailboxes || [])
                }
            }
        } catch {
            setFolders([])
        }
    }, [accountId, backendReachable, canUseRemoteMail, ensureImapConnected, networkOnline])

    useEffect(() => {
        if (!backendReachable || !networkOnline || !accountId || connected) return
        const attempt = async () => {
            if (connecting) return
            const now = Date.now()
            if (now - lastConnectAttemptAtRef.current < 15_000) return
            lastConnectAttemptAtRef.current = now
            await ensureImapConnected()
        }
        attempt()
        const timer = setInterval(attempt, 15_000)
        return () => clearInterval(timer)
    }, [accountId, backendReachable, connected, connecting, ensureImapConnected, networkOnline])

    const loadMailsFromCache = useCallback(async (folder, page, limit) => {
        if (!accountId || !backendReachable) return
        try {
            const res = await fetch(
                apiUrl(`/api/offline/${accountId}/local-list?mailbox=${encodeURIComponent(folder)}&page=${page}&per_page=${limit}`),
                { cache: 'no-store' },
            )
            if (res.ok) {
                const data = await res.json()
                setMails(data.mails || [])
                setCacheMailTotal(typeof data.total_count === 'number' ? data.total_count : null)
                return true
            }
        } catch {
            setMails([])
        }
        return false
    }, [accountId, backendReachable])

    const syncMailsFromRemote = useCallback(async (folder, page, limit) => {
        if (!accountId || !canUseRemoteMail) return
        if (isSyncingRef.current) return // prevent concurrent syncs
        isSyncingRef.current = true
        setIsSyncing(true)
        try {
            const abort = new AbortController()
            syncAbortRef.current = abort
            const res = await fetch(
                apiUrl(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=${page}&per_page=${limit}`),
                { cache: 'no-store', signal: abort.signal },
            )
            if (res.ok && abort.signal.aborted === false) {
                const data = await res.json()
                setMails(data.mails || [])
                setRemoteMailTotal(typeof data.total_count === 'number' ? data.total_count : null)
            }
        } catch (err) {
            if (err.name !== 'AbortError') {
                console.error('Sync error:', err)
            }
        } finally {
            isSyncingRef.current = false
            setIsSyncing(false)
            syncAbortRef.current = null
        }
    }, [accountId, canUseRemoteMail])

    const loadMails = useCallback(
        async (folder, page, limit, forceRemote = false) => {
            if (!accountId || !backendReachable) return
            setLoadingMails(true)
            try {
                // Sync abort işi varsa iptal et
                if (syncAbortRef.current) {
                    syncAbortRef.current.abort()
                }

                if (forceRemote || canUseRemoteMail) {
                    // Direkt remote'dan yükle (force refresh)
                    const res = await fetch(
                        apiUrl(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=${page}&per_page=${limit}`),
                        { cache: 'no-store' },
                    )
                    if (res.ok) {
                        const data = await res.json()
                        setMails(data.mails || [])
                        setRemoteMailTotal(typeof data.total_count === 'number' ? data.total_count : null)
                    } else {
                        const loaded = await loadMailsFromCache(folder, page, limit)
                        if (!loaded) setMails([])
                    }
                } else {
                    // Offline: cache'den yükle
                    await loadMailsFromCache(folder, page, limit)
                }
            } catch {
                const loaded = await loadMailsFromCache(folder, page, limit)
                if (!loaded) setMails([])
            } finally {
                setLoadingMails(false)
            }
        },
        [accountId, backendReachable, canUseRemoteMail, loadMailsFromCache],
    )

    useEffect(() => {
        const prev = prevCanUseRemoteMailRef.current
        prevCanUseRemoteMailRef.current = canUseRemoteMail
        if (!prev && canUseRemoteMail && activeSection === 'mail' && backendReachable) {
            loadFolders()
        }
    }, [activeSection, backendReachable, canUseRemoteMail, loadFolders])

    useEffect(() => {
        if (accountId && activeSection === 'mail' && backendReachable) loadFolders()
    }, [accountId, activeSection, backendReachable, loadFolders])

    useEffect(() => {
        if (folders.length > 0 && !folders.includes(selectedFolder)) {
            setSelectedFolder(folders[0])
        }
    }, [folders, selectedFolder])

    useEffect(() => {
        if (activeSection !== 'mail' || !backendReachable) return
        setCacheMailTotal(null)
        setRemoteMailTotal(null)
        setCurrentPage(1)
    }, [activeSection, backendReachable, selectedFolder, perPage])

    useEffect(() => {
        if (activeSection !== 'mail' || !backendReachable) return

        let cancelled = false
        const page = currentPage
        const limit = perPage
        const folder = selectedFolder

        loadMailsFromCache(folder, page, limit).then(() => {
            if (cancelled || !canUseRemoteMail) return
            loadMails(folder, page, limit, true)
        })

        return () => {
            cancelled = true
        }
    }, [activeSection, backendReachable, canUseRemoteMail, currentPage, selectedFolder, perPage, loadMails, loadMailsFromCache])

    const prefetchInlineAssets = useCallback(
        async (uid, mailbox) => {
            if (!accountId || !backendReachable || !networkOnline) return null
            try {
                const res = await fetch(
                    apiUrl(
                        `/api/offline/${accountId}/local-content/${uid}/prefetch-inline?mailbox=${encodeURIComponent(mailbox)}`,
                    ),
                    { method: 'POST', cache: 'no-store' },
                )
                if (!res.ok) return null
                const data = await res.json().catch(() => null)
                return data?.html_body || null
            } catch {
                return null
            }
        },
        [accountId, backendReachable, networkOnline],
    )

    const openMail = async (mail) => {
        setIsMailFullscreen(false)
        setSelectedMail(mail)
        setMailContent(null)
        setLoadingContent(true)
        try {
            const mailbox = selectedFolder || 'INBOX'
            let endpoint

            // Offline endpoint'i dene (cache)
            endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
            let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })

            // Eğer offline cache'de yoksa ve online'yız, remote'tan çek
            if (!res.ok && canUseRemoteMail) {
                endpoint = `/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            }

            if (res.ok) {
                const data = await res.json()
                setMailContent(data)

                // Best-effort: cache and rewrite external inline images for offline use.
                prefetchInlineAssets(mail.id, mailbox).then((html) => {
                    if (!html) return
                    setMailContent((prev) => (prev && prev.id === mail.id ? { ...prev, html_body: html } : prev))
                })
            }
        } catch {
            // noop
        }
        setLoadingContent(false)
    }

    const queueAction = async (actionType, targetUid, payload = {}) => {
        if (!accountId || !backendReachable) return
        await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action_type: actionType,
                target_uid: targetUid || null,
                target_folder: selectedFolder || 'INBOX',
                payload,
            }),
        })
        refreshStatus(accountId)
        if (networkOnline) {
            flushQueue(accountId)
        }
    }

    const removeMailOptimistic = async (mail) => {
        setMails((prev) => prev.filter((m) => m.id !== mail.id))
        await queueAction('delete', mail.id)
    }

    const moveMail = async (mail, destination) => {
        setMails((prev) => prev.filter((m) => m.id !== mail.id))
        await queueAction('move', mail.id, { destination })
    }

    const sendComposedMail = async () => {
        if (!composeForm.to.trim()) return
        await queueAction('send', null, {
            from: email || accountEmailLabel,
            to: composeForm.to.split(',').map((s) => s.trim()).filter(Boolean),
            cc: composeForm.cc.split(',').map((s) => s.trim()).filter(Boolean),
            bcc: composeForm.bcc.split(',').map((s) => s.trim()).filter(Boolean),
            subject: composeForm.subject,
            body: composeForm.body,
        })
        setComposeOpen(false)
        setComposeForm({ to: '', cc: '', bcc: '', subject: '', body: '' })
    }

    const detachMailToWindow = async () => {
        if (!selectedMail) return
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            nextMailWindowId.current += 1
            const mailWindowLabel = `mail-${nextMailWindowId.current}`
            const mailData = {
                mail: selectedMail,
                mailContent: mailContent,
                accountId: accountId,
                mailbox: selectedFolder || 'INBOX',
                preferOffline: !canUseRemoteMail,
            }

            await invoke('open_mail_window', {
                label: mailWindowLabel,
                mailDataJson: JSON.stringify(mailData),
            })
            setSelectedMail(null)
            setMailContent(null)
        } catch (e) {
            console.error('Failed to open mail window:', e)
        }
    }

    const detachMailToWindowFromList = async (e, mail) => {
        e.stopPropagation()
        try {
            // First we need to fetch the content because it's not loaded yet
            const mailbox = selectedFolder || 'INBOX'
            let content = null
            let endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
            let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            if (!res.ok && canUseRemoteMail) {
                endpoint = `/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            }
            if (res.ok) content = await res.json()

            const { invoke } = await import('@tauri-apps/api/core')
            nextMailWindowId.current += 1
            const mailWindowLabel = `mail-${nextMailWindowId.current}`
            const mailData = {
                mail: mail,
                mailContent: content,
                accountId: accountId,
                mailbox: mailbox,
                preferOffline: !canUseRemoteMail,
            }

            await invoke('open_mail_window', {
                label: mailWindowLabel,
                mailDataJson: JSON.stringify(mailData),
            })
            // Clear selections in the main view if they match this mail
            if (selectedMail?.id === mail.id) {
                setSelectedMail(null)
                setMailContent(null)
            }
        } catch (error) {
            console.error('Failed to open mail window from list:', error)
        }
    }

    const toggleMailFullscreen = () => {
        setIsMailFullscreen((prev) => {
            const next = !prev
            if (next) {
                setSelectedMail(null)
            }
            return next
        })
    }

    // ESC key handler
    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape' && isMailFullscreen) {
                setIsMailFullscreen(false)
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [isMailFullscreen])

    const getShortTime = (dateValue) => {
        if (!dateValue) return ''
        const dt = new Date(dateValue)
        if (Number.isNaN(dt.getTime())) return ''
        const now = new Date()
        const sameDay = dt.getFullYear() === now.getFullYear()
            && dt.getMonth() === now.getMonth()
            && dt.getDate() === now.getDate()
        const hour12 = systemHour12Preference()
        const timeOptions = { hour: '2-digit', minute: '2-digit' }
        if (typeof hour12 === 'boolean') timeOptions.hour12 = hour12
        const timeStr = new Intl.DateTimeFormat(undefined, timeOptions).format(dt)
        if (sameDay) {
            return timeStr
        }
        const dateStr = new Intl.DateTimeFormat(undefined, { month: '2-digit', day: '2-digit' }).format(dt)
        return `${dateStr} ${timeStr}`
    }

    const formatTransfer = (p) => {
        if (!p) return null
        const mailbox = p.mailbox ? ` (${p.mailbox})` : ''
        const detail = p.detail ? ` - ${p.detail}` : ''
        if (Number.isFinite(p.total) && Number.isFinite(p.done)) {
            const left = Number.isFinite(p.remaining) ? `, ${p.remaining} left` : ''
            return `${p.direction}: ${p.resource}${mailbox} ${p.done}/${p.total}${left}${detail}`
        }
        if (Number.isFinite(p.done)) {
            return `${p.direction}: ${p.resource}${mailbox} ${p.done}${detail}`
        }
        return `${p.direction}: ${p.resource}${mailbox}${detail}`
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
        <div className="dashboard-page">
            <div className="db-navbar">
                <button className="db-logo-btn">
                    <div className="db-logo-icon">🕊️</div>
                    <span className="db-logo-text">Guvercin</span>
                </button>
                <div className="db-search">
                    <input type="text" placeholder="Search..." />
                    <button className="db-search-btn">🔍</button>
                </div>
                <div className="db-navbar-right">
                    <div className="db-clock">
                        <span className="db-clock-item">{time}</span>
                        <span className="db-clock-item">{date}</span>
                    </div>
                    <div className={`db-sync-indicator ${syncState === 'syncing' ? 'is-syncing' : ''}`}>
                        <button type="button" className="db-icon-btn db-sync-indicator__btn" aria-label="Sync and network status">
                            🌐
                            <span
                                className={`db-sync-indicator__dot ${canUseRemoteMail ? 'live' : 'offline'} ${syncState === 'syncing' ? 'syncing' : ''}`}
                                aria-hidden="true"
                            />
                        </button>
                        <div className="db-sync-popover" role="tooltip">
                            <div className="db-sync-popover__title">Network</div>
                            <div className="db-sync-popover__row">Mode: {canUseRemoteMail ? 'Live' : 'Offline Cache'}</div>
                            <div className="db-sync-popover__row">Sync: {syncState}</div>
                            <div className="db-sync-popover__row">Queue: {queueDepth}</div>
                            <div className="db-sync-popover__row">Browser: {networkOnline ? 'online' : 'offline'}</div>
                            <div className="db-sync-popover__row">Backend: {backendReachable ? 'reachable' : 'down'}</div>
                            <div className="db-sync-popover__row">IMAP: {imapReachable ? 'reachable' : 'down'}</div>
                            <div className="db-sync-popover__row">SMTP: {smtpReachable ? 'configured' : 'not set'}</div>
                            {lastSyncAt && <div className="db-sync-popover__row">Last sync: {lastSyncAt}</div>}
                            {formatTransfer(transfer?.receiving) && <div className="db-sync-popover__row">{formatTransfer(transfer.receiving)}</div>}
                            {formatTransfer(transfer?.sending) && <div className="db-sync-popover__row">{formatTransfer(transfer.sending)}</div>}
                            {lastError && <div className="db-sync-popover__error">Error: {lastError}</div>}
                        </div>
                    </div>
                    <button className="db-icon-btn" title="Notifications">🔔</button>
                    <button className="db-icon-btn" title="Settings">⚙️</button>
                    <div className="db-account-wrapper">
                        <button className="db-account-btn" ref={accountButtonRef} onClick={handleAccountButtonClick}>
                            <span className="db-account-btn__icon">👤</span>
                        </button>
                        {accountMenuOpen && (
                            <div className="account-popover" ref={accountMenuRef}>
                                <div className="account-popover__avatar">👤</div>
                                <div className="account-popover__name">{accountLabel}</div>
                                <div className="account-popover__email">{accountEmailLabel}</div>
                                <div className="account-popover__actions">
                                    <button type="button" className="account-popover__btn" onClick={handleAccountSettings}>{t('Account Settings')}</button>
                                    <button type="button" className="account-popover__btn account-popover__btn--danger" onClick={handleLogout}>{t('Logout')}</button>
                                </div>
                            </div>
                        )}
                    </div>
                </div>
            </div>

            <div className="db-main-container">
                <div className="db-sidebar">
                    {[
                        { key: 'mail', icon: '✉️', label: t('Mail') },
                        { key: 'calendar', icon: '📅', label: t('Calendar') },
                        { key: 'contacts', icon: '👥', label: t('Contacts') },
                        { key: 'todo', icon: '✅', label: t('Todo') }
                    ].map((item) => (
                        <button
                            key={item.key}
                            className={`db-sidebar-btn ${activeSection === item.key ? 'active' : ''}`}
                            title={item.label}
                            onClick={() => setActiveSection(item.key)}
                        >
                            {item.icon}
                        </button>
                    ))}
                </div>

                <div className="db-content-area">


                    <div className="db-section-area">
                        {activeSection === 'mail' && (
	                            <MailSection
	                                accountId={accountId}
	                                backendReachable={backendReachable}
	                                networkOnline={networkOnline}
	                                ensureImapConnected={ensureImapConnected}
                                folders={folders}
                                selectedFolder={selectedFolder}
                                setSelectedFolder={setSelectedFolder}
                                mails={mails}
                                selectedMail={selectedMail}
                                setSelectedMail={setSelectedMail}
                                mailContent={mailContent}
                                setMailContent={setMailContent}
                                loadingMails={loadingMails}
                                loadingContent={loadingContent}
                                connecting={connecting}
                                loadMails={loadMails}
                                loadMailsFromCache={loadMailsFromCache}
                                syncMailsFromRemote={syncMailsFromRemote}
                                isSyncing={isSyncing}
                                openMail={openMail}
                                detachMailToWindow={detachMailToWindow}
                                detachMailToWindowFromList={detachMailToWindowFromList}
                                iframeRef={iframeRef}
                                getShortTime={getShortTime}
	                                currentPage={currentPage}
	                                setCurrentPage={setCurrentPage}
	                                maxPage={maxPage}
	                                perPage={perPage}
	                                setPerPage={setPerPage}
	                                isMailFullscreen={isMailFullscreen}
	                                toggleMailFullscreen={toggleMailFullscreen}
	                                removeMailOptimistic={removeMailOptimistic}
                                moveMail={moveMail}
                                canUseRemoteMail={canUseRemoteMail}
                                composeOpen={composeOpen}
                                setComposeOpen={setComposeOpen}
                                composeForm={composeForm}
                                setComposeForm={setComposeForm}
                                sendComposedMail={sendComposedMail}
                            />
                        )}
                        {activeSection === 'calendar' && <CalendarSection />}
                        {activeSection === 'contacts' && <ContactsSection />}
                        {activeSection === 'todo' && <TodoSection />}
                    </div>
                </div>
            </div>
        </div>
    )
}

function MailSection({
    accountId,
    backendReachable,
    networkOnline,
    ensureImapConnected,
    folders, selectedFolder, setSelectedFolder, mails,
    selectedMail, setSelectedMail, mailContent, setMailContent, loadingMails, loadingContent,
    connecting, loadMails, loadMailsFromCache, syncMailsFromRemote, isSyncing,
    openMail, detachMailToWindow, detachMailToWindowFromList, iframeRef, getShortTime,
    currentPage, setCurrentPage, maxPage, perPage, setPerPage,
    isMailFullscreen, toggleMailFullscreen,
    removeMailOptimistic, moveMail,
    canUseRemoteMail, composeOpen, setComposeOpen, composeForm, setComposeForm, sendComposedMail,
}) {
    const { t } = useTranslation()
    const hasFolderAccess = folders.length > 0
    const hasMailSource = canUseRemoteMail || hasFolderAccess
    const [activeRibbonTab, setActiveRibbonTab] = useState('home')
    const [expandedFolders, setExpandedFolders] = useState(['INBOX', 'Folders', 'Labels', 'Etiketler'])
    const [folderWidth, setFolderWidth] = useState(240)
    const [listWidth, setListWidth] = useState(460)
    const [minListWidth, setMinListWidth] = useState(360)
    const [foldersHidden, setFoldersHidden] = useState(false)
    const [mailsHidden, setMailsHidden] = useState(false)
    const [selectMode, setSelectMode] = useState(false)
    const [selectedMailIds, setSelectedMailIds] = useState(() => new Set())
    const [isPerPageOpen, setIsPerPageOpen] = useState(false)
    const [attachmentsExpanded, setAttachmentsExpanded] = useState(true)
    const [layoutCols, setLayoutCols] = useState(1)
    const displayCols = isMailFullscreen ? layoutCols : 1

    const sortedMails = useMemo(() => {
        const copy = Array.isArray(mails) ? mails.slice() : []
        const dateMs = (m) => {
            const t = Date.parse(m?.date || '')
            return Number.isFinite(t) ? t : 0
        }
        const uidNum = (m) => {
            const n = Number.parseInt(m?.id ?? '', 10)
            return Number.isFinite(n) ? n : 0
        }
        copy.sort((a, b) => {
            const d = dateMs(b) - dateMs(a)
            if (d !== 0) return d
            return uidNum(b) - uidNum(a)
        })
        return copy
    }, [mails])

    const formatMailDateLong = (dateValue) => {
        if (!dateValue) return ''
        const dt = new Date(dateValue)
        if (Number.isNaN(dt.getTime())) return dateValue
        const hour12 = systemHour12Preference()
        const options = {
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            timeZoneName: 'short',
        }
        if (typeof hour12 === 'boolean') options.hour12 = hour12
        // Uses local timezone, but preserves the correct instant from the RFC2822 date (UTC-aware).
        return new Intl.DateTimeFormat(undefined, options).format(dt)
    }

    const perPageRef = useRef(null)
    const isResizingFolder = useRef(false)
    const isResizingList = useRef(false)
    const mailToolbarRef = useRef(null)

    const recomputeMinListWidth = useCallback(() => {
        const el = mailToolbarRef.current
        if (!el) return

        // NOTE: scrollWidth is at least clientWidth. When the panel is wide,
        // scrollWidth grows with it and causes the "min width" to chase the current
        // width forever. Instead, measure the real content end via children bounds.
        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        const padRight = parseFloat(style.paddingRight) || 0

        let maxRight = 0
        for (const child of Array.from(el.children)) {
            const cr = child.getBoundingClientRect()
            maxRight = Math.max(maxRight, cr.right - rect.left)
        }

        // Small buffer for borders/subpixel rounding.
        const needed = Math.ceil(maxRight + padRight + 2)
        setMinListWidth((prev) => (prev === needed ? prev : needed))
        setListWidth((prev) => (prev < needed ? needed : prev))
    }, [])

    // ── Tab system ──────────────────────────────────
    const [tabs, setTabs] = useState([])
    const [activeTabId, setActiveTabId] = useState(null) // null = inbox view
    const [tabContents, setTabContents] = useState({}) // tabId -> mailContent
    const [loadingTab, setLoadingTab] = useState(false)
    const tabIframeRefs = useRef({})
    const nextTabId = useRef(0)

    const openMailInTab = async (mail, existingContent) => {
        nextTabId.current += 1
        const tabId = `tab-${nextTabId.current}`
        let content = existingContent
        if (!content) {
            setLoadingTab(true)
            try {
                const mailbox = selectedFolder || 'INBOX'
                let endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
                if (!res.ok && canUseRemoteMail) {
                    endpoint = `/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                    res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
                }
                if (res.ok) {
                    content = await res.json()
                    const html = await prefetchInlineAssets(mail.id, mailbox)
                    if (html && content) {
                        content = { ...content, html_body: html }
                    }
                }
            } catch {
                // noop
            }
            setLoadingTab(false)
        }
        setTabs(prev => [...prev, { id: tabId, mail, mailbox: selectedFolder || 'INBOX' }])
        setTabContents(prev => ({ ...prev, [tabId]: content }))
        setActiveTabId(tabId)

        // Clear selection in main list when opened in tab
        setSelectedMail(null)
        setMailContent(null)
    }

    const closeTab = (e, tabId) => {
        e.stopPropagation()
        setTabs(prev => {
            const remaining = prev.filter(t => t.id !== tabId)
            return remaining
        })
        setTabContents(prev => { const n = { ...prev }; delete n[tabId]; return n })
        if (activeTabId === tabId) setActiveTabId(null)
    }

    // Write html into tab iframes after render
    useEffect(() => {
        if (!activeTabId) return
        const ref = tabIframeRefs.current[activeTabId]
        const content = tabContents[activeTabId]
        if (ref && content?.html_body) {
            const doc = ref.contentDocument
            doc.open()
            doc.write(content.html_body)
            doc.close()
        }
    }, [activeTabId, tabContents])

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (perPageRef.current && !perPageRef.current.contains(e.target)) {
                setIsPerPageOpen(false)
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (isResizingFolder.current) {
                // 48 is the app sidebar width.
                const newWidth = Math.max(160, Math.min(500, e.clientX - 48))
                setFolderWidth(newWidth)
            } else if (isResizingList.current) {
                const newWidth = Math.max(minListWidth, Math.min(900, e.clientX - 48 - folderWidth))
                setListWidth(newWidth)
            }
        }
        const handleMouseUp = () => {
            isResizingFolder.current = false
            isResizingList.current = false
            document.body.classList.remove('resizing')
        }
        document.addEventListener('mousemove', handleMouseMove)
        document.addEventListener('mouseup', handleMouseUp)
        return () => {
            document.removeEventListener('mousemove', handleMouseMove)
            document.removeEventListener('mouseup', handleMouseUp)
        }
    }, [folderWidth, minListWidth])

    // Auto-compute the minimum width of the mails panel based on toolbar content,
    // so the toolbar never needs horizontal scrolling.
    useEffect(() => {
        const el = mailToolbarRef.current
        if (!el || typeof ResizeObserver === 'undefined') return

        const frame = window.requestAnimationFrame(recomputeMinListWidth)
        const ro = new ResizeObserver(() => {
            window.requestAnimationFrame(recomputeMinListWidth)
        })
        ro.observe(el)
        return () => {
            window.cancelAnimationFrame(frame)
            ro.disconnect()
        }
    }, [recomputeMinListWidth])

    // Recompute when toolbar content changes without a size change (e.g. fullscreen toggles layout buttons).
    useEffect(() => {
        const frame = window.requestAnimationFrame(recomputeMinListWidth)
        return () => window.cancelAnimationFrame(frame)
    }, [recomputeMinListWidth, isMailFullscreen, displayCols])

    const toggleMailSelected = (mailId) => {
        setSelectedMailIds((prev) => {
            const next = new Set(prev)
            if (next.has(mailId)) next.delete(mailId)
            else next.add(mailId)
            return next
        })
    }

    const buildTree = (list) => {
        const tree = []
        list.forEach(path => {
            const parts = path.split('/')
            let currentLevel = tree
            parts.forEach((part, index) => {
                let existing = currentLevel.find(item => item.name === part)
                if (!existing) {
                    existing = {
                        name: part,
                        fullPath: parts.slice(0, index + 1).join('/'),
                        children: []
                    }
                    currentLevel.push(existing)
                }
                currentLevel = existing.children
            })
        })

        const priorityMap = {
            'INBOX': 1, 'GELEN KUTUSU': 1,
            'STARRED': 2, 'YILDIZLI': 2,
            'SNOOZED': 3, 'ERTELENENLER': 3,
            'SENT': 4, 'SENT ITEMS': 4, 'GÖNDERİLMİŞ ÖĞELER': 4, 'GÖNDERİLMİŞ POSTALAR': 4,
            'ALL MAIL': 5, 'TÜM POSTALAR': 5,
            'DRAFTS': 6, 'TASLAKLAR': 6,
            'ARCHIVE': 7, 'ARŞİV': 7,
            'TRASH': 8, 'SILINMIŞ ÖĞELER': 8, 'ÇÖP KUTUSU': 8,
            'SPAM': 9, 'ÖNEMSIZ E-POSTA': 9, 'JUNK': 9,
            'FOLDERS': 10,
            'LABELS': 20,
            'ETIKETLER': 21
        }

        const sortFn = (a, b) => {
            const pa = priorityMap[a.name.toUpperCase()] || 999
            const pb = priorityMap[b.name.toUpperCase()] || 999
            if (pa !== pb) return pa - pb
            return a.name.localeCompare(b.name)
        }

        const sortTree = (nodes) => {
            nodes.sort(sortFn)
            nodes.forEach(node => {
                if (node.children.length > 0) sortTree(node.children)
            })
        }

        sortTree(tree)
        return tree
    }

    const toggleExpand = (e, path) => {
        e.stopPropagation()
        setExpandedFolders(prev =>
            prev.includes(path) ? prev.filter(p => p !== path) : [...prev, path]
        )
    }

    const folderTree = buildTree(folders)

    const renderFolderItem = (node, depth = 0) => {
        const info = folderInfo(node.fullPath)
        const isSelected = selectedFolder === node.fullPath
        const isExpanded = expandedFolders.includes(node.fullPath)
        const hasChildren = node.children.length > 0

        const isSection = depth === 0 && ['Folders', 'Labels', 'Etiketler'].includes(node.name)

        return (
            <div key={node.fullPath} className={`db-folder-node ${isSection ? 'db-folder-section' : ''}`}>
                <li className={`db-folder-item ${isSelected ? 'selected' : ''}`} style={{ paddingLeft: `${depth * 12}px` }}>
                    <div className="db-folder-item-content" onClick={() => setSelectedFolder(node.fullPath)}>
                        {hasChildren ? (
                            <span className={`db-folder-chevron ${isExpanded ? 'expanded' : ''}`} onClick={(e) => toggleExpand(e, node.fullPath)}>
                                ❯
                            </span>
                        ) : (
                            <span className="db-folder-chevron-placeholder" />
                        )}
                        <span className="db-folder-icon">{info.icon}</span>
                        <span className="db-folder-text">{info.label}</span>
                    </div>
                </li>
                {hasChildren && isExpanded && (
                    <div className="db-folder-children">
                        {node.children.map(child => renderFolderItem(child, depth + 1))}
                    </div>
                )}
            </div>
        )
    }

    const activeTab = tabs.find(t => t.id === activeTabId)
    const activeTabContent = activeTabId ? tabContents[activeTabId] : null

    return (
        <div className="mail-section-wrapper">
            {/* ── Tab Bar ─────────────────────────────── */}
            <div className="mail-tab-bar">
                <button
                    className={`mail-tab-item main-tab ${!activeTabId ? 'active' : ''}`}
                    onClick={() => setActiveTabId(null)}
                >
                    📥 {selectedFolder || 'Inbox'}
                </button>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`mail-tab-item ${activeTabId === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTabId(tab.id)}
                    >
                        <span className="mail-tab-label">{tab.mail.subject || '(No Subject)'}</span>
                        <span className="mail-tab-close" onClick={(e) => closeTab(e, tab.id)}>✕</span>
                    </button>
                ))}
            </div>

            <div className="db-main-menu">
                <ul>
                    <li className={activeRibbonTab === 'file' ? 'active' : ''}>
                        <button onClick={() => setActiveRibbonTab('file')}>{t('Files')}</button>
                    </li>
                    <li className={activeRibbonTab === 'home' ? 'active' : ''}>
                        <button onClick={() => setActiveRibbonTab('home')}>{t('Home')}</button>
                    </li>
                    <li className={activeRibbonTab === 'send-receive' ? 'active' : ''}>
                        <button onClick={() => setActiveRibbonTab('send-receive')}>{t('Send/Receive')}</button>
                    </li>
                    <li className={activeRibbonTab === 'folder' ? 'active' : ''}>
                        <button onClick={() => setActiveRibbonTab('folder')}>{t('Folders')}</button>
                    </li>
                    <li className={activeRibbonTab === 'view' ? 'active' : ''}>
                        <button onClick={() => setActiveRibbonTab('view')}>{t('View')}</button>
                    </li>
                </ul>
            </div>
            <div className="db-submenu">
                {activeRibbonTab === 'home' && (
                    <ul>
                        <li><button onClick={() => setComposeOpen(true)}>🆕 {t('New Mail')}</button></li>
                        <li><button onClick={() => selectedMail && removeMailOptimistic(selectedMail)}>🗑️ {t('Delete')}</button></li>
                        <li><button onClick={() => selectedMail && moveMail(selectedMail, 'Archive')}>📦 {t('Archive')}</button></li>
                        <li><button onClick={() => { }}>↩️ {t('Reply')}</button></li>
                        <li><button onClick={() => { }}>🔃 {t('Reply All')}</button></li>
                        <li><button onClick={() => { }}>➡️ {t('Forward')}</button></li>
                        <li><button onClick={() => selectedMail && moveMail(selectedMail, 'Spam')}>🚫 {t('Junk')}</button></li>
                    </ul>
                )}
                {activeRibbonTab === 'file' && (
                    <ul>
                        <li><button onClick={() => { }}>💾 {t('Save')}</button></li>
                        <li><button onClick={() => { }}>🖨️ {t('Print')}</button></li>
                        <li><button onClick={() => { }}>📤 {t('Export')}</button></li>
                    </ul>
                )}
                {activeRibbonTab === 'send-receive' && (
                    <ul>
                        <li><button onClick={() => {
                            loadMailsFromCache(selectedFolder, currentPage, perPage)
                                .then(() => {
                                    if (canUseRemoteMail && !isSyncing) {
                                        syncMailsFromRemote(selectedFolder, currentPage, perPage)
                                    }
                                })
                        }}>🔄 {t('Update Folder')}</button></li>
                        <li><button onClick={() => { }}>📡 {t('Send All')}</button></li>
                    </ul>
                )}
                {activeRibbonTab === 'folder' && (
                    <ul>
                        <li><button onClick={() => { }}>📁 {t('New Folder')}</button></li>
                        <li><button onClick={() => { }}>🏷️ {t('Rename')}</button></li>
                    </ul>
                )}
                {activeRibbonTab === 'view' && (
                    <ul>
                        <li><button onClick={() => { }}>📖 {t('Reading Pane')}</button></li>
                        <li><button onClick={() => { }}>📏 {t('Layout')}</button></li>
                    </ul>
                )}
            </div>

            {/* ── Tab content or normal inbox view ───── */}
            {activeTabId ? (
                <div className="mail-tab-content">
                    {loadingTab ? (
                        <div className="db-loading" style={{ paddingTop: 60 }}><div className="db-spinner" />Loading...</div>
                    ) : activeTab ? (
                        <div className="db-mail-content">
                            <div className="db-mail-content-header">
                                <div className="db-mail-content-subject">{activeTabContent?.subject || activeTab.mail.subject || '(No Subject)'}</div>
                                <div className="db-mail-content-actions">
                                    <button
                                        className="db-mail-action-btn"
                                        onClick={() => closeTab({ stopPropagation: () => { } }, activeTabId)}
                                        title="Close tab"
                                    >✕</button>
                                </div>
                            </div>
                            <div className="db-mail-meta"><strong>From:</strong> {activeTabContent?.from_name ? `${activeTabContent.from_name} <${activeTabContent.from_address}>` : activeTab.mail.address}</div>
                            {!!(activeTabContent?.cc || '').trim() && <div className="db-mail-meta"><strong>CC:</strong> {activeTabContent.cc}</div>}
                            {!!(activeTabContent?.bcc || '').trim() && <div className="db-mail-meta"><strong>BCC:</strong> {activeTabContent.bcc}</div>}
                            <div className="db-mail-meta"><strong>Date:</strong> {formatMailDateLong(activeTabContent?.date || activeTab.mail.date)}</div>
                            <hr className="db-mail-divider" />
                            {activeTabContent?.html_body ? (
                                <div className="db-mail-body-html">
                                    <iframe
                                        ref={el => { tabIframeRefs.current[activeTabId] = el }}
                                        title={`tab-${activeTabId}`}
                                        sandbox="allow-same-origin"
                                    />
                                </div>
                            ) : (
                                <div className="db-mail-body">{activeTabContent?.plain_body || '(No content)'}</div>
                            )}
                            {activeTabContent?.attachments?.length > 0 && (
                                <div className="db-attachments">
                                    <div className="db-attachments__header">Attachments ({activeTabContent.attachments.length})</div>
                                    <ul className="db-attachments__list">
                                        {activeTabContent.attachments.map((at) => (
                                            <li key={at.id} className="db-attachments__item">
                                                <div className="db-attachments__info">
                                                    <span className="db-attachments__name">{at.filename}</span>
                                                    <span className="db-attachments__meta">{at.content_type}</span>
                                                </div>
                                                <a
                                                    className="db-attachments__link"
                                                    href={attachmentUrl(accountId, activeTabContent.id, at.id, activeTab.mailbox, canUseRemoteMail)}
                                                    download={at.filename}
                                                >Download</a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
            ) : (
                <div className="mail-section-container" data-fullscreen-mail={isMailFullscreen}>
                    {foldersHidden && (
                        <div className="db-dock-tabs db-dock-tabs--left">
                            <CollapsedTab
                                label={t('Mailboxes')}
                                title={t('Show mailboxes')}
                                onClick={() => setFoldersHidden(false)}
                            />
                        </div>
                    )}

                    {!foldersHidden && (
                        <>
                            <div className="db-folder-panel" style={{ width: folderWidth }}>
                                <div className="db-panel-header">
                                    <span className="db-panel-title">{t('Mailboxes')}</span>
                                    <button
                                        type="button"
                                        className="db-panel-hide-btn"
                                        onClick={() => setFoldersHidden(true)}
                                        title={t('Hide mailboxes')}
                                    >
                                        ❯
                                    </button>
                                </div>
                                {hasFolderAccess ? (
                                    <div className="db-folder-scroll-area">
                                        <ul className="db-folder-list">
                                            {folderTree.map(node => renderFolderItem(node))}
                                        </ul>
                                    </div>
                                ) : (
                                    <div style={{ padding: '20px', color: '#999', fontSize: '13px', textAlign: 'center' }}>
                                        {connecting
                                            ? 'Connecting...'
                                            : canUseRemoteMail
                                                ? 'No mailboxes available.'
                                                : 'No offline mailboxes cached yet.'}
                                    </div>
                                )}
                            </div>
                            <div
                                className="db-resizer"
                                onMouseDown={() => { isResizingFolder.current = true; document.body.classList.add('resizing') }}
                                title="Resize mailboxes"
                            />
                        </>
                    )}

                    {mailsHidden && (
                        <div className="db-dock-tabs db-dock-tabs--left">
                            <CollapsedTab
                                label={t('Mails')}
                                title={t('Show mails')}
                                onClick={() => setMailsHidden(false)}
                            />
                        </div>
                    )}

                    <div className="db-mail-main">
                        {!mailsHidden && (
                            <div
                                className="db-center-panel"
                                style={
                                    isMailFullscreen
                                        ? { flex: 1, width: 'auto' }
                                        : { width: Math.max(listWidth, minListWidth), '--db-list-min': `${minListWidth}px` }
                                }
                            >
                                <div className="db-mail-toolbar" ref={mailToolbarRef}>
                                    <button
                                        type="button"
                                        className="db-mail-toolbar-btn"
                                        onClick={() => setMailsHidden(true)}
                                        title={t('Hide mails')}
                                    >
                                        ❯
                                    </button>
                                    <button
                                        type="button"
                                        className="db-mail-toolbar-btn"
                                        onClick={async () => {
                                            if (!backendReachable) return
                                            if (networkOnline) {
                                                const ok = canUseRemoteMail || (await ensureImapConnected())
                                                if (ok && !isSyncing) {
                                                    await syncMailsFromRemote(selectedFolder, currentPage, perPage)
                                                    return
                                                }
                                            }
                                            await loadMailsFromCache(selectedFolder, currentPage, perPage)
                                        }}
                                        title={isSyncing ? 'Syncing...' : (canUseRemoteMail ? 'Refresh from server' : 'Load from cache')}
                                        disabled={isSyncing}
                                    >
                                        {isSyncing ? '⟳' : '🔄'}
                                    </button>
                                    <button
                                        type="button"
                                        className={`db-mail-toolbar-btn ${selectMode ? 'active' : ''}`}
                                        onClick={() => {
                                            setSelectMode((prev) => {
                                                const next = !prev
                                                if (!next) setSelectedMailIds(new Set())
                                                return next
                                            })
                                        }}
                                        title="Select"
                                    >
                                        ☑
                                    </button>
                                    <button type="button" className="db-mail-toolbar-btn" title="Filter">🔍</button>
                                    <button type="button" className="db-mail-toolbar-btn" title="Sort">↕️</button>

                                    <div className="db-toolbar-separator" />

                                    <div className="db-pagination-controls">
                                        <button
                                            className="db-pagination-btn"
                                            disabled={currentPage <= 1 || loadingMails}
                                            onClick={() => {
                                                const p = currentPage - 1
                                                setCurrentPage(p)
                                            }}
                                        >
                                            ◀
                                        </button>
                                        <span className="db-page-num">{currentPage}/{maxPage}</span>
                                        <button
                                            className="db-pagination-btn"
                                            disabled={currentPage >= maxPage || loadingMails}
                                            onClick={() => {
                                                const p = currentPage + 1
                                                setCurrentPage(p)
                                            }}
                                        >
                                            ▶
                                        </button>
                                    </div>

                                    <div className="db-perpage-wrapper" ref={perPageRef}>
                                        <div className="db-perpage-combobox">
                                            <input
                                                type="text"
                                                className="db-perpage-input"
                                                value={perPage}
                                                onClick={() => setIsPerPageOpen(true)}
                                                onChange={(e) => {
                                                    const val = e.target.value.replace(/\D/g, '')
                                                    setPerPage(val)
                                                }}
                                                onFocus={() => setIsPerPageOpen(true)}
                                                onKeyDown={(e) => {
                                                    if (e.key === 'Enter') {
                                                        const val = Math.max(1, parseInt(perPage) || 50)
                                                        setPerPage(val)
                                                        setCurrentPage(1)
                                                        setIsPerPageOpen(false)
                                                        e.target.blur()
                                                    }
                                                }}
                                                placeholder="Count"
                                            />
                                            {isPerPageOpen && (
                                                <div className="db-perpage-dropdown">
                                                    {[10, 20, 50, 100, 150, 200, 250].map(val => (
                                                        <div
                                                            key={val}
                                                            className="db-perpage-option"
                                                            onClick={() => {
                                                                setPerPage(val)
                                                                setCurrentPage(1)
                                                                setIsPerPageOpen(false)
                                                            }}
                                                        >
                                                            {val}
                                                        </div>
                                                    ))}
                                                </div>
                                            )
                                            }
                                        </div>
                                    </div>

                                    <button
                                        className={`db-mail-toolbar-btn ${isMailFullscreen ? 'active' : ''}`}
                                        onClick={toggleMailFullscreen}
                                        title={isMailFullscreen ? 'Exit mails fullscreen' : 'Mails fullscreen'}
                                    >
                                        {isMailFullscreen ? '↔' : '⇔'}
                                    </button>

                                    {isMailFullscreen && (
                                        <>
                                            <div className="db-toolbar-separator" />
                                            <div className="db-layout-controls">
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 1 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(1)}
                                                    title="1 Column"
                                                >1️⃣</button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 2 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(2)}
                                                    title="2 Columns"
                                                >2️⃣</button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 3 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(3)}
                                                    title="3 Columns"
                                                >3️⃣</button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 4 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(4)}
                                                    title="4 Columns"
                                                >4️⃣</button>
                                            </div>
                                        </>
                                    )}
                                </div>
                                {!hasMailSource ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon">📭</div>
                                        <div className="db-empty-text">
                                            {connecting
                                                ? 'Connecting...'
                                                : canUseRemoteMail
                                                    ? 'No messages available.'
                                                    : 'No offline cache available for this account yet.'}
                                        </div>
                                    </div>
                                ) : loadingMails ? (
                                    <div className="db-loading"><div className="db-spinner" />Loading...</div>
                                ) : mails.length === 0 ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon">📭</div>
                                        <div className="db-empty-text">This folder is empty</div>
                                    </div>
                                ) : (
                                    <ul className="db-mail-list" data-cols={displayCols}>
                                        {sortedMails.map((mail) => (
                                            <li
                                                key={mail.id}
                                                className={`db-mail-item ${mail.seen !== true ? 'unread' : ''} ${selectedMail?.id === mail.id ? 'selected' : ''}`}
                                                onClick={() => openMail(mail)}
                                            >
                                                {selectMode && (
                                                    <div className="db-mail-select" onClick={(e) => e.stopPropagation()}>
                                                        <input
                                                            type="checkbox"
                                                            checked={selectedMailIds.has(mail.id)}
                                                            onChange={() => toggleMailSelected(mail.id)}
                                                            aria-label="Select mail"
                                                        />
                                                    </div>
                                                )}
                                                <div className="db-mail-item-content">
                                                    <span className="db-mail-sender">{mail.name || mail.address || 'Unknown'}</span>
                                                    <span className="db-mail-subject">{mail.subject || '(No Subject)'}</span>
                                                    <span className="db-mail-time">{getShortTime(mail.date)}</span>
                                                </div>
                                                <div className="db-mail-quick-actions">
                                                    <button
                                                        className="db-mail-qa-btn"
                                                        title="Open in new tab"
                                                        onClick={(e) => {
                                                            e.stopPropagation()
                                                            openMailInTab(mail)
                                                        }}
                                                    >
                                                        🗂️
                                                    </button>
                                                    <button
                                                        className="db-mail-qa-btn"
                                                        title="Open in new window"
                                                        onClick={(e) => detachMailToWindowFromList(e, mail)}
                                                    >
                                                        🪟
                                                    </button>
                                                </div>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </div>
                        )}

                        {!isMailFullscreen && !mailsHidden && (
                            <div
                                className="db-resizer"
                                onMouseDown={() => { isResizingList.current = true; document.body.classList.add('resizing') }}
                                title="Resize mails"
                            />
                        )}

                        {!isMailFullscreen && (
                            <div className="db-right-panel">
                                {!hasMailSource ? (
                                    <div className="db-empty-state" style={{ paddingTop: 100 }}>
                                        <div className="db-empty-icon">🕊️</div>
                                        <div className="db-empty-text">
                                            {connecting
                                                ? 'Connecting...'
                                                : canUseRemoteMail
                                                    ? 'No messages loaded yet.'
                                                    : 'Offline cache is not available yet.'}
                                        </div>
                                    </div>
                                ) : !selectedMail ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon">🕊️</div>
                                        <div className="db-empty-text">Select an email</div>
                                    </div>
                                ) : loadingContent ? (
                                    <div className="db-loading" style={{ paddingTop: 60 }}><div className="db-spinner" />Loading content...</div>
                                ) : (
                                    <div className="db-mail-content">
                                        <div className="db-mail-content-header">
                                            <div className="db-mail-content-subject">{mailContent?.subject || selectedMail.subject || '(No Subject)'}</div>
                                            <div className="db-mail-content-actions">
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => openMailInTab(selectedMail, mailContent)}
                                                    title="Open in new tab"
                                                >
                                                    🗂️
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={detachMailToWindow}
                                                    title="Open in new window"
                                                >
                                                    🪟
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => setSelectedMail(null)}
                                                    title="Close"
                                                >
                                                    ✕
                                                </button>
                                            </div>
                                        </div>
                                        <div className="db-mail-meta"><strong>From:</strong> {mailContent?.from_name ? `${mailContent.from_name} <${mailContent.from_address}>` : selectedMail.address}</div>
                                        {!!(mailContent?.cc || '').trim() && <div className="db-mail-meta"><strong>CC:</strong> {mailContent.cc}</div>}
                                        {!!(mailContent?.bcc || '').trim() && <div className="db-mail-meta"><strong>BCC:</strong> {mailContent.bcc}</div>}
                                        <div className="db-mail-meta"><strong>Date:</strong> {formatMailDateLong(mailContent?.date || selectedMail.date)}</div>
                                        <hr className="db-mail-divider" />
                                        {mailContent?.html_body ? (
                                            <div className="db-mail-body-html"><iframe ref={iframeRef} title="mail-content" sandbox="allow-same-origin" /></div>
                                        ) : (
                                            <div className="db-mail-body">{mailContent?.plain_body || '(No content)'}</div>
                                        )}
                                        {mailContent?.attachments?.length > 0 && (
                                            <div className="db-attachments">
                                                <div
                                                    className="db-attachments__header"
                                                    onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
                                                    style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', userSelect: 'none' }}
                                                >
                                                    <span className={`db-folder-chevron ${attachmentsExpanded ? 'expanded' : ''}`} style={{ marginRight: '6px' }}>❯</span>
                                                    Attachments ({mailContent.attachments.length})
                                                </div>
                                                {attachmentsExpanded && (
                                                    <ul className="db-attachments__list">
                                                        {mailContent.attachments.map((at) => (
                                                            <li key={at.id} className="db-attachments__item">
                                                                <div className="db-attachments__info">
                                                                    <span className="db-attachments__name">{at.filename}</span>
                                                                    <span className="db-attachments__meta">{at.content_type} · {formatBytes(at.size)}</span>
                                                                </div>
                                                                <a
                                                                    className="db-attachments__link"
                                                                    href={attachmentUrl(accountId, mailContent.id, at.id, selectedFolder || 'INBOX', canUseRemoteMail)}
                                                                    download={at.filename}
                                                                >
                                                                    Download
                                                                </a>
                                                            </li>
                                                        ))}
                                                    </ul>
                                                )}
                                            </div>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
                    </div>
                </div>
            )}
            {composeOpen && (
                <div className="db-compose-modal">
                    <div className="db-compose-card">
                        <h3>{t('Compose Mail')}</h3>
                        <input
                            type="text"
                            placeholder="To"
                            value={composeForm.to}
                            onChange={(e) => setComposeForm((prev) => ({ ...prev, to: e.target.value }))}
                        />
                        <input
                            type="text"
                            placeholder="CC"
                            value={composeForm.cc}
                            onChange={(e) => setComposeForm((prev) => ({ ...prev, cc: e.target.value }))}
                        />
                        <input
                            type="text"
                            placeholder="BCC"
                            value={composeForm.bcc}
                            onChange={(e) => setComposeForm((prev) => ({ ...prev, bcc: e.target.value }))}
                        />
                        <input
                            type="text"
                            placeholder="Subject"
                            value={composeForm.subject}
                            onChange={(e) => setComposeForm((prev) => ({ ...prev, subject: e.target.value }))}
                        />
                        <textarea
                            placeholder="Message"
                            value={composeForm.body}
                            onChange={(e) => setComposeForm((prev) => ({ ...prev, body: e.target.value }))}
                        />
                        <div className="db-compose-actions">
                            <button type="button" onClick={sendComposedMail}>Send</button>
                            <button type="button" onClick={() => setComposeOpen(false)}>Close</button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

function CalendarSection() {
    return (
        <div className="db-section-panel">
            <h2>Calendar</h2>
            <p>Calendar section will be displayed here.</p>
        </div>
    )
}

function ContactsSection() {
    return (
        <div className="db-section-panel">
            <h2>Contacts</h2>
            <p>Your contacts will be listed here.</p>
        </div>
    )
}

function TodoSection() {
    return (
        <div className="db-section-panel">
            <h2>Todo</h2>
            <p>Move your task lists here.</p>
        </div>
    )
}

export default DashboardPage
