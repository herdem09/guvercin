import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import './DashboardPage.css'

// ── Folder mappings ────────────────────
const FOLDER_MAP = {
    'INBOX': { icon: '📥', label: 'Gelen Kutusu' },
    'Gelen Kutusu': { icon: '📥', label: 'Gelen Kutusu' },
    'Starred': { icon: '⭐', label: 'Yıldızlı' },
    'Yıldızlı': { icon: '⭐', label: 'Yıldızlı' },
    'Snoozed': { icon: '🕒', label: 'Ertelenenler' },
    'Ertelenenler': { icon: '🕒', label: 'Ertelenenler' },
    'Sent': { icon: '✈️', label: 'Gönderilmiş Postalar' },
    'Sent Items': { icon: '✈️', label: 'Gönderilmiş Postalar' },
    'Gönderilmiş Öğeler': { icon: '✈️', label: 'Gönderilmiş Postalar' },
    'Drafts': { icon: '📝', label: 'Taslaklar' },
    'Taslaklar': { icon: '📝', label: 'Taslaklar' },
    'Archive': { icon: '📦', label: 'Arşiv' },
    'Arşiv': { icon: '📦', label: 'Arşiv' },
    'Trash': { icon: '🗑️', label: 'Çöp Kutusu' },
    'Silinmiş Öğeler': { icon: '🗑️', label: 'Çöp Kutusu' },
    'Spam': { icon: '🚫', label: 'Spam' },
    'Junk': { icon: '🚫', label: 'Spam' },
    'Önemsiz E-posta': { icon: '🚫', label: 'Spam' },
    'All Mail': { icon: '📑', label: 'Tüm Postalar' },
    '[Gmail]/Tüm Postalar': { icon: '📑', label: 'Tüm Postalar' },
    '[Gmail]/All Mail': { icon: '📑', label: 'Tüm Postalar' },
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


function useClock() {
    const [now, setNow] = useState(new Date())
    useEffect(() => {
        const timer = setInterval(() => setNow(new Date()), 1000)
        return () => clearInterval(timer)
    }, [])
    const timeStr = now.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
    const dateStr = now.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    return { time: timeStr, date: dateStr }
}

const DashboardPage = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const { time, date } = useClock()

    const [activeSection, setActiveSection] = useState('mail')
    const [accountId, setAccountId] = useState(null)
    const [accountForm, setAccountForm] = useState({})
    const [email, setEmail] = useState('')

    const [connected, setConnected] = useState(false)
    const [connecting, setConnecting] = useState(false)
    const [folders, setFolders] = useState([])
    const [selectedFolder, setSelectedFolder] = useState('INBOX')
    const [mails, setMails] = useState([])
    const [selectedMail, setSelectedMail] = useState(null)
    const [mailContent, setMailContent] = useState(null)
    const [loadingMails, setLoadingMails] = useState(false)
    const [loadingContent, setLoadingContent] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [perPage, setPerPage] = useState(50)

    const [activeRibbonTab, setActiveRibbonTab] = useState('home')
    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
    const [isMailFullscreen, setIsMailFullscreen] = useState(false)
    const [mailWindowOpen, setMailWindowOpen] = useState(false)

    const accountButtonRef = useRef(null)
    const accountMenuRef = useRef(null)
    const iframeRef = useRef(null)

    useEffect(() => {
        const storedId = localStorage.getItem('current_account_id')
        if (storedId) {
            setAccountId(storedId)
            fetchAccount(storedId)
        } else {
            navigate('/login')
        }
    }, [navigate])

    const fetchAccount = async (id) => {
        try {
            const res = await fetch(apiUrl('/api/auth/accounts'))
            const data = await res.json()
            const acc = data.find(a => a.id.toString() === id.toString())
            if (acc) {
                setAccountForm(acc)
                setEmail(acc.email)
            }
        } catch { }
    }

    const t_func = (key) => t(key)
    const accountLabel = accountForm.name || accountForm.email || 'User'
    const accountEmailLabel = accountForm.email || ''

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

    const loadFolders = useCallback(async () => {
        if (!accountId) return
        try {
            const res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`))
            const data = await res.json()
            setFolders(data.mailboxes || [])
        } catch { }
    }, [accountId])

    const autoConnectAttempted = useRef(false)

    useEffect(() => {
        const autoConnect = async () => {
            if (!accountId || connected || connecting || autoConnectAttempted.current) return
            autoConnectAttempted.current = true
            setConnecting(true)
            try {
                const res = await fetch(apiUrl(`/api/mail/${accountId}/connect-stored`), { method: 'POST' })
                if (res.ok) setConnected(true)
            } catch { }
            setConnecting(false)
        }
        autoConnect()
    }, [accountId, connected, connecting])

    const loadMails = useCallback(async (folder, page = currentPage, limit = perPage) => {
        if (!accountId || !connected) return
        setLoadingMails(true)
        try {
            const res = await fetch(apiUrl(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=${page}&per_page=${limit}`))
            const data = await res.json()
            setMails(data.mails || [])
        } catch { }
        setLoadingMails(false)
    }, [accountId, connected, currentPage, perPage])

    useEffect(() => {
        if (connected && activeSection === 'mail') loadFolders()
    }, [connected, loadFolders, activeSection])

    useEffect(() => {
        if (connected && activeSection === 'mail') {
            setCurrentPage(1)
            loadMails(selectedFolder, 1, perPage)
        }
    }, [connected, selectedFolder, activeSection]) // Only reload when folder/section changes - loadMails will handle page/limit changes

    const openMail = async (mail) => {
        setIsMailFullscreen(false)
        setSelectedMail(mail)
        setMailContent(null)
        setLoadingContent(true)
        try {
            const mailbox = selectedFolder || 'INBOX'
            const res = await fetch(
                apiUrl(`/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`)
            )
            if (res.ok) {
                const data = await res.json()
                setMailContent(data)
            }
        } catch { }
        setLoadingContent(false)
    }

    const detachMailToWindow = async () => {
        if (!selectedMail) return
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            const mailWindowLabel = `mail-${Date.now()}-${Math.random().toString(16).slice(2)}`
            const mailData = {
                mail: selectedMail,
                mailContent: mailContent,
                accountId: accountId,
                mailbox: selectedFolder || 'INBOX',
            }

            // Pass mail data directly via invoke so it's embedded in the new window's URL.
            // We cannot use localStorage because each Tauri WebviewWindow has its own
            // isolated storage that is not shared with other windows.
            await invoke('open_mail_window', {
                label: mailWindowLabel,
                mailDataJson: JSON.stringify(mailData),
            })
            setMailWindowOpen(true)
            // Do not keep showing the mail in the main window when detached
            setSelectedMail(null)
            setMailContent(null)
        } catch (e) {
            console.error('Failed to open mail window:', e)
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

    const getShortTime = () => {
        const now = new Date()
        return `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
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
                    <span className="db-logo-text">Güvercin</span>
                </button>
                <div className="db-search">
                    <input type="text" placeholder="Ara..." />
                    <button className="db-search-btn">🔍</button>
                </div>
                <div className="db-clock">
                    <span className="db-clock-item">{time}</span>
                    <span className="db-clock-item">{date}</span>
                </div>
                <button className="db-icon-btn" title="Bildirimler">🔔</button>
                <button className="db-icon-btn" title="Ayarlar">⚙️</button>
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
                    {activeSection === 'mail' && (
                        <>
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
                                        <li><button onClick={() => { }}>🆕 {t('New Mail')}</button></li>
                                        <li><button onClick={() => { }}>🗑️ {t('Delete')}</button></li>
                                        <li><button onClick={() => { }}>📦 {t('Archive')}</button></li>
                                        <li><button onClick={() => { }}>↩️ {t('Reply')}</button></li>
                                        <li><button onClick={() => { }}>🔃 {t('Reply All')}</button></li>
                                        <li><button onClick={() => { }}>➡️ {t('Forward')}</button></li>
                                        <li><button onClick={() => { }}>🚫 {t('Junk')}</button></li>
                                    </ul>
                                )}
                                {activeRibbonTab === 'file' && (
                                    <ul>
                                        <li><button onClick={() => { }}>� {t('Save')}</button></li>
                                        <li><button onClick={() => { }}>🖨️ {t('Print')}</button></li>
                                        <li><button onClick={() => { }}>📤 {t('Export')}</button></li>
                                    </ul>
                                )}
                                {activeRibbonTab === 'send-receive' && (
                                    <ul>
                                        <li><button onClick={() => loadMails(selectedFolder)}>🔄 {t('Update Folder')}</button></li>
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
                                        <li><button onClick={() => { }}>�️ {t('Reading Pane')}</button></li>
                                        <li><button onClick={() => { }}>📏 {t('Layout')}</button></li>
                                    </ul>
                                )}
                            </div>
                        </>
                    )}

                    <div className="db-section-area">
                        {activeSection === 'mail' && (
                            <MailSection
                                connected={connected}
                                setConnected={setConnected}
                                accountId={accountId}
                                accountForm={accountForm}
                                email={email}
                                folders={folders}
                                selectedFolder={selectedFolder}
                                setSelectedFolder={setSelectedFolder}
                                mails={mails}
                                selectedMail={selectedMail}
                                setSelectedMail={setSelectedMail}
                                mailContent={mailContent}
                                loadingMails={loadingMails}
                                loadingContent={loadingContent}
                                connecting={connecting}
                                loadMails={loadMails}
                                openMail={openMail}
                                detachMailToWindow={detachMailToWindow}
                                iframeRef={iframeRef}
                                getShortTime={getShortTime}
                                currentPage={currentPage}
                                setCurrentPage={setCurrentPage}
                                perPage={perPage}
                                setPerPage={setPerPage}
                                isMailFullscreen={isMailFullscreen}
                                toggleMailFullscreen={toggleMailFullscreen}
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
    connected, setConnected, accountId, accountForm, email,
    folders, selectedFolder, setSelectedFolder, mails,
    selectedMail, setSelectedMail, mailContent, loadingMails, loadingContent,
    connecting, loadMails, openMail, detachMailToWindow, iframeRef, getShortTime,
    currentPage, setCurrentPage, perPage, setPerPage,
    isMailFullscreen, toggleMailFullscreen
}) {
    const [expandedFolders, setExpandedFolders] = useState(['INBOX', 'Folders', 'Labels', 'Etiketler'])
    const [folderWidth, setFolderWidth] = useState(240)
    const [listWidth, setListWidth] = useState(340)
    const [isPerPageOpen, setIsPerPageOpen] = useState(false)
    const [attachmentsExpanded, setAttachmentsExpanded] = useState(true)
    const perPageRef = useRef(null)
    const isResizingFolder = useRef(false)
    const isResizingList = useRef(false)

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
                const newWidth = Math.max(160, Math.min(500, e.clientX - 48)) // 48 is sidebar width
                setFolderWidth(newWidth)
            } else if (isResizingList.current) {
                const newWidth = Math.max(200, Math.min(600, e.clientX - 48 - folderWidth))
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
    }, [folderWidth])

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

    return (
        <div className="mail-section-container" data-fullscreen-mail={isMailFullscreen}>
            <div className="db-folder-panel" style={{ width: folderWidth }}>
                {connected ? (
                    <div className="db-folder-scroll-area">
                        <ul className="db-folder-list">
                            {folderTree.map(node => renderFolderItem(node))}
                        </ul>
                    </div>
                ) : (
                    <div style={{ padding: '20px', color: '#999', fontSize: '13px', textAlign: 'center' }}>
                        {connecting ? 'Bağlanıyor...' : 'Bağlantı bekliyor...'}
                    </div>
                )}
            </div>
            <div
                className="db-resizer"
                onMouseDown={() => { isResizingFolder.current = true; document.body.classList.add('resizing') }}
            />
            <div className="db-mail-main">
                <div
                    className="db-center-panel"
                    style={isMailFullscreen ? { flex: 1, width: 'auto' } : { width: listWidth }}
                >
                    <div className="db-mail-toolbar">
                        <button className="db-mail-toolbar-btn" onClick={() => loadMails(selectedFolder, currentPage, perPage)} title="Yenile">🔄</button>
                        <button className="db-mail-toolbar-btn" title="Seç">☑️</button>

                        <div className="db-toolbar-separator" />

                        <button className="db-mail-toolbar-btn" title="Filtrele">🔍</button>
                        <button className="db-mail-toolbar-btn" title="Sırala">↕️</button>

                        <div className="db-toolbar-separator" />

                        <div className="db-pagination-controls">
                            <button
                                className="db-pagination-btn"
                                disabled={currentPage <= 1 || loadingMails}
                                onClick={() => {
                                    const p = currentPage - 1
                                    setCurrentPage(p)
                                    loadMails(selectedFolder, p, perPage)
                                }}
                            >
                                ◀
                            </button>
                            <span className="db-page-num">{currentPage}</span>
                            <button
                                className="db-pagination-btn"
                                disabled={mails.length < perPage || loadingMails}
                                onClick={() => {
                                    const p = currentPage + 1
                                    setCurrentPage(p)
                                    loadMails(selectedFolder, p, perPage)
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
                                            loadMails(selectedFolder, 1, val)
                                            setIsPerPageOpen(false)
                                            e.target.blur()
                                        }
                                    }}
                                    placeholder="Adet"
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
                                                    loadMails(selectedFolder, 1, val)
                                                    setIsPerPageOpen(false)
                                                }}
                                            >
                                                {val}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        </div>

                        <button
                            className={`db-mail-toolbar-btn ${isMailFullscreen ? 'active' : ''}`}
                            onClick={toggleMailFullscreen}
                            title={isMailFullscreen ? 'Okuma bölmesini aç' : 'Okuma bölmesini kapat'}
                        >
                            {isMailFullscreen ? '↔' : '⇔'}
                        </button>
                    </div>
                    {!connected ? (
                        <div className="db-empty-state">
                            <div className="db-empty-icon">📭</div>
                            <div className="db-empty-text">{connecting ? 'Bağlanıyor…' : 'Bağlantı bekleniyor'}</div>
                        </div>
                    ) : loadingMails ? (
                        <div className="db-loading"><div className="db-spinner" />Yükleniyor…</div>
                    ) : mails.length === 0 ? (
                        <div className="db-empty-state">
                            <div className="db-empty-icon">📭</div>
                            <div className="db-empty-text">Bu klasör boş</div>
                        </div>
                    ) : (
                        <ul className="db-mail-list">
                            {mails.map((mail) => (
                                <li key={mail.id} className={`db-mail-item ${!mail.seen ? 'unread' : ''} ${selectedMail?.id === mail.id ? 'selected' : ''}`} onClick={() => openMail(mail)}>
                                    <span className="db-mail-sender">{mail.name || mail.address || 'Bilinmeyen'}</span>
                                    <span className="db-mail-subject">{mail.subject || '(Konu Yok)'}</span>
                                    <span className="db-mail-time">{getShortTime()}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
                {!isMailFullscreen && (
                    <>
                        <div
                            className="db-resizer"
                            onMouseDown={() => { isResizingList.current = true; document.body.classList.add('resizing') }}
                        />
                        <div className="db-right-panel">
                            {!connected ? (
                                <div className="db-loading" style={{ paddingTop: 100 }}>
                                    <div className="db-spinner" />
                                    IMAP Sunucusuna bağlanılıyor…
                                </div>
                            ) : !selectedMail ? (
                                <div className="db-empty-state">
                                    <div className="db-empty-icon">🕊️</div>
                                    <div className="db-empty-text">Bir e-posta seçin</div>
                                </div>
                            ) : loadingContent ? (
                                <div className="db-loading" style={{ paddingTop: 60 }}><div className="db-spinner" />İçerik yükleniyor…</div>
                            ) : (
                                <div className="db-mail-content">
                                    <div className="db-mail-content-header">
                                        <div className="db-mail-content-subject">{mailContent?.subject || selectedMail.subject || '(Konu Yok)'}</div>
                                        <div className="db-mail-content-actions">
                                            <button
                                                className="db-mail-action-btn"
                                                onClick={detachMailToWindow}
                                                title="Yeni Pencereye At"
                                            >
                                                🪟
                                            </button>
                                            <button
                                                className="db-mail-action-btn"
                                                onClick={() => setSelectedMail(null)}
                                                title="Kapat"
                                            >
                                                ✕
                                            </button>
                                        </div>
                                    </div>
                                    <div className="db-mail-meta"><strong>Kimden:</strong> {mailContent?.from_name ? `${mailContent.from_name} <${mailContent.from_address}>` : selectedMail.address}</div>
                                    <hr className="db-mail-divider" />
                                    {mailContent?.html_body ? (
                                        <div className="db-mail-body-html"><iframe ref={iframeRef} title="mail-content" sandbox="allow-same-origin" /></div>
                                    ) : (
                                        <div className="db-mail-body">{mailContent?.plain_body || '(İçerik yok)'}</div>
                                    )}
                                    {mailContent?.attachments?.length > 0 && (
                                        <div className="db-attachments">
                                            <div
                                                className="db-attachments__header"
                                                onClick={() => setAttachmentsExpanded(!attachmentsExpanded)}
                                                style={{ cursor: 'pointer', display: 'flex', alignItems: 'center', userSelect: 'none' }}
                                            >
                                                <span className={`db-folder-chevron ${attachmentsExpanded ? 'expanded' : ''}`} style={{ marginRight: '6px' }}>❯</span>
                                                Ekler ({mailContent.attachments.length})
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
                                                                href={apiUrl(`/api/mail/${accountId}/content/${encodeURIComponent(mailContent.id)}/attachments/${at.id}?mailbox=${encodeURIComponent(selectedFolder || 'INBOX')}`)}
                                                                download={at.filename}
                                                            >
                                                                İndir
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
                    </>
                )}
            </div>
        </div>
    )
}

function CalendarSection() {
    return (
        <div className="db-section-panel">
            <h2>Calendar</h2>
            <p>Takvim sekmesi burada görüntülenecek.</p>
        </div>
    )
}

function ContactsSection() {
    return (
        <div className="db-section-panel">
            <h2>Contacts</h2>
            <p>Burada rehberinizdeki kişiler listelenecek.</p>
        </div>
    )
}

function TodoSection() {
    return (
        <div className="db-section-panel">
            <h2>Todo</h2>
            <p>Görev listelerinizi buraya taşıyın.</p>
        </div>
    )
}

export default DashboardPage
