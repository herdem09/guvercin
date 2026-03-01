import { useState, useEffect, useCallback, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
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

    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
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
            const res = await fetch('/api/accounts')
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
            const res = await fetch(`/api/mail/${accountId}/mailboxes`)
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
                const res = await fetch(`/api/mail/${accountId}/connect-stored`, { method: 'POST' })
                if (res.ok) setConnected(true)
            } catch { }
            setConnecting(false)
        }
        autoConnect()
    }, [accountId, connected, connecting])

    const loadMails = useCallback(async (folder) => {
        if (!accountId || !connected) return
        setLoadingMails(true)
        try {
            const res = await fetch(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=1&per_page=50`)
            const data = await res.json()
            setMails(data.mails || [])
        } catch { }
        setLoadingMails(false)
    }, [accountId, connected])

    useEffect(() => {
        if (connected && activeSection === 'mail') loadFolders()
    }, [connected, loadFolders, activeSection])

    useEffect(() => {
        if (connected && activeSection === 'mail') loadMails(selectedFolder)
    }, [connected, selectedFolder, loadMails, activeSection])

    const openMail = async (mail) => {
        setSelectedMail(mail)
        setMailContent(null)
        setLoadingContent(true)
        try {
            const res = await fetch(`/api/mail/${accountId}/content/${mail.id}`)
            if (res.ok) {
                const data = await res.json()
                setMailContent(data)
            }
        } catch { }
        setLoadingContent(false)
    }

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
                                    <li><a href="#file">{t('Files')}</a></li>
                                    <li className="active"><a href="#home">{t('Home')}</a></li>
                                    <li><a href="#send-receive">{t('Send/Receive')}</a></li>
                                    <li><a href="#folder">{t('Folders')}</a></li>
                                    <li><a href="#view">{t('View')}</a></li>
                                </ul>
                            </div>
                            <div className="db-submenu">
                                <ul>
                                    <li><a href="#new-mail">🆕 {t('New Mail')}</a></li>
                                    <li><a href="#delete">🗑️ {t('Delete')}</a></li>
                                    <li><a href="#archive">📦 {t('Archive')}</a></li>
                                    <li><a href="#reply">↩️ {t('Reply')}</a></li>
                                    <li><a href="#reply-all">🔃 {t('Reply All')}</a></li>
                                    <li><a href="#forward">➡️ {t('Forward')}</a></li>
                                    <li><a href="#junk">🚫 {t('Junk')}</a></li>
                                </ul>
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
                                mailContent={mailContent}
                                loadingMails={loadingMails}
                                loadingContent={loadingContent}
                                connecting={connecting}
                                loadMails={loadMails}
                                openMail={openMail}
                                iframeRef={iframeRef}
                                getShortTime={getShortTime}
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
    selectedMail, mailContent, loadingMails, loadingContent,
    connecting, loadMails, openMail, iframeRef, getShortTime
}) {
    const processFolders = (list) => {
        const top = []
        const labels = []

        const priorityMap = {
            'INBOX': 1, 'GELEN KUTUSU': 1,
            'STARRED': 2, 'YILDIZLI': 2,
            'SNOOZED': 3, 'ERTELENENLER': 3,
            'SENT': 4, 'SENT ITEMS': 4, 'GÖNDERİLMİŞ ÖĞELER': 4, 'GÖNDERİLMİŞ POSTALAR': 4,
            'ALL MAIL': 5, 'TÜM POSTALAR': 5,
            'DRAFTS': 6, 'TASLAKLAR': 6,
            'ARCHIVE': 7, 'ARŞİV': 7,
            'TRASH': 8, 'SILINMIŞ ÖĞELER': 8, 'ÇÖP KUTUSU': 8,
            'SPAM': 9, 'ÖNEMSIZ E-POSTA': 9, 'JUNK': 9
        }

        list.forEach(f => {
            const upper = f.toUpperCase()
            if (upper === 'LABELS' || upper === 'FOLDERS') return

            if (f.startsWith('Labels/') || f.startsWith('Etiketler/')) {
                labels.push(f)
            } else {
                top.push(f)
            }
        })

        const sortFn = (a, b) => {
            const pa = priorityMap[a.toUpperCase().replace(/^(FOLDERS|LABELS|ETIKETLER)\//i, '')] || 999
            const pb = priorityMap[b.toUpperCase().replace(/^(FOLDERS|LABELS|ETIKETLER)\//i, '')] || 999
            if (pa !== pb) return pa - pb
            return a.localeCompare(b)
        }

        return {
            top: top.sort(sortFn),
            labels: labels.sort(sortFn)
        }
    }

    const { top, labels } = processFolders(folders)

    return (
        <>
            <div className="db-folder-panel">
                {connected ? (
                    <ul className="db-folder-list">
                        {top.map((f) => {
                            const info = folderInfo(f)
                            const isSelected = selectedFolder === f
                            return (
                                <li key={f} className={`db-folder-item ${isSelected ? 'selected' : ''}`}>
                                    <a onClick={(e) => { e.preventDefault(); setSelectedFolder(f) }}>
                                        <span className="db-folder-icon">{info.icon}</span>
                                        <span className="db-folder-text">{info.label}</span>
                                    </a>
                                </li>
                            )
                        })}
                        {labels.length > 0 && (
                            <div className="db-labels-section">
                                <div className="db-labels-header">
                                    <span>Etiketler</span>
                                    <button className="db-label-add-btn" title="Yeni Etiket">+</button>
                                </div>
                                {labels.map((f) => {
                                    const info = folderInfo(f)
                                    const isSelected = selectedFolder === f
                                    return (
                                        <li key={f} className={`db-folder-item ${isSelected ? 'selected' : ''}`}>
                                            <a onClick={(e) => { e.preventDefault(); setSelectedFolder(f) }}>
                                                <span className="db-folder-icon">🔖</span>
                                                <span className="db-folder-text">{info.label}</span>
                                            </a>
                                        </li>
                                    )
                                })}
                            </div>
                        )}
                    </ul>
                ) : (
                    <div style={{ padding: '20px', color: '#999', fontSize: '13px', textAlign: 'center' }}>
                        {connecting ? 'Bağlanıyor...' : 'Bağlantı bekliyor...'}
                    </div>
                )}
            </div>
            <div className="db-mail-main">
                <div className="db-center-panel">
                    <div className="db-mail-toolbar">
                        <button className="db-mail-toolbar-btn">☑️ Select</button>
                        <button className="db-mail-toolbar-btn">⏭️ Jump</button>
                        <button className="db-mail-toolbar-btn">🔍 Filter</button>
                        <button className="db-mail-toolbar-btn" onClick={() => loadMails(selectedFolder)}>🔄 Yenile</button>
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
                            <div className="db-mail-content-subject">{mailContent?.subject || selectedMail.subject || '(Konu Yok)'}</div>
                            <div className="db-mail-meta"><strong>Kimden:</strong> {mailContent?.from_name ? `${mailContent.from_name} <${mailContent.from_address}>` : selectedMail.address}</div>
                            <hr className="db-mail-divider" />
                            {mailContent?.html_body ? (
                                <div className="db-mail-body-html"><iframe ref={iframeRef} title="mail-content" sandbox="allow-same-origin" /></div>
                            ) : (
                                <div className="db-mail-body">{mailContent?.plain_body || '(İçerik yok)'}</div>
                            )}
                            {mailContent?.attachments?.length > 0 && (
                                <div className="db-attachments">
                                    <div className="db-attachments__header">Ekler</div>
                                    <ul className="db-attachments__list">
                                        {mailContent.attachments.map((at) => (
                                            <li key={at.id} className="db-attachments__item">
                                                <div className="db-attachments__info">
                                                    <span className="db-attachments__name">{at.filename}</span>
                                                    <span className="db-attachments__meta">{at.content_type} · {formatBytes(at.size)}</span>
                                                </div>
                                                <a className="db-attachments__link" href={`/api/mail/${accountId}/content/${encodeURIComponent(mailContent.id)}/attachments/${at.id}`} download={at.filename}>İndir</a>
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    )}
                </div>
            </div>
        </>
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
