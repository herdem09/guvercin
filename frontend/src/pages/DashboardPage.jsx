import { useState, useEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import { useOfflineSync } from '../context/OfflineSyncContext.jsx'
import Avatar from '../components/Avatar.jsx'
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

// ── Avatar utilities ────────────────────
function getAvatarInitials(name, email) {
    if (name) {
        const words = name.trim().split(' ')
        if (words.length >= 2) {
            return (words[0][0] + words[words.length - 1][0]).toUpperCase()
        }
        return name.substring(0, 2).toUpperCase()
    }
    if (email) return email.substring(0, 2).toUpperCase()
    return '??'
}

function getAvatarColor(name, email) {
    const colors = [
        '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7',
        '#DDA0DD', '#98D8C8', '#F7DC6F', '#BB8FCE', '#85C1E2',
        '#F8B739', '#52B788', '#E76F51', '#8E44AD', '#3498DB'
    ]
    let seed = name || email || 'unknown'
    let hash = 0
    for (let i = 0; i < seed.length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash)
    }
    return colors[Math.abs(hash) % colors.length]
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

const MAIL_FILTER_OPTIONS = [
    { key: 'all', label: 'All', icon: '✉' },
    { key: 'unread', label: 'Unread', icon: '⌁' },
    { key: 'flagged', label: 'Flagged', icon: '⚑' },
    { key: 'toMe', label: 'To me', icon: '➤' },
]

const MAIL_SORT_OPTIONS = [
    { key: 'date', label: 'Date' },
    { key: 'from', label: 'From' },
    { key: 'category', label: 'Category' },
    { key: 'flagStatus', label: 'Flag Status' },
    { key: 'size', label: 'Size' },
    { key: 'subject', label: 'Subject' },
    { key: 'type', label: 'Type' },
]

const MAIL_SORT_DIRECTION_LABELS = {
    date: { asc: 'Oldest on top', desc: 'Newest on top' },
    from: { asc: 'A to Z', desc: 'Z to A' },
    category: { asc: 'A to Z', desc: 'Z to A' },
    flagStatus: { asc: 'Unflagged on top', desc: 'Flagged on top' },
    size: { asc: 'Smallest on top', desc: 'Largest on top' },
    subject: { asc: 'A to Z', desc: 'Z to A' },
    type: { asc: 'A to Z', desc: 'Z to A' },
}

function normalizeMailText(value) {
    return (value || '').toString().trim().toLocaleLowerCase()
}

function getMailType(mail) {
    return normalizeMailText(mail?.content_type) || 'unknown'
}

function getMailCategory(mail) {
    const explicitCategory = normalizeMailText(mail?.category)
    if (explicitCategory) return explicitCategory

    const mailType = getMailType(mail)
    if (mailType.startsWith('multipart/')) return 'multipart'
    if (mailType.startsWith('text/')) return 'text'
    if (mailType.startsWith('image/')) return 'image'
    if (mailType.startsWith('application/')) return 'application'
    return mailType
}

function getSortDirectionLabel(sortBy, direction) {
    return MAIL_SORT_DIRECTION_LABELS[sortBy]?.[direction] || 'Newest on top'
}

function stripLabelFolderPrefix(value) {
    return value.replace(/^Labels\//i, '').replace(/^Etiketler\//i, '').trim()
}

function isLabelMailbox(value) {
    return /^(Labels|Etiketler)(\/|$)/i.test((value || '').trim())
}

function isMailboxSectionRoot(value) {
    return ['Folders', 'Labels', 'Etiketler'].includes((value || '').trim())
}

function isMoveTargetMailbox(value) {
    const mailbox = (value || '').trim()
    if (!mailbox || isMailboxSectionRoot(mailbox)) return false
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

function sanitizeFileName(value) {
    return (value || 'message')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, 120) || 'message'
}

function buildExportBaseName(mail, content) {
    const subject = sanitizeFileName(content?.subject || mail?.subject || 'message')
    const dateValue = content?.date || mail?.date || ''
    const parsedDate = Date.parse(dateValue)
    const datePart = Number.isFinite(parsedDate)
        ? new Date(parsedDate).toISOString().slice(0, 10)
        : 'mail'
    return `${subject}-${datePart}`
}

function escapeHtml(value) {
    return (value || '')
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')
}

function getMailSenderLabel(mail, content) {
    if (content?.from_name && content?.from_address) {
        return `${content.from_name} <${content.from_address}>`
    }
    if (content?.from_address) {
        return content.from_address
    }
    if (mail?.name && mail?.address) {
        return `${mail.name} <${mail.address}>`
    }
    return mail?.address || mail?.name || 'Unknown'
}

function htmlToPlainText(html) {
    if (!html) return ''
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        return (doc.body?.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/\r/g, '')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
    } catch {
        return html
    }
}

function extractHtmlFragment(html) {
    if (!html) return ''
    try {
        const doc = new DOMParser().parseFromString(html, 'text/html')
        doc.querySelectorAll('script, iframe, object, embed').forEach((node) => node.remove())
        doc.querySelectorAll('*').forEach((node) => {
            Array.from(node.attributes).forEach((attribute) => {
                if (/^on/i.test(attribute.name)) {
                    node.removeAttribute(attribute.name)
                }
            })
        })
        return doc.body?.innerHTML || html
    } catch {
        return html
    }
}

function buildMailPlainText(mail, content, formatMailDateLong) {
    const lines = [
        `Subject: ${content?.subject || mail?.subject || '(No Subject)'}`,
        `From: ${getMailSenderLabel(mail, content)}`,
        `To: ${mail?.recipient_to || '-'}`,
        `CC: ${content?.cc || '-'}`,
        `BCC: ${content?.bcc || '-'}`,
        `Date: ${formatMailDateLong(content?.date || mail?.date) || '-'}`,
        '',
    ]

    const body = content?.plain_body || htmlToPlainText(content?.html_body) || '(No content)'
    return `${lines.join('\n')}${body}`.trim()
}

function buildMailHtmlDocument(mail, content, formatMailDateLong) {
    const subject = content?.subject || mail?.subject || '(No Subject)'
    const bodyMarkup = content?.html_body
        ? extractHtmlFragment(content.html_body)
        : `<pre>${escapeHtml(content?.plain_body || '(No content)')}</pre>`

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f4f1ea;
      --card: #fffdf8;
      --line: #d6cfc2;
      --text: #1f1a17;
      --muted: #6e6259;
      --accent: #2b5f75;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      background:
        radial-gradient(circle at top left, rgba(43, 95, 117, 0.10), transparent 28rem),
        linear-gradient(180deg, #f6f3ec 0%, #efe9de 100%);
      color: var(--text);
      font-family: Georgia, "Times New Roman", serif;
    }
    .mail-sheet {
      max-width: 920px;
      margin: 0 auto;
      background: var(--card);
      border: 1px solid var(--line);
      border-radius: 18px;
      overflow: hidden;
      box-shadow: 0 20px 60px rgba(31, 26, 23, 0.08);
    }
    .mail-header {
      padding: 28px 32px 22px;
      border-bottom: 1px solid var(--line);
      background: linear-gradient(180deg, rgba(255,255,255,0.9) 0%, rgba(250,246,239,0.98) 100%);
    }
    .mail-subject {
      margin: 0 0 18px;
      font-size: 30px;
      line-height: 1.2;
      letter-spacing: -0.02em;
    }
    .mail-meta {
      display: grid;
      grid-template-columns: 90px 1fr;
      gap: 8px 14px;
      font-size: 14px;
      line-height: 1.5;
    }
    .mail-meta dt {
      margin: 0;
      color: var(--muted);
      font-weight: 700;
    }
    .mail-meta dd {
      margin: 0;
      min-width: 0;
      overflow-wrap: anywhere;
    }
    .mail-body {
      padding: 28px 32px 36px;
      font-size: 16px;
      line-height: 1.6;
    }
    .mail-body pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
      font-family: "SFMono-Regular", Consolas, monospace;
      font-size: 14px;
      line-height: 1.55;
    }
    img {
      max-width: 100%;
      height: auto;
    }
    @media print {
      body {
        padding: 0;
        background: #fff;
      }
      .mail-sheet {
        max-width: none;
        border: 0;
        border-radius: 0;
        box-shadow: none;
      }
      .mail-header,
      .mail-body {
        padding-left: 0;
        padding-right: 0;
      }
    }
  </style>
</head>
<body>
  <article class="mail-sheet">
    <header class="mail-header">
      <h1 class="mail-subject">${escapeHtml(subject)}</h1>
      <dl class="mail-meta">
        <dt>From</dt><dd>${escapeHtml(getMailSenderLabel(mail, content))}</dd>
        <dt>To</dt><dd>${escapeHtml(mail?.recipient_to || '-')}</dd>
        <dt>CC</dt><dd>${escapeHtml(content?.cc || '-')}</dd>
        <dt>BCC</dt><dd>${escapeHtml(content?.bcc || '-')}</dd>
        <dt>Date</dt><dd>${escapeHtml(formatMailDateLong(content?.date || mail?.date) || '-')}</dd>
      </dl>
    </header>
    <section class="mail-body">${bodyMarkup}</section>
  </article>
</body>
</html>`
}

function normalizeCrlf(value) {
    return (value || '').replace(/\r?\n/g, '\r\n')
}

function buildFallbackMsgContent(mail, content, formatMailDateLong) {
    const subject = content?.subject || mail?.subject || '(No Subject)'
    const plainBody = content?.plain_body || htmlToPlainText(content?.html_body) || '(No content)'

    return normalizeCrlf([
        `Subject: ${subject}`,
        `From: ${getMailSenderLabel(mail, content)}`,
        `To: ${mail?.recipient_to || ''}`,
        `CC: ${content?.cc || ''}`,
        `BCC: ${content?.bcc || ''}`,
        `Date: ${formatMailDateLong(content?.date || mail?.date) || ''}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        plainBody,
    ].join('\n'))
}

function buildFallbackEmlContent(mail, content, formatMailDateLong) {
    const subject = content?.subject || mail?.subject || '(No Subject)'
    const plainBody = content?.plain_body || htmlToPlainText(content?.html_body) || '(No content)'

    return normalizeCrlf([
        `Subject: ${subject}`,
        `From: ${getMailSenderLabel(mail, content)}`,
        `To: ${mail?.recipient_to || ''}`,
        `CC: ${content?.cc || ''}`,
        `BCC: ${content?.bcc || ''}`,
        `Date: ${formatMailDateLong(content?.date || mail?.date) || ''}`,
        'MIME-Version: 1.0',
        'Content-Type: text/plain; charset=UTF-8',
        'Content-Transfer-Encoding: 8bit',
        '',
        plainBody,
    ].join('\n'))
}

function wrapPdfLine(line, maxLength) {
    const chunks = []
    let remaining = line.trimEnd()

    if (!remaining) return ['']

    while (remaining.length > maxLength) {
        let splitAt = remaining.lastIndexOf(' ', maxLength)
        if (splitAt <= 0) splitAt = maxLength
        chunks.push(remaining.slice(0, splitAt).trimEnd())
        remaining = remaining.slice(splitAt).trimStart()
    }

    chunks.push(remaining)
    return chunks
}

function escapePdfText(value) {
    const normalized = (value || '')
        .normalize('NFKD')
        .replace(/[^\x20-\x7E]/g, '?')
    return normalized
        .replace(/\\/g, '\\\\')
        .replace(/\(/g, '\\(')
        .replace(/\)/g, '\\)')
}

function buildSimplePdfBytes(text) {
    const encoder = new TextEncoder()
    const wrappedLines = normalizeCrlf(text)
        .split('\r\n')
        .flatMap((line) => wrapPdfLine(line, 92))

    const pageHeight = 842
    const topY = 792
    const lineHeight = 16
    const bottomMargin = 48
    const linesPerPage = Math.max(1, Math.floor((topY - bottomMargin) / lineHeight))
    const pages = []

    for (let index = 0; index < wrappedLines.length; index += linesPerPage) {
        pages.push(wrappedLines.slice(index, index + linesPerPage))
    }
    if (pages.length === 0) pages.push([''])

    const fontObjectId = 3 + (pages.length * 2)
    const objects = [
        '1 0 obj << /Type /Catalog /Pages 2 0 R >> endobj',
        `2 0 obj << /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, pageIndex) => `${3 + (pageIndex * 2)} 0 R`).join(' ')}] >> endobj`,
    ]

    pages.forEach((pageLines, pageIndex) => {
        const pageObjectId = 3 + (pageIndex * 2)
        const contentObjectId = pageObjectId + 1
        const streamLines = ['BT', '/F1 11 Tf', `48 ${topY} Td`]

        pageLines.forEach((line, lineIndex) => {
            if (lineIndex > 0) streamLines.push(`0 -${lineHeight} Td`)
            streamLines.push(`(${escapePdfText(line)}) Tj`)
        })
        streamLines.push('ET')

        const stream = `${streamLines.join('\n')}\n`
        const streamBytes = encoder.encode(stream)

        objects.push(
            `${pageObjectId} 0 obj << /Type /Page /Parent 2 0 R /MediaBox [0 0 595 ${pageHeight}] /Resources << /Font << /F1 ${fontObjectId} 0 R >> >> /Contents ${contentObjectId} 0 R >> endobj`,
        )
        objects.push(
            `${contentObjectId} 0 obj << /Length ${streamBytes.length} >> stream\n${stream}endstream\nendobj`,
        )
    })

    objects.push(`${fontObjectId} 0 obj << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> endobj`)

    let pdf = '%PDF-1.4\n'
    const offsets = [0]

    objects.forEach((object) => {
        offsets.push(pdf.length)
        pdf += `${object}\n`
    })

    const xrefOffset = pdf.length
    pdf += `xref\n0 ${objects.length + 1}\n`
    pdf += '0000000000 65535 f \n'
    offsets.slice(1).forEach((offset) => {
        pdf += `${offset.toString().padStart(10, '0')} 00000 n \n`
    })
    pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF`

    return encoder.encode(pdf)
}

async function saveBlobWithPicker(blob, options) {
    const { suggestedName, types } = options

    try {
        const [{ save }, { invoke }] = await Promise.all([
            import('@tauri-apps/plugin-dialog'),
            import('@tauri-apps/api/core'),
        ])
        const filters = Array.isArray(types)
            ? types.map((entry) => ({
                name: entry.description || 'File',
                extensions: Object.values(entry.accept || {})
                    .flat()
                    .map((extension) => extension.replace(/^\./, '')),
            })).filter((entry) => entry.extensions.length > 0)
            : []
        const selectedPath = await save({
            title: 'Save File',
            defaultPath: suggestedName,
            filters,
        })
        if (!selectedPath) {
            throw new DOMException('Save cancelled', 'AbortError')
        }
        const bytes = Array.from(new Uint8Array(await blob.arrayBuffer()))
        await invoke('save_export_file_to_path', {
            path: selectedPath,
            bytes,
        })
        return
    } catch (error) {
        if (error?.name === 'AbortError') throw error
        console.error('Native save dialog failed, falling back to browser download:', error)
        // Fall back to browser-specific save flows.
    }

    if (typeof window.showSaveFilePicker === 'function') {
        try {
            const handle = await window.showSaveFilePicker({ suggestedName, types })
            const writable = await handle.createWritable()
            await writable.write(blob)
            await writable.close()
            return
        } catch (error) {
            if (error?.name === 'AbortError') throw error
        }
    }

    const url = URL.createObjectURL(blob)
    const link = document.createElement('a')
    link.href = url
    link.download = suggestedName
    document.body.appendChild(link)
    link.click()
    link.remove()
    window.setTimeout(() => URL.revokeObjectURL(url), 1000)
}

function printMailHtml(html) {
    return new Promise((resolve, reject) => {
        const frame = document.createElement('iframe')
        frame.style.position = 'fixed'
        frame.style.right = '0'
        frame.style.bottom = '0'
        frame.style.width = '0'
        frame.style.height = '0'
        frame.style.border = '0'

        const cleanup = () => {
            window.setTimeout(() => frame.remove(), 1000)
        }

        frame.onload = () => {
            const targetWindow = frame.contentWindow
            if (!targetWindow) {
                cleanup()
                reject(new Error('Print view could not be created.'))
                return
            }

            let settled = false
            const settle = () => {
                if (settled) return
                settled = true
                cleanup()
                resolve()
            }

            const handleAfterPrint = () => {
                targetWindow.removeEventListener('afterprint', handleAfterPrint)
                settle()
            }

            targetWindow.addEventListener('afterprint', handleAfterPrint)
            window.setTimeout(() => {
                try {
                    targetWindow.focus()
                    targetWindow.print()
                    window.setTimeout(settle, 1500)
                } catch (error) {
                    targetWindow.removeEventListener('afterprint', handleAfterPrint)
                    cleanup()
                    reject(error)
                }
            }, 120)
        }

        document.body.appendChild(frame)
        frame.srcdoc = html
    })
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
    const [tabs, setTabs] = useState([])
    const [activeTabId, setActiveTabId] = useState(null)
    const [tabContents, setTabContents] = useState({})
    const [loadingTab, setLoadingTab] = useState(false)

    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
    const [isMailFullscreen, setIsMailFullscreen] = useState(false)
    const [isSyncing, setIsSyncing] = useState(false)
    const [actionNotices, setActionNotices] = useState([])
    const [noticeNow, setNoticeNow] = useState(Date.now())

    const accountButtonRef = useRef(null)
    const accountMenuRef = useRef(null)
    const iframeRef = useRef(null)
    const syncAbortRef = useRef(null)
    const isSyncingRef = useRef(false)
    const nextMailWindowId = useRef(0)
    const nextTabId = useRef(0)
    const nextNoticeIdRef = useRef(0)
    const pendingNoticeActionsRef = useRef(new Map())
    const prevCanUseRemoteMailRef = useRef(false)
    const lastConnectAttemptAtRef = useRef(0)
    const canUseRemoteMail = backendReachable && networkOnline && (remoteMailAvailable || connected)
    const totalCount = Array.isArray(mails) ? mails.length : 0
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
        if (actionNotices.length === 0) return undefined
        const timer = window.setInterval(() => setNoticeNow(Date.now()), 100)
        return () => window.clearInterval(timer)
    }, [actionNotices.length])

    useEffect(() => () => {
        pendingNoticeActionsRef.current.forEach((entry) => window.clearTimeout(entry.timeoutId))
        pendingNoticeActionsRef.current.clear()
    }, [])

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
            const pageSize = 250
            const allMails = []
            let totalCount = null
            let nextPage = 1

            while (true) {
                const res = await fetch(
                    apiUrl(`/api/offline/${accountId}/local-list?mailbox=${encodeURIComponent(folder)}&page=${nextPage}&per_page=${pageSize}`),
                    { cache: 'no-store' },
                )
                if (!res.ok) break

                const data = await res.json()
                const chunk = Array.isArray(data.mails) ? data.mails : []
                if (typeof data.total_count === 'number') {
                    totalCount = data.total_count
                }
                allMails.push(...chunk)

                if (chunk.length === 0) break
                if (typeof totalCount === 'number' && allMails.length >= totalCount) break
                if (chunk.length < pageSize) break
                nextPage += 1
            }

            setMails(allMails)
            setCacheMailTotal(typeof totalCount === 'number' ? totalCount : allMails.length)
            return true
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
            const pageSize = 250
            const allMails = []
            let totalCount = null
            let nextPage = 1

            while (!abort.signal.aborted) {
                const res = await fetch(
                    apiUrl(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=${nextPage}&per_page=${pageSize}`),
                    { cache: 'no-store', signal: abort.signal },
                )
                if (!res.ok) break

                const data = await res.json()
                const chunk = Array.isArray(data.mails) ? data.mails : []
                if (typeof data.total_count === 'number') {
                    totalCount = data.total_count
                }
                allMails.push(...chunk)

                if (chunk.length === 0) break
                if (typeof totalCount === 'number' && allMails.length >= totalCount) break
                if (chunk.length < pageSize) break
                nextPage += 1
            }

            if (abort.signal.aborted === false) {
                setMails(allMails)
                setRemoteMailTotal(typeof totalCount === 'number' ? totalCount : allMails.length)
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
    }, [activeSection, backendReachable, selectedFolder])

    useEffect(() => {
        if (activeSection !== 'mail' || !backendReachable) return

        let cancelled = false
        const folder = selectedFolder

        loadMailsFromCache(folder, 1, 250).then(() => {
            if (cancelled || !canUseRemoteMail) return
            syncMailsFromRemote(folder, 1, 250)
        })

        return () => {
            cancelled = true
        }
    }, [activeSection, backendReachable, canUseRemoteMail, selectedFolder, loadMailsFromCache, syncMailsFromRemote])

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
                if (mail.seen !== true) {
                    setMailsSeenState([mail.id], true)
                }

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

    const queueAction = async (actionType, targetUid, payload = {}, targetFolderOverride = null) => {
        if (!accountId || !backendReachable) return
        await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action_type: actionType,
                target_uid: targetUid || null,
                target_folder: targetFolderOverride || selectedFolder || 'INBOX',
                payload,
            }),
        })
        refreshStatus(accountId)
        if (networkOnline) {
            flushQueue(accountId)
        }
    }

    const dismissActionNotice = useCallback((noticeId) => {
        setActionNotices((prev) => prev.filter((notice) => notice.id !== noticeId))
    }, [])

    const enqueueUndoableAction = useCallback(({ label, apply, undo, commit }) => {
        nextNoticeIdRef.current += 1
        const id = nextNoticeIdRef.current
        const durationMs = 10_000
        const expiresAt = Date.now() + durationMs

        apply()
        setActionNotices((prev) => [...prev, { id, label, durationMs, expiresAt }])

        const timeoutId = window.setTimeout(async () => {
            const pending = pendingNoticeActionsRef.current.get(id)
            if (!pending) return
            pendingNoticeActionsRef.current.delete(id)
            try {
                await pending.commit()
            } finally {
                dismissActionNotice(id)
            }
        }, durationMs)

        pendingNoticeActionsRef.current.set(id, { timeoutId, undo, commit })
    }, [dismissActionNotice])

    const undoActionNotice = useCallback((noticeId) => {
        const pending = pendingNoticeActionsRef.current.get(noticeId)
        if (!pending) return
        window.clearTimeout(pending.timeoutId)
        pendingNoticeActionsRef.current.delete(noticeId)
        pending.undo?.()
        dismissActionNotice(noticeId)
    }, [dismissActionNotice])

    const commitActionNotice = useCallback(async (noticeId) => {
        const pending = pendingNoticeActionsRef.current.get(noticeId)
        if (!pending) return
        window.clearTimeout(pending.timeoutId)
        pendingNoticeActionsRef.current.delete(noticeId)
        try {
            await pending.commit?.()
        } finally {
            dismissActionNotice(noticeId)
        }
    }, [dismissActionNotice])

    const restoreMailSelection = useCallback((selectionSnapshot) => {
        if (!selectionSnapshot) return
        setSelectedMail((prev) => prev || selectionSnapshot.mail)
        setMailContent((prev) => prev || selectionSnapshot.content)
    }, [])

    const deleteMailsOptimistic = async (mailIds) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        if (ids.length === 0) return
        const sourceFolder = selectedFolder || 'INBOX'
        const affectedMails = mails.filter((mail) => ids.includes(mail.id))
        const selectionSnapshot = selectedMail && ids.includes(selectedMail.id)
            ? { mail: selectedMail, content: mailContent }
            : null

        enqueueUndoableAction({
            label: ids.length === 1 ? 'Mail deleted' : `${ids.length} mails deleted`,
            apply: () => {
                setMails((prev) => prev.filter((mail) => !ids.includes(mail.id)))
                if (selectionSnapshot) {
                    setSelectedMail(null)
                    setMailContent(null)
                }
            },
            undo: () => {
                setMails((prev) => {
                    const existing = new Set(prev.map((mail) => mail.id))
                    return [...prev, ...affectedMails.filter((mail) => !existing.has(mail.id))]
                })
                restoreMailSelection(selectionSnapshot)
            },
            commit: () => Promise.all(ids.map((id) => queueAction('delete', id, {}, sourceFolder))),
        })
    }

    const moveMailsOptimistic = async (mailIds, destination) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        if (ids.length === 0 || !destination) return
        const sourceFolder = selectedFolder || 'INBOX'
        const destinationLabel = folderInfo(destination).label
        const affectedMails = mails.filter((mail) => ids.includes(mail.id))
        const selectionSnapshot = selectedMail && ids.includes(selectedMail.id)
            ? { mail: selectedMail, content: mailContent }
            : null

        enqueueUndoableAction({
            label: ids.length === 1 ? `Mail moved to ${destinationLabel}` : `${ids.length} mails moved to ${destinationLabel}`,
            apply: () => {
                setMails((prev) => prev.filter((mail) => !ids.includes(mail.id)))
                if (selectionSnapshot) {
                    setSelectedMail(null)
                    setMailContent(null)
                }
            },
            undo: () => {
                setMails((prev) => {
                    const existing = new Set(prev.map((mail) => mail.id))
                    return [...prev, ...affectedMails.filter((mail) => !existing.has(mail.id))]
                })
                restoreMailSelection(selectionSnapshot)
            },
            commit: () => Promise.all(ids.map((id) => queueAction('move', id, { destination }, sourceFolder))),
        })
    }

    const setMailsSeenState = async (mailIds, seen) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        if (ids.length === 0) return
        setMails((prev) => prev.map((mail) => (
            ids.includes(mail.id) ? { ...mail, seen } : mail
        )))
        setSelectedMail((prev) => (prev && ids.includes(prev.id) ? { ...prev, seen } : prev))
        const sourceFolder = selectedFolder || 'INBOX'
        await Promise.all(ids.map((id) => queueAction(seen ? 'mark_read' : 'mark_unread', id, {}, sourceFolder)))
    }

    const setMailsFlaggedState = async (mailIds, flagged) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        if (ids.length === 0) return
        const sourceFolder = selectedFolder || 'INBOX'
        const previousStates = mails
            .filter((mail) => ids.includes(mail.id))
            .map((mail) => ({ id: mail.id, flagged: mail.flagged }))
        const previousSelectedMail = selectedMail && ids.includes(selectedMail.id)
            ? { ...selectedMail }
            : null

        enqueueUndoableAction({
            label: flagged
                ? (ids.length === 1 ? 'Mail flagged' : `${ids.length} mails flagged`)
                : (ids.length === 1 ? 'Mail unflagged' : `${ids.length} mails unflagged`),
            apply: () => {
                setMails((prev) => prev.map((mail) => (
                    ids.includes(mail.id) ? { ...mail, flagged } : mail
                )))
                setSelectedMail((prev) => (prev && ids.includes(prev.id) ? { ...prev, flagged } : prev))
            },
            undo: () => {
                const previousMap = new Map(previousStates.map((item) => [item.id, item.flagged]))
                setMails((prev) => prev.map((mail) => (
                    previousMap.has(mail.id) ? { ...mail, flagged: previousMap.get(mail.id) } : mail
                )))
                if (previousSelectedMail) {
                    setSelectedMail((prev) => (prev && prev.id === previousSelectedMail.id ? previousSelectedMail : prev))
                }
            },
            commit: () => Promise.all(ids.map((id) => queueAction(flagged ? 'flag' : 'unflag', id, {}, sourceFolder))),
        })
    }

    const addMailLabel = async (mailIds, label) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        const trimmedLabel = label.trim()
        if (ids.length === 0 || !trimmedLabel) return
        const sourceFolder = selectedFolder || 'INBOX'
        const previousStates = mails
            .filter((mail) => ids.includes(mail.id))
            .map((mail) => ({ id: mail.id, category: mail.category }))

        enqueueUndoableAction({
            label: ids.length === 1 ? `Flag "${trimmedLabel}" applied` : `Flag "${trimmedLabel}" applied to ${ids.length} mails`,
            apply: () => {
                setMails((prev) => prev.map((mail) => (
                    ids.includes(mail.id) ? { ...mail, category: trimmedLabel } : mail
                )))
            },
            undo: () => {
                const previousMap = new Map(previousStates.map((item) => [item.id, item.category]))
                setMails((prev) => prev.map((mail) => (
                    previousMap.has(mail.id) ? { ...mail, category: previousMap.get(mail.id) } : mail
                )))
            },
            commit: () => Promise.all(ids.map((id) => queueAction('label_add', id, { label: trimmedLabel }, sourceFolder))),
        })
    }

    const createMailbox = async (name) => {
        const mailboxName = name.trim()
        if (!mailboxName || !accountId || !backendReachable) return false
        if (folders.includes(mailboxName)) return true

        try {
            if (networkOnline) {
                const ok = canUseRemoteMail || (await ensureImapConnected())
                if (ok) {
                    const res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ name: mailboxName }),
                    })
                    if (!res.ok) return false
                }
            }

            setFolders((prev) => (prev.includes(mailboxName) ? prev : [...prev, mailboxName]))
            await loadFolders()
            return true
        } catch {
            return false
        }
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
                            <Avatar
                                email={accountEmailLabel}
                                name={accountLabel}
                                accountId={accountId}
                                size={32}
                            />
                        </button>
                        {accountMenuOpen && (
                            <div className="account-popover" ref={accountMenuRef}>
                                <div className="account-popover__avatar">
                                    <Avatar
                                        email={accountEmailLabel}
                                        name={accountLabel}
                                        accountId={accountId}
                                        size={64}
                                    />
                                </div>
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
                                accountEmail={accountEmailLabel}
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
                                prefetchInlineAssets={prefetchInlineAssets}
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
                                deleteMailsOptimistic={deleteMailsOptimistic}
                                moveMailsOptimistic={moveMailsOptimistic}
                                setMailsSeenState={setMailsSeenState}
                                setMailsFlaggedState={setMailsFlaggedState}
                                addMailLabel={addMailLabel}
                                createMailbox={createMailbox}
                                canUseRemoteMail={canUseRemoteMail}
                                composeOpen={composeOpen}
                                setComposeOpen={setComposeOpen}
                                composeForm={composeForm}
                                setComposeForm={setComposeForm}
                                sendComposedMail={sendComposedMail}
                                tabs={tabs}
                                setTabs={setTabs}
                                activeTabId={activeTabId}
                                setActiveTabId={setActiveTabId}
                                tabContents={tabContents}
                                setTabContents={setTabContents}
                                loadingTab={loadingTab}
                                setLoadingTab={setLoadingTab}
                                nextTabId={nextTabId}
                            />
                        )}
                        {activeSection === 'calendar' && <CalendarSection />}
                        {activeSection === 'contacts' && <ContactsSection />}
                        {activeSection === 'todo' && <TodoSection />}
                    </div>
                </div>
            </div>
            {actionNotices.length > 0 && (
                <div className="db-action-notices" aria-live="polite">
                    {actionNotices.map((notice) => {
                        const remaining = Math.max(0, notice.expiresAt - noticeNow)
                        const progress = notice.durationMs > 0 ? (remaining / notice.durationMs) * 100 : 0
                        return (
                            <div key={notice.id} className="db-action-notice">
                                <div className="db-action-notice__body">
                                    <span className="db-action-notice__text">{notice.label}</span>
                                    <div className="db-action-notice__actions">
                                        <button
                                            type="button"
                                            className="db-action-notice__commit"
                                            onClick={() => commitActionNotice(notice.id)}
                                            aria-label="Apply now"
                                            title="Apply now"
                                        >
                                            ✓
                                        </button>
                                        <button
                                            type="button"
                                            className="db-action-notice__undo"
                                            onClick={() => undoActionNotice(notice.id)}
                                        >
                                            Undo
                                        </button>
                                    </div>
                                </div>
                                <div className="db-action-notice__progress">
                                    <span className="db-action-notice__progress-bar" style={{ width: `${progress}%` }} />
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}

function MailSection({
    accountId,
    accountEmail,
    backendReachable,
    networkOnline,
    ensureImapConnected,
    folders, selectedFolder, setSelectedFolder, mails,
    selectedMail, setSelectedMail, mailContent, setMailContent, loadingMails, loadingContent,
    connecting, loadMails, loadMailsFromCache, syncMailsFromRemote, prefetchInlineAssets, isSyncing,
    openMail, detachMailToWindow, detachMailToWindowFromList, iframeRef, getShortTime,
    currentPage, setCurrentPage, maxPage, perPage, setPerPage,
    isMailFullscreen, toggleMailFullscreen,
    deleteMailsOptimistic, moveMailsOptimistic, setMailsSeenState, setMailsFlaggedState, addMailLabel, createMailbox,
    canUseRemoteMail, composeOpen, setComposeOpen, composeForm, setComposeForm, sendComposedMail,
    tabs, setTabs, activeTabId, setActiveTabId, tabContents, setTabContents, loadingTab, setLoadingTab, nextTabId,
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
    const [isSelectionMenuOpen, setIsSelectionMenuOpen] = useState(false)
    const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false)
    const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
    const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false)
    const [isFlagMenuOpen, setIsFlagMenuOpen] = useState(false)
    const [activeFilter, setActiveFilter] = useState('all')
    const [sortBy, setSortBy] = useState('date')
    const [sortDirection, setSortDirection] = useState('desc')
    const [customFlagLabels, setCustomFlagLabels] = useState([])
    const [isPerPageOpen, setIsPerPageOpen] = useState(false)
    const [attachmentsExpanded, setAttachmentsExpanded] = useState(true)
    const [fileActionLoading, setFileActionLoading] = useState('')
    const [layoutCols, setLayoutCols] = useState(1)
    const [movePopoverStyle, setMovePopoverStyle] = useState(null)
    const [flagPopoverStyle, setFlagPopoverStyle] = useState(null)
    const [mailItemMenu, setMailItemMenu] = useState(null)
    const [mailItemMoveMenuStyle, setMailItemMoveMenuStyle] = useState(null)
    const displayCols = isMailFullscreen ? layoutCols : 1
    const perPageValue = Math.max(1, Number.parseInt(perPage, 10) || 50)

    const visibleMails = useMemo(() => {
        const copy = Array.isArray(mails) ? mails.slice() : []
        const accountEmailNormalized = normalizeMailText(accountEmail)
        const dateMs = (m) => {
            const t = Date.parse(m?.date || '')
            return Number.isFinite(t) ? t : 0
        }
        const uidNum = (m) => {
            const n = Number.parseInt(m?.id ?? '', 10)
            return Number.isFinite(n) ? n : 0
        }
        const cmpText = (left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' })
        const applyDirection = (value) => (sortDirection === 'asc' ? value : -value)

        const filtered = copy.filter((mail) => {
            if (activeFilter === 'unread') return mail.seen !== true
            if (activeFilter === 'flagged') return mail.flagged === true
            if (activeFilter === 'toMe') {
                if (!accountEmailNormalized) return false
                return normalizeMailText(mail.recipient_to).includes(accountEmailNormalized)
            }
            return true
        })

        filtered.sort((a, b) => {
            let result = 0

            if (sortBy === 'date') {
                result = dateMs(a) - dateMs(b)
            } else if (sortBy === 'from') {
                result = cmpText(
                    normalizeMailText(a?.name || a?.address),
                    normalizeMailText(b?.name || b?.address),
                )
            } else if (sortBy === 'category') {
                result = cmpText(getMailCategory(a), getMailCategory(b))
            } else if (sortBy === 'flagStatus') {
                result = Number(a?.flagged === true) - Number(b?.flagged === true)
            } else if (sortBy === 'size') {
                result = (Number(a?.size) || 0) - (Number(b?.size) || 0)
            } else if (sortBy === 'subject') {
                result = cmpText(normalizeMailText(a?.subject), normalizeMailText(b?.subject))
            } else if (sortBy === 'type') {
                result = cmpText(getMailType(a), getMailType(b))
            }

            result = applyDirection(result)
            if (result !== 0) return result

            const dateFallback = dateMs(b) - dateMs(a)
            if (dateFallback !== 0) return dateFallback
            return uidNum(b) - uidNum(a)
        })
        return filtered
    }, [accountEmail, activeFilter, mails, sortBy, sortDirection])

    const filteredMaxPage = Math.max(1, Math.ceil(visibleMails.length / perPageValue))
    const displayPage = Math.min(currentPage, filteredMaxPage)
    const pageStart = (displayPage - 1) * perPageValue
    const pagedVisibleMails = visibleMails.slice(pageStart, pageStart + perPageValue)
    const selectedIdSet = selectedMailIds
    const actionableMails = useMemo(() => {
        if (selectedIdSet.size > 0) {
            return mails.filter((mail) => selectedIdSet.has(mail.id))
        }
        if (selectedMail) return [selectedMail]
        return []
    }, [mails, selectedIdSet, selectedMail])
    const actionableMailIds = actionableMails.map((mail) => mail.id)
    const hasAnyActionMail = actionableMails.length > 0
    const hasMultipleActionMails = actionableMails.length > 1
    const allActionMailsSeen = hasAnyActionMail && actionableMails.every((mail) => mail.seen === true)
    const allActionMailsFlagged = hasAnyActionMail && actionableMails.every((mail) => mail.flagged === true)
    const homeReplyLabel = hasMultipleActionMails ? 'Reply All' : 'Reply'
    const homeForwardLabel = hasMultipleActionMails ? 'Forward All' : 'Forward'
    const readToggleLabel = allActionMailsSeen ? 'Unread' : 'Read'
    const flagToggleLabel = allActionMailsFlagged ? 'Unflag' : 'Flag'
    const moveFolderOptions = useMemo(() => folders.filter(isMoveTargetMailbox), [folders])
    const availableFlagLabels = useMemo(() => {
        const builtInLabels = folders
            .filter(isLabelMailbox)
            .map(stripLabelFolderPrefix)
            .filter(Boolean)
        const existingMailLabels = mails
            .map((mail) => (mail?.category || '').trim())
            .filter(Boolean)

        return Array.from(new Set([...builtInLabels, ...existingMailLabels, ...customFlagLabels]))
            .sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }))
    }, [customFlagLabels, folders, mails])
    const ensureLabelExists = async (label) => {
        const mailboxName = applyMailboxNamespace(label, getMailboxNamespacePrefix(folders, ['Labels', 'Etiketler']))
        if (!mailboxName || mailboxName === label) return true
        return createMailbox(mailboxName)
    }
    const selectionRequiredTitle = hasAnyActionMail ? undefined : 'Select a mail first'

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

    const composeDraft = useCallback((draft) => {
        setComposeForm({
            to: draft.to || '',
            cc: draft.cc || '',
            bcc: draft.bcc || '',
            subject: draft.subject || '',
            body: draft.body || '',
        })
        setComposeOpen(true)
    }, [setComposeForm, setComposeOpen])

    const prefixSubject = (prefix, subject) => {
        const baseSubject = (subject || '(No Subject)').trim()
        return baseSubject.toLowerCase().startsWith(`${prefix.toLowerCase()} `)
            ? baseSubject
            : `${prefix} ${baseSubject}`
    }

    const loadMailContentForDraft = useCallback(async (mail) => {
        if (!mail) return null
        if (selectedMail?.id === mail.id && mailContent) return mailContent

        try {
            const mailbox = selectedFolder || 'INBOX'
            let endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
            let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            if (!res.ok && canUseRemoteMail) {
                endpoint = `/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            }
            if (res.ok) {
                return await res.json()
            }
        } catch {
            return null
        }

        return null
    }, [accountId, canUseRemoteMail, mailContent, selectedFolder, selectedMail])

    const fetchMailRawBytes = useCallback(async (mail) => {
        if (!mail || !accountId) return null

        const mailbox = selectedFolder || 'INBOX'
        const candidates = canUseRemoteMail
            ? [
                `/api/mail/${accountId}/raw/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
                `/api/offline/${accountId}/local-raw/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
            ]
            : [
                `/api/offline/${accountId}/local-raw/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
                `/api/mail/${accountId}/raw/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
            ]

        for (const endpoint of candidates) {
            try {
                const response = await fetch(apiUrl(endpoint), { cache: 'no-store' })
                if (!response.ok) continue
                return new Uint8Array(await response.arrayBuffer())
            } catch {
                // Try next source.
            }
        }

        return null
    }, [accountId, canUseRemoteMail, selectedFolder])

    const dedupeEmails = (values) => {
        const seen = new Set()
        return values.filter((value) => {
            const email = value.trim()
            const key = email.toLowerCase()
            if (!email || seen.has(key)) return false
            seen.add(key)
            return true
        })
    }

    const parseEmailList = (value) => value
        .split(',')
        .map((item) => item.trim())
        .filter(Boolean)

    const buildQuotedMailBlock = (mail, content) => {
        const fromLabel = content?.from_name
            ? `${content.from_name} <${content.from_address}>`
            : (mail.name ? `${mail.name} <${mail.address}>` : mail.address)
        const subject = content?.subject || mail.subject || '(No Subject)'
        const date = content?.date || mail.date
        const body = content?.plain_body || '(No content)'
        return [
            `From: ${fromLabel || 'Unknown'}`,
            `Date: ${formatMailDateLong(date)}`,
            `Subject: ${subject}`,
            '',
            body,
        ].join('\n')
    }

    const runFileAction = useCallback(async (actionKey, action) => {
        if (!selectedMail || fileActionLoading) return
        setFileActionLoading(actionKey)
        try {
            const content = await loadMailContentForDraft(selectedMail)
            await action(selectedMail, content)
        } catch (error) {
            if (error?.name !== 'AbortError') {
                console.error(`File action "${actionKey}" failed:`, error)
                window.alert(error?.message || 'The file action failed.')
            }
        } finally {
            setFileActionLoading('')
        }
    }, [fileActionLoading, loadMailContentForDraft, selectedMail])

    const handleDownloadHtml = useCallback(() => {
        runFileAction('html', async (mail, content) => {
            const html = buildMailHtmlDocument(mail, content, formatMailDateLong)
            const fileName = `${buildExportBaseName(mail, content)}.html`
            await saveBlobWithPicker(
                new Blob([html], { type: 'text/html;charset=utf-8' }),
                {
                    suggestedName: fileName,
                    types: [{ description: 'HTML file', accept: { 'text/html': ['.html'] } }],
                },
            )
        })
    }, [formatMailDateLong, runFileAction])

    const handleDownloadMsg = useCallback(() => {
        runFileAction('msg', async (mail, content) => {
            const rawBytes = await fetchMailRawBytes(mail)
            const fileName = `${buildExportBaseName(mail, content)}.msg`
            const blob = rawBytes
                ? new Blob([rawBytes], { type: 'application/vnd.ms-outlook' })
                : new Blob(
                    [buildFallbackMsgContent(mail, content, formatMailDateLong)],
                    { type: 'application/vnd.ms-outlook;charset=utf-8' },
                )

            await saveBlobWithPicker(blob, {
                suggestedName: fileName,
                types: [{ description: 'MSG file', accept: { 'application/vnd.ms-outlook': ['.msg'] } }],
            })
        })
    }, [fetchMailRawBytes, formatMailDateLong, runFileAction])

    const handleDownloadEml = useCallback(() => {
        runFileAction('eml', async (mail, content) => {
            const rawBytes = await fetchMailRawBytes(mail)
            const fileName = `${buildExportBaseName(mail, content)}.eml`
            const blob = rawBytes
                ? new Blob([rawBytes], { type: 'message/rfc822' })
                : new Blob(
                    [buildFallbackEmlContent(mail, content, formatMailDateLong)],
                    { type: 'message/rfc822;charset=utf-8' },
                )

            await saveBlobWithPicker(blob, {
                suggestedName: fileName,
                types: [{ description: 'EML file', accept: { 'message/rfc822': ['.eml'] } }],
            })
        })
    }, [fetchMailRawBytes, formatMailDateLong, runFileAction])

    const handleDownloadPdf = useCallback(() => {
        runFileAction('pdf', async (mail, content) => {
            const pdfBytes = buildSimplePdfBytes(buildMailPlainText(mail, content, formatMailDateLong))
            const fileName = `${buildExportBaseName(mail, content)}.pdf`
            await saveBlobWithPicker(new Blob([pdfBytes], { type: 'application/pdf' }), {
                suggestedName: fileName,
                types: [{ description: 'PDF file', accept: { 'application/pdf': ['.pdf'] } }],
            })
        })
    }, [formatMailDateLong, runFileAction])

    const handlePrintMail = useCallback(() => {
        runFileAction('print', async (mail, content) => {
            const html = buildMailHtmlDocument(mail, content, formatMailDateLong)
            await printMailHtml(html)
        })
    }, [formatMailDateLong, runFileAction])

    const buildMultiMailSummary = (mailList) => (
        mailList.map((mail) => {
            const sender = mail.name || mail.address || 'Unknown'
            const subject = mail.subject || '(No Subject)'
            return `- ${sender}: ${subject}`
        }).join('\n')
    )

    const closeMailItemMenu = useCallback(() => {
        setMailItemMenu(null)
        setMailItemMoveMenuStyle(null)
    }, [])

    const closeActionMenus = () => {
        setIsMoveMenuOpen(false)
        setIsFlagMenuOpen(false)
        closeMailItemMenu()
    }

    const resetBulkSelection = () => {
        setSelectedMailIds(new Set())
        setSelectMode(false)
    }

    const resolveFolderDestination = (kind) => {
        const match = folders.find((folder) => folderInfo(folder).label === kind)
        if (match) return match
        return kind
    }

    const perPageRef = useRef(null)
    const selectionMenuRef = useRef(null)
    const filterMenuRef = useRef(null)
    const sortMenuRef = useRef(null)
    const submenuScrollRef = useRef(null)
    const moveMenuRef = useRef(null)
    const flagMenuRef = useRef(null)
    const mailItemMenuRef = useRef(null)
    const isResizingFolder = useRef(false)
    const isResizingList = useRef(false)
    const mailToolbarRef = useRef(null)

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

    const clampFloatingMenuPosition = useCallback((left, top, estimatedWidth = 220, estimatedHeight = 320) => ({
        left: `${Math.min(
            Math.max(12, left),
            Math.max(12, window.innerWidth - estimatedWidth - 12),
        )}px`,
        top: `${Math.min(
            Math.max(12, top),
            Math.max(12, window.innerHeight - estimatedHeight - 12),
        )}px`,
    }), [])

    const openMailItemMenuAt = useCallback((mail, left, top) => {
        setMailItemMoveMenuStyle(null)
        setMailItemMenu({
            mail,
            moveMenuOpen: false,
            style: clampFloatingMenuPosition(left, top),
        })
    }, [clampFloatingMenuPosition])

    const openMailItemMenuFromButton = useCallback((event, mail) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        openMailItemMenuAt(mail, rect.right - 220, rect.top)
    }, [openMailItemMenuAt])

    const openMailItemMenuFromContext = useCallback((event, mail) => {
        event.preventDefault()
        event.stopPropagation()
        openMailItemMenuAt(mail, event.clientX, event.clientY)
    }, [openMailItemMenuAt])

    const toggleMailItemMoveMenu = useCallback((event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setMailItemMoveMenuStyle(clampFloatingMenuPosition(rect.right + 6, rect.top, 240, 320))
        setMailItemMenu((prev) => {
            if (!prev) return prev
            return { ...prev, moveMenuOpen: !prev.moveMenuOpen }
        })
    }, [clampFloatingMenuPosition])

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
    const tabIframeRefs = useRef({})

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
        if (mail.seen !== true) {
            setMailsSeenState([mail.id], true)
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
        if (!accountId) return
        try {
            const raw = localStorage.getItem(`gv-custom-flags-${accountId}`)
            const next = JSON.parse(raw || '[]')
            setCustomFlagLabels(Array.isArray(next) ? next.filter(Boolean) : [])
        } catch {
            setCustomFlagLabels([])
        }
    }, [accountId])

    useEffect(() => {
        if (!accountId) return
        localStorage.setItem(`gv-custom-flags-${accountId}`, JSON.stringify(customFlagLabels))
    }, [accountId, customFlagLabels])

    useEffect(() => {
        const handleClickOutside = (e) => {
            if (perPageRef.current && !perPageRef.current.contains(e.target)) {
                setIsPerPageOpen(false)
            }
            if (selectionMenuRef.current && !selectionMenuRef.current.contains(e.target)) {
                setIsSelectionMenuOpen(false)
            }
            if (filterMenuRef.current && !filterMenuRef.current.contains(e.target)) {
                setIsFilterMenuOpen(false)
            }
            if (sortMenuRef.current && !sortMenuRef.current.contains(e.target)) {
                setIsSortMenuOpen(false)
            }
            if (moveMenuRef.current && !moveMenuRef.current.contains(e.target)) {
                setIsMoveMenuOpen(false)
            }
            if (flagMenuRef.current && !flagMenuRef.current.contains(e.target)) {
                setIsFlagMenuOpen(false)
            }
            if (mailItemMenuRef.current && !mailItemMenuRef.current.contains(e.target)) {
                closeMailItemMenu()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [closeMailItemMenu])

    useEffect(() => {
        if (!isMoveMenuOpen && !isFlagMenuOpen) {
            setMovePopoverStyle(null)
            setFlagPopoverStyle(null)
            return
        }

        const sync = () => {
            if (isMoveMenuOpen) {
                syncPopoverPosition(moveMenuRef, setMovePopoverStyle)
            }
            if (isFlagMenuOpen) {
                syncPopoverPosition(flagMenuRef, setFlagPopoverStyle)
            }
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
    }, [activeRibbonTab, activeTabId, isFlagMenuOpen, isMoveMenuOpen, syncPopoverPosition])

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                if (mailItemMenu) {
                    closeMailItemMenu()
                    return
                }
                if (isFlagMenuOpen) {
                    setIsFlagMenuOpen(false)
                    return
                }
                if (isMoveMenuOpen) {
                    setIsMoveMenuOpen(false)
                    return
                }
                if (isSortMenuOpen) {
                    setIsSortMenuOpen(false)
                    return
                }
                if (isFilterMenuOpen) {
                    setIsFilterMenuOpen(false)
                    return
                }
                if (isSelectionMenuOpen) {
                    setIsSelectionMenuOpen(false)
                    return
                }
                if (selectMode) {
                    setSelectMode(false)
                    setSelectedMailIds(new Set())
                } else if (selectedMail) {
                    setSelectedMail(null)
                    setMailContent(null)
                }
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [closeMailItemMenu, isFilterMenuOpen, isFlagMenuOpen, isMoveMenuOpen, isSelectionMenuOpen, isSortMenuOpen, mailItemMenu, selectMode, selectedMail, setMailContent, setSelectedMail])

    useEffect(() => {
        if (!mailItemMenu) return
        const closeOnViewportChange = () => closeMailItemMenu()
        window.addEventListener('resize', closeOnViewportChange)
        window.addEventListener('scroll', closeOnViewportChange, true)
        return () => {
            window.removeEventListener('resize', closeOnViewportChange)
            window.removeEventListener('scroll', closeOnViewportChange, true)
        }
    }, [closeMailItemMenu, mailItemMenu])

    useEffect(() => {
        if (sortBy === 'importance') {
            setSortBy('date')
        }
    }, [sortBy])

    useEffect(() => {
        setCurrentPage(1)
    }, [activeFilter, sortBy, sortDirection, setCurrentPage])

    useEffect(() => {
        if (currentPage > filteredMaxPage) {
            setCurrentPage(filteredMaxPage)
        }
    }, [currentPage, filteredMaxPage, setCurrentPage])

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
            if (next.size === 0) {
                setTimeout(() => setSelectMode(false), 0)
            }
            return next
        })
    }

    const handleMailSelectionToggle = (event, mailId) => {
        event.stopPropagation()
        setSelectMode(true)
        toggleMailSelected(mailId)
    }

    const applyBulkSelection = useCallback((scope) => {
        const nextSelectedIds = visibleMails
            .filter((mail) => {
                if (scope === 'read') return mail.seen === true
                if (scope === 'unread') return mail.seen !== true
                return true
            })
            .map((mail) => mail.id)

        setSelectedMailIds(new Set(nextSelectedIds))
        setSelectMode(nextSelectedIds.length > 0)
        setIsSelectionMenuOpen(false)
    }, [visibleMails])

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

    const handleNewMail = () => {
        composeDraft({ to: '', cc: '', bcc: '', subject: '', body: '' })
    }

    const handleDeleteAction = async () => {
        if (!hasAnyActionMail) return
        await deleteMailsOptimistic(actionableMailIds)
        closeActionMenus()
        resetBulkSelection()
    }

    const handleMoveAction = async (destination) => {
        if (!hasAnyActionMail || !destination) return
        await moveMailsOptimistic(actionableMailIds, destination)
        closeActionMenus()
        resetBulkSelection()
    }

    const handleArchiveAction = async () => {
        if (!hasAnyActionMail) return
        await handleMoveAction(resolveFolderDestination('Archive'))
    }

    const handleMoveToTrashAction = async () => {
        if (!hasAnyActionMail) return
        await handleMoveAction(resolveFolderDestination('Trash'))
    }

    const handleReadToggleAction = async () => {
        if (!hasAnyActionMail) return
        await setMailsSeenState(actionableMailIds, !allActionMailsSeen)
    }

    const handleFlagToggleAction = async () => {
        if (!hasAnyActionMail) return
        await setMailsFlaggedState(actionableMailIds, !allActionMailsFlagged)
        closeActionMenus()
    }

    const handleFlagLabelAction = async (label) => {
        if (!hasAnyActionMail || !label) return
        await addMailLabel(actionableMailIds, label)
        closeActionMenus()
    }

    const handleCreateFolderAndMove = async () => {
        if (!hasAnyActionMail) return
        const name = window.prompt('New folder name')
        if (!name) return
        const mailboxName = applyMailboxNamespace(name, getMailboxNamespacePrefix(folders, ['Folders']))
        const created = await createMailbox(mailboxName)
        if (created) {
            await handleMoveAction(mailboxName)
        }
    }

    const handleCreateFlagLabel = async () => {
        if (!hasAnyActionMail) return
        const name = window.prompt('New flag name')
        const trimmed = (name || '').trim()
        if (!trimmed) return
        setCustomFlagLabels((prev) => (
            prev.includes(trimmed) ? prev : [...prev, trimmed]
        ))
        await ensureLabelExists(trimmed)
        await handleFlagLabelAction(trimmed)
    }

    const composeReplyDraft = async (mailList) => {
        const replyMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (replyMails.length === 0) return

        if (replyMails.length > 1) {
            const recipients = dedupeEmails(replyMails.map((mail) => mail.address || ''))
            composeDraft({
                to: recipients.join(', '),
                subject: 'Re: Selected mails',
                body: `\n\n${buildMultiMailSummary(replyMails)}`,
            })
            return
        }

        const mail = replyMails[0]
        const content = await loadMailContentForDraft(mail)
        composeDraft({
            to: mail.address || '',
            cc: dedupeEmails(parseEmailList(content?.cc || '')).join(', '),
            subject: prefixSubject('Re:', content?.subject || mail.subject),
            body: `\n\n${buildQuotedMailBlock(mail, content)}`,
        })
    }

    const composeForwardDraft = async (mailList) => {
        const forwardMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (forwardMails.length === 0) return

        if (forwardMails.length > 1) {
            composeDraft({
                to: '',
                subject: `Fwd: ${forwardMails.length} mails`,
                body: buildMultiMailSummary(forwardMails),
            })
            return
        }

        const mail = forwardMails[0]
        const content = await loadMailContentForDraft(mail)
        composeDraft({
            to: '',
            subject: prefixSubject('Fwd:', content?.subject || mail.subject),
            body: buildQuotedMailBlock(mail, content),
        })
    }

    const handleReplyAction = async () => {
        if (!hasAnyActionMail) return
        await composeReplyDraft(actionableMails)
    }

    const handleForwardAction = async () => {
        if (!hasAnyActionMail) return
        await composeForwardDraft(actionableMails)
    }

    const handleMailItemMenuDelete = async () => {
        if (!mailItemMenu?.mail) return
        await deleteMailsOptimistic([mailItemMenu.mail.id])
        closeMailItemMenu()
    }

    const handleMailItemMenuMove = async (destination) => {
        if (!mailItemMenu?.mail || !destination) return
        await moveMailsOptimistic([mailItemMenu.mail.id], destination)
        closeMailItemMenu()
    }

    const handleMailItemMenuMoveToTrash = async () => {
        if (!mailItemMenu?.mail) return
        await handleMailItemMenuMove(resolveFolderDestination('Trash'))
    }

    const handleMailItemMenuArchive = async () => {
        if (!mailItemMenu?.mail) return
        await handleMailItemMenuMove(resolveFolderDestination('Archive'))
    }

    const handleMailItemMenuReply = async () => {
        if (!mailItemMenu?.mail) return
        await composeReplyDraft([mailItemMenu.mail])
        closeMailItemMenu()
    }

    const handleMailItemMenuForward = async () => {
        if (!mailItemMenu?.mail) return
        await composeForwardDraft([mailItemMenu.mail])
        closeMailItemMenu()
    }

    const handleMailItemMenuReadToggle = async () => {
        if (!mailItemMenu?.mail) return
        await setMailsSeenState([mailItemMenu.mail.id], mailItemMenu.mail.seen !== true)
        closeMailItemMenu()
    }

    const handleMailItemMenuFlagToggle = async () => {
        if (!mailItemMenu?.mail) return
        await setMailsFlaggedState([mailItemMenu.mail.id], mailItemMenu.mail.flagged !== true)
        closeMailItemMenu()
    }

    const activeTab = tabs.find(t => t.id === activeTabId)
    const activeTabContent = activeTabId ? tabContents[activeTabId] : null
    const activeTabMail = activeTab ? (mails.find((mail) => mail.id === activeTab.mail.id) || activeTab.mail) : null
    const activeTabReadLabel = activeTabMail?.seen === true ? 'Unread' : 'Read'
    const activeTabFlagLabel = activeTabMail?.flagged === true ? 'Unflag' : 'Flag'
    const fileActionsDisabled = !selectedMail || loadingContent || fileActionLoading !== ''
    const mailItemMenuMail = mailItemMenu?.mail
        ? (mails.find((mail) => mail.id === mailItemMenu.mail.id) || mailItemMenu.mail)
        : null
    const mailItemReadLabel = mailItemMenuMail?.seen === true ? 'Mark as unread' : 'Mark as read'
    const mailItemFlagLabel = mailItemMenuMail?.flagged === true ? 'Unflag' : 'Flag'

    const closeTabsForMailIds = (mailIds) => {
        const ids = new Set(mailIds)
        const affectedTabIds = tabs
            .filter((tab) => ids.has(tab.mail.id))
            .map((tab) => tab.id)
        setTabs((prev) => prev.filter((tab) => !ids.has(tab.mail.id)))
        setTabContents((prev) => {
            const next = { ...prev }
            affectedTabIds.forEach((tabId) => {
                if (tabId in next) {
                    delete next[tabId]
                }
            })
            return next
        })
        if (activeTabId && ids.has(activeTab?.mail.id)) {
            setActiveTabId(null)
        }
    }

    const patchOpenTabsForMail = (mailId, patch) => {
        setTabs((prev) => prev.map((tab) => (
            tab.mail.id === mailId ? { ...tab, mail: { ...tab.mail, ...patch } } : tab
        )))
    }

    const handleActiveTabDeleteAction = async () => {
        if (!activeTabMail) return
        await deleteMailsOptimistic([activeTabMail.id])
        closeTabsForMailIds([activeTabMail.id])
        closeActionMenus()
    }

    const handleActiveTabMoveAction = async (destination) => {
        if (!activeTabMail || !destination) return
        await moveMailsOptimistic([activeTabMail.id], destination)
        closeTabsForMailIds([activeTabMail.id])
        closeActionMenus()
    }

    const handleActiveTabArchiveAction = async () => {
        if (!activeTabMail) return
        await handleActiveTabMoveAction(resolveFolderDestination('Archive'))
    }

    const handleActiveTabMoveToTrashAction = async () => {
        if (!activeTabMail) return
        await handleActiveTabMoveAction(resolveFolderDestination('Trash'))
    }

    const handleActiveTabReplyAction = async () => {
        if (!activeTabMail) return
        const content = await loadMailContentForDraft(activeTabMail)
        composeDraft({
            to: activeTabMail.address || '',
            cc: dedupeEmails(parseEmailList(content?.cc || '')).join(', '),
            subject: prefixSubject('Re:', content?.subject || activeTabMail.subject),
            body: `\n\n${buildQuotedMailBlock(activeTabMail, content)}`,
        })
    }

    const handleActiveTabForwardAction = async () => {
        if (!activeTabMail) return
        const content = await loadMailContentForDraft(activeTabMail)
        composeDraft({
            to: '',
            subject: prefixSubject('Fwd:', content?.subject || activeTabMail.subject),
            body: buildQuotedMailBlock(activeTabMail, content),
        })
    }

    const handleActiveTabReadToggleAction = async () => {
        if (!activeTabMail) return
        const nextSeen = activeTabMail.seen !== true
        await setMailsSeenState([activeTabMail.id], nextSeen)
        patchOpenTabsForMail(activeTabMail.id, { seen: nextSeen })
    }

    const handleActiveTabFlagToggleAction = async () => {
        if (!activeTabMail) return
        const nextFlagged = activeTabMail.flagged !== true
        await setMailsFlaggedState([activeTabMail.id], nextFlagged)
        patchOpenTabsForMail(activeTabMail.id, { flagged: nextFlagged })
        closeActionMenus()
    }

    const handleActiveTabFlagLabelAction = async (label) => {
        if (!activeTabMail || !label) return
        await addMailLabel([activeTabMail.id], label)
        patchOpenTabsForMail(activeTabMail.id, { category: label })
        closeActionMenus()
    }

    const handleCreateFolderAndMoveFromTab = async () => {
        if (!activeTabMail) return
        const name = window.prompt('New folder name')
        if (!name) return
        const mailboxName = applyMailboxNamespace(name, getMailboxNamespacePrefix(folders, ['Folders']))
        const created = await createMailbox(mailboxName)
        if (created) {
            await handleActiveTabMoveAction(mailboxName)
        }
    }

    const handleCreateFlagLabelFromTab = async () => {
        if (!activeTabMail) return
        const name = window.prompt('New flag name')
        const trimmed = (name || '').trim()
        if (!trimmed) return
        setCustomFlagLabels((prev) => (
            prev.includes(trimmed) ? prev : [...prev, trimmed]
        ))
        await ensureLabelExists(trimmed)
        await handleActiveTabFlagLabelAction(trimmed)
    }

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

            {!activeTabId && (
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
            )}
            <div className="db-submenu">
                <div className="db-submenu-scroll" ref={submenuScrollRef}>
                {activeTabId ? (
                    <ul>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabDeleteAction}>🗑️ {t('Delete')}</button></li>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabMoveToTrashAction}>🗃️ {t('Move to Trash')}</button></li>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabArchiveAction}>📦 {t('Archive')}</button></li>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabReplyAction}>↩️ Reply</button></li>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabForwardAction}>➡️ Forward</button></li>
                        <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                            <button
                                disabled={!activeTabMail}
                                title={activeTabMail ? undefined : 'Open a mail first'}
                                className={isMoveMenuOpen ? 'submenu-open' : ''}
                                onClick={() => {
                                    setIsFlagMenuOpen(false)
                                    setIsMoveMenuOpen((prev) => !prev)
                                }}
                            >
                                📁 {t('Move')}
                            </button>
                            {isMoveMenuOpen && (
                                <div className="db-submenu-popover" style={movePopoverStyle || undefined}>
                                    {moveFolderOptions.map((folder) => (
                                        <button
                                            key={folder}
                                            type="button"
                                            className="db-submenu-popover__item"
                                            onClick={() => handleActiveTabMoveAction(folder)}
                                        >
                                            {folderInfo(folder).label}
                                        </button>
                                    ))}
                                    <div className="db-submenu-popover__divider" />
                                    <button type="button" className="db-submenu-popover__item" onClick={handleCreateFolderAndMoveFromTab}>
                                        + New Folder
                                    </button>
                                </div>
                            )}
                        </li>
                        <li><button disabled={!activeTabMail} onClick={handleActiveTabReadToggleAction}>👁️ {activeTabReadLabel}</button></li>
                        <li className="db-submenu-menu-wrap" ref={flagMenuRef}>
                            <button
                                disabled={!activeTabMail}
                                title={activeTabMail ? undefined : 'Open a mail first'}
                                className={isFlagMenuOpen ? 'submenu-open' : ''}
                                onClick={() => {
                                    setIsMoveMenuOpen(false)
                                    setIsFlagMenuOpen((prev) => !prev)
                                }}
                            >
                                ⚑ {activeTabFlagLabel}
                            </button>
                            {isFlagMenuOpen && (
                                <div className="db-submenu-popover" style={flagPopoverStyle || undefined}>
                                    <button type="button" className="db-submenu-popover__item" onClick={handleActiveTabFlagToggleAction}>
                                        {activeTabFlagLabel}
                                    </button>
                                    {availableFlagLabels.length > 0 && <div className="db-submenu-popover__divider" />}
                                    {availableFlagLabels.map((label) => (
                                        <button
                                            key={label}
                                            type="button"
                                            className="db-submenu-popover__item"
                                            onClick={() => handleActiveTabFlagLabelAction(label)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                    <div className="db-submenu-popover__divider" />
                                    <button type="button" className="db-submenu-popover__item" onClick={handleCreateFlagLabelFromTab}>
                                        + New Flag
                                    </button>
                                </div>
                            )}
                        </li>
                    </ul>
                ) : activeRibbonTab === 'home' && (
                    <ul>
                        <li><button onClick={handleNewMail}>🆕 {t('New Mail')}</button></li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleDeleteAction}>🗑️ {t('Delete')}</button></li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleMoveToTrashAction}>🗃️ {t('Move to Trash')}</button></li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleArchiveAction}>📦 {t('Archive')}</button></li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleReplyAction}>↩️ {homeReplyLabel}</button></li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleForwardAction}>➡️ {homeForwardLabel}</button></li>
                        <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                            <button
                                disabled={!hasAnyActionMail}
                                title={selectionRequiredTitle}
                                className={isMoveMenuOpen ? 'submenu-open' : ''}
                                onClick={() => {
                                    setIsFlagMenuOpen(false)
                                    setIsMoveMenuOpen((prev) => !prev)
                                }}
                            >
                                📁 {t('Move')}
                            </button>
                            {isMoveMenuOpen && (
                                <div className="db-submenu-popover" style={movePopoverStyle || undefined}>
                                    {moveFolderOptions.map((folder) => (
                                        <button
                                            key={folder}
                                            type="button"
                                            className="db-submenu-popover__item"
                                            onClick={() => handleMoveAction(folder)}
                                        >
                                            {folderInfo(folder).label}
                                        </button>
                                    ))}
                                    <div className="db-submenu-popover__divider" />
                                    <button type="button" className="db-submenu-popover__item" onClick={handleCreateFolderAndMove}>
                                        + New Folder
                                    </button>
                                </div>
                            )}
                        </li>
                        <li><button disabled={!hasAnyActionMail} onClick={handleReadToggleAction}>👁️ {readToggleLabel}</button></li>
                        <li className="db-submenu-menu-wrap" ref={flagMenuRef}>
                            <button
                                disabled={!hasAnyActionMail}
                                title={selectionRequiredTitle}
                                className={isFlagMenuOpen ? 'submenu-open' : ''}
                                onClick={() => {
                                    setIsMoveMenuOpen(false)
                                    setIsFlagMenuOpen((prev) => !prev)
                                }}
                            >
                                ⚑ {flagToggleLabel}
                            </button>
                            {isFlagMenuOpen && (
                                <div className="db-submenu-popover" style={flagPopoverStyle || undefined}>
                                    <button type="button" className="db-submenu-popover__item" onClick={handleFlagToggleAction}>
                                        {flagToggleLabel}
                                    </button>
                                    {availableFlagLabels.length > 0 && <div className="db-submenu-popover__divider" />}
                                    {availableFlagLabels.map((label) => (
                                        <button
                                            key={label}
                                            type="button"
                                            className="db-submenu-popover__item"
                                            onClick={() => handleFlagLabelAction(label)}
                                        >
                                            {label}
                                        </button>
                                    ))}
                                    <div className="db-submenu-popover__divider" />
                                    <button type="button" className="db-submenu-popover__item" onClick={handleCreateFlagLabel}>
                                        + New Flag
                                    </button>
                                </div>
                            )}
                        </li>
                    </ul>
                )}
                {!activeTabId && activeRibbonTab === 'file' && (
                    <ul>
                        <li>
                            <button disabled={fileActionsDisabled} onClick={handleDownloadHtml}>
                                💾 {fileActionLoading === 'html' ? 'Saving HTML...' : 'Download as HTML'}
                            </button>
                        </li>
                        <li>
                            <button disabled={fileActionsDisabled} onClick={handleDownloadMsg}>
                                ✉️ {fileActionLoading === 'msg' ? 'Saving MSG...' : 'Download as MSG'}
                            </button>
                        </li>
                        <li>
                            <button disabled={fileActionsDisabled} onClick={handleDownloadEml}>
                                📩 {fileActionLoading === 'eml' ? 'Saving EML...' : 'Download as EML'}
                            </button>
                        </li>
                        <li>
                            <button disabled={fileActionsDisabled} onClick={handleDownloadPdf}>
                                📄 {fileActionLoading === 'pdf' ? 'Saving PDF...' : 'Download as PDF'}
                            </button>
                        </li>
                        <li>
                            <button disabled={fileActionsDisabled} onClick={handlePrintMail}>
                                🖨️ {fileActionLoading === 'print' ? 'Preparing print...' : 'Print'}
                            </button>
                        </li>
                    </ul>
                )}
                {!activeTabId && activeRibbonTab === 'send-receive' && (
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
                {!activeTabId && activeRibbonTab === 'folder' && (
                    <ul>
                        <li><button onClick={() => { }}>📁 {t('New Folder')}</button></li>
                        <li><button onClick={() => { }}>🏷️ {t('Rename')}</button></li>
                    </ul>
                )}
                {!activeTabId && activeRibbonTab === 'view' && (
                    <ul>
                        <li><button onClick={() => { }}>📖 {t('Reading Pane')}</button></li>
                        <li><button onClick={() => { }}>📏 {t('Layout')}</button></li>
                    </ul>
                )}
                </div>
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
                                    <div className="db-mail-toolbar-split" ref={selectionMenuRef}>
                                        <button
                                            type="button"
                                            className={`db-mail-toolbar-btn ${selectMode ? 'active' : ''}`}
                                            onClick={() => {
                                                setSelectMode((prev) => {
                                                    const next = !prev
                                                    if (!next) {
                                                        setSelectedMailIds(new Set())
                                                        setIsSelectionMenuOpen(false)
                                                    }
                                                    return next
                                                })
                                            }}
                                            title="Select"
                                        >
                                            ☑
                                        </button>
                                        <button
                                            type="button"
                                            className={`db-mail-toolbar-btn db-mail-toolbar-btn--split ${isSelectionMenuOpen ? 'active' : ''}`}
                                            onClick={() => setIsSelectionMenuOpen((prev) => !prev)}
                                            aria-haspopup="menu"
                                            aria-expanded={isSelectionMenuOpen}
                                            aria-label="Open selection options"
                                            title="Selection options"
                                        >
                                            ▾
                                        </button>
                                        {isSelectionMenuOpen && (
                                            <div className="db-toolbar-dropdown" role="menu" aria-label="Selection options">
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('all')}>
                                                    Tümünü seç
                                                </button>
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('read')}>
                                                    Tüm okunmuşlar
                                                </button>
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('unread')}>
                                                    Tüm okunmamışlar
                                                </button>
                                            </div>
                                        )}
                                    </div>
                                    <div className="db-toolbar-menu-wrap" ref={filterMenuRef}>
                                        <button
                                            type="button"
                                            className={`db-mail-toolbar-btn ${isFilterMenuOpen ? 'menu-open' : ''}`}
                                            title="Filter"
                                            onClick={() => {
                                                setIsSortMenuOpen(false)
                                                setIsFilterMenuOpen((prev) => !prev)
                                            }}
                                            aria-haspopup="menu"
                                            aria-expanded={isFilterMenuOpen}
                                        >
                                            🔍
                                        </button>
                                        {isFilterMenuOpen && (
                                            <div className="db-toolbar-popover" role="menu" aria-label="Filter mails">
                                                {MAIL_FILTER_OPTIONS.map((option) => (
                                                    <button
                                                        key={option.key}
                                                        type="button"
                                                        className={`db-toolbar-popover__item ${activeFilter === option.key ? 'selected' : ''}`}
                                                        role="menuitemradio"
                                                        aria-checked={activeFilter === option.key}
                                                        onClick={() => {
                                                            setActiveFilter(option.key)
                                                            setIsFilterMenuOpen(false)
                                                        }}
                                                    >
                                                        <span className="db-toolbar-popover__check">{activeFilter === option.key ? '✓' : ''}</span>
                                                        <span className="db-toolbar-popover__icon">{option.icon}</span>
                                                        <span>{option.label}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>
                                    <div className="db-toolbar-menu-wrap" ref={sortMenuRef}>
                                        <button
                                            type="button"
                                            className={`db-mail-toolbar-btn ${isSortMenuOpen ? 'menu-open' : ''}`}
                                            title="Sort"
                                            onClick={() => {
                                                setIsFilterMenuOpen(false)
                                                setIsSortMenuOpen((prev) => !prev)
                                            }}
                                            aria-haspopup="menu"
                                            aria-expanded={isSortMenuOpen}
                                        >
                                            ↕️
                                        </button>
                                        {isSortMenuOpen && (
                                            <div className="db-toolbar-popover db-toolbar-popover--sort" role="menu" aria-label="Sort mails">
                                                <div className="db-toolbar-popover__section-title">Sort by</div>
                                                {MAIL_SORT_OPTIONS.map((option) => (
                                                    <button
                                                        key={option.key}
                                                        type="button"
                                                        className={`db-toolbar-popover__item ${sortBy === option.key ? 'selected' : ''}`}
                                                        role="menuitemradio"
                                                        aria-checked={sortBy === option.key}
                                                        onClick={() => setSortBy(option.key)}
                                                    >
                                                        <span className="db-toolbar-popover__check">{sortBy === option.key ? '✓' : ''}</span>
                                                        <span>{option.label}</span>
                                                    </button>
                                                ))}
                                                <div className="db-toolbar-popover__divider" />
                                                <div className="db-toolbar-popover__section-title">Sort order</div>
                                                {(['desc', 'asc']).map((direction) => (
                                                    <button
                                                        key={direction}
                                                        type="button"
                                                        className={`db-toolbar-popover__item ${sortDirection === direction ? 'selected' : ''}`}
                                                        role="menuitemradio"
                                                        aria-checked={sortDirection === direction}
                                                        onClick={() => setSortDirection(direction)}
                                                    >
                                                        <span className="db-toolbar-popover__check">{sortDirection === direction ? '✓' : ''}</span>
                                                        <span>{getSortDirectionLabel(sortBy, direction)}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="db-toolbar-separator" />

                                    <div className="db-pagination-controls">
                                        <button
                                            className="db-pagination-btn"
                                            disabled={displayPage <= 1 || loadingMails}
                                            onClick={() => {
                                                const p = displayPage - 1
                                                setCurrentPage(p)
                                            }}
                                        >
                                            ◀
                                        </button>
                                        <span className="db-page-num">{displayPage}/{filteredMaxPage}</span>
                                        <button
                                            className="db-pagination-btn"
                                            disabled={displayPage >= filteredMaxPage || loadingMails}
                                            onClick={() => {
                                                const p = displayPage + 1
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
                                ) : visibleMails.length === 0 ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon">🔎</div>
                                        <div className="db-empty-text">No mails match the current filter.</div>
                                    </div>
                                ) : (
                                    <>
                                        <ul className="db-mail-list" data-cols={displayCols}>
                                            {pagedVisibleMails.map((mail) => {
                                                const isChecked = selectedMailIds.has(mail.id)

                                                return (
                                                    <li
                                                        key={mail.id}
                                                        className={`db-mail-item ${mail.seen !== true ? 'unread' : ''} ${selectedMail?.id === mail.id ? 'selected' : ''} ${selectMode ? 'select-mode' : ''} ${isChecked ? 'checked' : ''}`}
                                                        onClick={() => openMail(mail)}
                                                        onContextMenu={(event) => openMailItemMenuFromContext(event, mail)}
                                                    >
                                                        <div className="db-mail-avatar-wrap">
                                                            <Avatar
                                                                email={mail.address}
                                                                name={mail.name}
                                                                accountId={accountId}
                                                                size={32}
                                                                className="db-mail-avatar"
                                                            />
                                                            <button
                                                                type="button"
                                                                className={`db-mail-avatar-toggle ${selectMode ? 'visible' : ''} ${isChecked ? 'checked' : ''}`}
                                                                onClick={(event) => handleMailSelectionToggle(event, mail.id)}
                                                                aria-pressed={isChecked}
                                                                aria-label={isChecked ? 'Unselect mail' : 'Select mail'}
                                                                title={selectMode ? 'Select mail' : 'Enter selection mode'}
                                                            >
                                                                <span className="db-mail-avatar-toggle__icon">✓</span>
                                                            </button>
                                                        </div>
                                                        <div className="db-mail-item-content">
                                                            <span className="db-mail-sender">{mail.name || mail.address || 'Unknown'}</span>
                                                            <span className="db-mail-subject">{mail.subject || '(No Subject)'}</span>
                                                            <span className="db-mail-time">{getShortTime(mail.date)}</span>
                                                        </div>
                                                        <div className="db-mail-quick-actions">
                                                            <button
                                                                className="db-mail-qa-btn"
                                                                title="More actions"
                                                                onClick={(event) => openMailItemMenuFromButton(event, mail)}
                                                            >
                                                                ⋮
                                                            </button>
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
                                                )
                                            })}
                                        </ul>
                                        {mailItemMenuMail && (
                                            <div ref={mailItemMenuRef}>
                                                <div className="db-submenu-popover db-mail-item-menu" style={mailItemMenu.style}>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuDelete}>
                                                        🗑️ Delete
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuMoveToTrash}>
                                                        🗃️ Move to Trash
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuArchive}>
                                                        📦 Archive
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuReply}>
                                                        ↩️ Reply
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuForward}>
                                                        ➡️ Forward
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="db-submenu-popover__item db-mail-item-menu__submenu-trigger"
                                                        onClick={toggleMailItemMoveMenu}
                                                    >
                                                        <span>📁 Move</span>
                                                        <span className="db-mail-item-menu__chevron">›</span>
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuReadToggle}>
                                                        👁️ {mailItemReadLabel}
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuFlagToggle}>
                                                        ⚑ {mailItemFlagLabel}
                                                    </button>
                                                </div>
                                                {mailItemMenu.moveMenuOpen && (
                                                    <div className="db-submenu-popover db-mail-item-menu" style={mailItemMoveMenuStyle || undefined}>
                                                        {moveFolderOptions.map((folder) => (
                                                            <button
                                                                key={folder}
                                                                type="button"
                                                                className="db-submenu-popover__item"
                                                                onClick={() => handleMailItemMenuMove(folder)}
                                                            >
                                                                {folderInfo(folder).label}
                                                            </button>
                                                        ))}
                                                        <div className="db-submenu-popover__divider" />
                                                        <button
                                                            type="button"
                                                            className="db-submenu-popover__item"
                                                            onClick={async () => {
                                                                if (!mailItemMenuMail) return
                                                                const name = window.prompt('New folder name')
                                                                if (!name) return
                                                                const mailboxName = applyMailboxNamespace(name, getMailboxNamespacePrefix(folders, ['Folders']))
                                                                const created = await createMailbox(mailboxName)
                                                                if (created) {
                                                                    await handleMailItemMenuMove(mailboxName)
                                                                }
                                                            }}
                                                        >
                                                            + New Folder
                                                        </button>
                                                    </div>
                                                )}
                                            </div>
                                        )}
                                    </>
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
