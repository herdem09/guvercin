import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import { normalizeMailboxResponse } from '../utils/mailboxes'
import { useOfflineSync } from '../context/OfflineSyncContext.jsx'
import { useTheme } from '../context/ThemeContext.jsx'
import Avatar from '../components/Avatar.jsx'
import ComposeMailContent from '../components/ComposeMailContent.jsx'
import {
    buildDraftSavePayload,
    getComposeTitle,
    isComposeDraftDirty,
    isComposeDraftModified,
    normalizeComposeDraft,
    parseComposeBody,
    parseComposeRecipients,
} from '../utils/compose.js'
import './DashboardPage.css'
import SettingsPage from './SettingsPage.jsx'

const SubmenuBar = ({ children, submenuScrollRef, submenuMoreRef, submenuVisibleCount, setSubmenuVisibleCount }) => {
    const [isMoreOpen, setIsMoreOpen] = useState(false)
    const measureRef = useRef(null)

    useLayoutEffect(() => {
        const check = () => {
            if (!measureRef.current || !submenuScrollRef.current) return
            const items = Array.from(measureRef.current.querySelectorAll('li'))
            // Current available width of the component
            const containerWidth = measureRef.current.parentElement.offsetWidth
            
            let totalWidth = 0
            const widths = items.map(li => {
                const w = li.offsetWidth + 2 // width + gap
                totalWidth += w
                return w
            })

            // If everything fits without the "More" button, display all
            if (totalWidth <= containerWidth) {
                setSubmenuVisibleCount(items.length)
                return
            }

            // Otherwise, we need space for the "More" button (~42px)
            const moreBtnWidth = 42
            let used = moreBtnWidth
            let count = 0
            for (let i = 0; i < widths.length; i++) {
                if (used + widths[i] <= containerWidth) {
                    used += widths[i]
                    count++
                } else {
                    break
                }
            }
            setSubmenuVisibleCount(count)
        }
        const ro = new ResizeObserver(check)
        if (submenuScrollRef.current && submenuScrollRef.current.parentElement) {
            ro.observe(submenuScrollRef.current.parentElement)
        }
        check()
        return () => ro.disconnect()
    }, [children, submenuScrollRef, setSubmenuVisibleCount])

    const moreBtnWrapRef = useRef(null)

    // Close more menu when clicking outside the entire button+menu area
    useEffect(() => {
        if (!isMoreOpen) return
        const handleClick = (e) => {
            if (moreBtnWrapRef.current && !moreBtnWrapRef.current.contains(e.target)) {
                setIsMoreOpen(false)
            }
        }
        // Use mousedown so it fires before any click handlers inside
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [isMoreOpen])

    const childList = []
    React.Children.forEach(children, child => {
        if (child && child.type === React.Fragment) {
            React.Children.forEach(child.props.children, c => childList.push(c))
        } else if (child) {
            childList.push(child)
        }
    })

    // Flattern nested lists if they are wrapped in ribbons
    const ribbonChildren = []
    childList.forEach(child => {
        if (child && child.type === 'ul') {
            React.Children.forEach(child.props.children, c => ribbonChildren.push(c))
        } else {
            ribbonChildren.push(child)
        }
    })

    const visible = ribbonChildren.slice(0, submenuVisibleCount)
    const hidden = ribbonChildren.slice(submenuVisibleCount)

    return (
        <div style={{ width: '100%', height: '100%', display: 'flex', alignItems: 'center', position: 'relative' }}>
            <div ref={measureRef} style={{ position: 'absolute', visibility: 'hidden', pointerEvents: 'none', display: 'flex', gap: 2, whiteSpace: 'nowrap', left: -9999 }}>
                <ul style={{ display: 'flex', gap: 2 }}>{ribbonChildren}</ul>
            </div>
            <div className="db-submenu-scroll" ref={submenuScrollRef}>
                <ul style={{ display: 'flex', gap: 2, margin: 0, padding: '0 10px', listStyle: 'none' }}>
                    {visible}
                </ul>
            </div>
            {hidden.length > 0 && (
                <div ref={moreBtnWrapRef} style={{ position: 'relative', flexShrink: 0 }}>
                    <button className="db-submenu-more-btn" onClick={() => setIsMoreOpen(prev => !prev)}>
                        <img src="/img/icons/three-point.svg" className="svg-icon-inline" />
                    </button>
                    {isMoreOpen && (
                        <div className="db-overflow-menu" ref={submenuMoreRef} onClick={() => setIsMoreOpen(false)}>
                            <ul style={{ listStyle: 'none', padding: 0, margin: 0, display: 'flex', flexDirection: 'column' }}>
                                {hidden.map((child, i) => (
                                    <div key={i} className="db-overflow-menu-item">
                                        {child}
                                    </div>
                                ))}
                            </ul>
                        </div>
                    )}
                </div>
            )}
        </div>
    )
}



const FOLDER_MAP = {
    'INBOX': { icon: <img src="/img/icons/inbox.svg" alt="Inbox" className="svg-icon-inline" />, label: 'Inbox' },
    'Inbox': { icon: <img src="/img/icons/inbox.svg" alt="Inbox" className="svg-icon-inline" />, label: 'Inbox' },
    'Starred': { icon: <img src="/img/icons/star.svg" alt="Starred" className="svg-icon-inline" />, label: 'Starred' },
    'Snoozed': { icon: <img src="/img/icons/clock.svg" alt="Snoozed" className="svg-icon-inline" />, label: 'Snoozed' },
    'Sent': { icon: <img src="/img/icons/sentbox.svg" alt="Sent" className="svg-icon-inline" />, label: 'Sent Items' },
    'Sent Items': { icon: <img src="/img/icons/sentbox.svg" alt="Sent" className="svg-icon-inline" />, label: 'Sent Items' },
    'Drafts': { icon: <img src="/img/icons/draft.svg" alt="Drafts" className="svg-icon-inline" />, label: 'Drafts' },
    'Archive': { icon: <img src="/img/icons/archive.svg" alt="Archive" className="svg-icon-inline" />, label: 'Archive' },
    'Trash': { icon: <img src="/img/icons/recycle-bin.svg" alt="Trash" className="svg-icon-inline" />, label: 'Trash' },
    'Spam': { icon: <img src="/img/icons/spambox.svg" alt="Spam" className="svg-icon-inline" />, label: 'Spam' },
    'Junk': { icon: <img src="/img/icons/spambox.svg" alt="Spam" className="svg-icon-inline" />, label: 'Spam' },
    'All Mail': { icon: <img src="/img/icons/all-mails.svg" alt="All Mails" className="svg-icon-inline" />, label: 'All Mail' },
    '[Gmail]/All Mail': { icon: <img src="/img/icons/all-mails.svg" alt="All Mails" className="svg-icon-inline" />, label: 'All Mail' },
}

function folderInfo(name) {
    const clean = name
        .replace(/^Folders\//i, '')
        .replace(/^Labels\//i, '')
        .replace(/^Labels\//i, '')
        .replace(/^\[Labels\]\//i, '')
    if (isLabelMailbox(name)) {
        return { icon: <img src="/img/icons/label.svg" alt="Label" className="svg-icon-inline" />, label: clean }
    }
    return FOLDER_MAP[clean] || FOLDER_MAP[name] || { icon: <img src="/img/icons/folder.svg" alt="Folder" className="svg-icon-inline" />, label: clean }
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

const MAIL_FILTER_OPTIONS = [
    { key: 'all', label: 'All', icon: <img src="/img/icons/all-mails.svg" alt="All" className="svg-icon-inline" /> },
    { key: 'unread', label: 'Unread', icon: <img src="/img/icons/unreaed.svg" alt="Unread" className="svg-icon-inline" /> },
    { key: 'toMe', label: 'To me', icon: '➤' },
]

const MAIL_SORT_OPTIONS = [
    { key: 'date', label: 'Date' },
    { key: 'from', label: 'From' },
    { key: 'category', label: 'Category' },
    { key: 'size', label: 'Size' },
    { key: 'subject', label: 'Subject' },
    { key: 'type', label: 'Type' },
]

const MAIL_SORT_DIRECTION_LABELS = {
    date: { asc: 'Oldest on top', desc: 'Newest on top' },
    from: { asc: 'A to Z', desc: 'Z to A' },
    category: { asc: 'A to Z', desc: 'Z to A' },
    size: { asc: 'Smallest on top', desc: 'Largest on top' },
    subject: { asc: 'A to Z', desc: 'Z to A' },
    type: { asc: 'A to Z', desc: 'Z to A' },
}

function normalizeMailText(value) {
    return (value || '').toString().trim().toLocaleLowerCase()
}

function createComposeSessionId() {
    return `compose-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
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

function isLabelMailbox(value) {
    return /^(Labels|Labels|\[Labels\])(\/|$)/i.test((value || '').trim())
}

function isMailboxSectionRoot(value) {
    return ['Folders', 'Labels', 'Labels'].includes((value || '').trim())
}

function isMoveTargetMailbox(value) {
    const mailbox = (value || '').trim()
    if (!mailbox || isMailboxSectionRoot(mailbox)) return false
    return !isLabelMailbox(mailbox)
}

const MAIL_IDS_DRAG_MIME = 'application/x-guvercin-mail-ids'

function parseDraggedMailIds(dataTransfer) {
    if (!dataTransfer) return []

    const normalizeIds = (ids) => Array.from(new Set(
        (ids || [])
            .map((id) => (id == null ? '' : String(id)).trim())
            .filter(Boolean),
    ))

    const parseJsonPayload = (value) => {
        try {
            const parsed = JSON.parse(value)
            if (!Array.isArray(parsed?.ids)) return []
            return normalizeIds(parsed.ids)
        } catch {
            return []
        }
    }

    const mimeValue = (() => {
        try {
            return dataTransfer.getData(MAIL_IDS_DRAG_MIME)
        } catch {
            return ''
        }
    })()
    const fromMime = mimeValue ? parseJsonPayload(mimeValue) : []
    if (fromMime.length > 0) return fromMime

    const plainValue = (() => {
        try {
            return (dataTransfer.getData('text/plain') || '').trim()
        } catch {
            return ''
        }
    })()
    if (!plainValue) return []

    return normalizeIds(plainValue.split(',').map((part) => part.trim()))
}

const LABEL_NAMESPACE_ROOTS = ['Labels', 'Labels', '[Labels]']

function stripLabelMailboxNamespace(value) {
    return (value || '')
        .trim()
        .replace(/^Labels\//i, '')
        .replace(/^Labels\//i, '')
        .replace(/^\[Labels\]\//i, '')
}

function getMailLabels(mail) {
    if (!Array.isArray(mail?.labels)) return []

    const next = []
    mail.labels.forEach((label) => {
        const trimmed = (label || '').trim()
        if (!trimmed) return
        if (next.some((existing) => existing.toLowerCase() === trimmed.toLowerCase())) return
        next.push(trimmed)
    })
    return next
}

function toggleMailLabelState(mail, labelKey, shouldAdd) {
    const trimmedLabel = (labelKey || '').trim()
    if (!trimmedLabel) return mail

    const labels = getMailLabels(mail)
    const hasLabel = labels.some((label) => label.toLowerCase() === trimmedLabel.toLowerCase())
    const nextLabels = shouldAdd
        ? (hasLabel ? labels : [...labels, trimmedLabel])
        : labels.filter((label) => label.toLowerCase() !== trimmedLabel.toLowerCase())

    const currentCategory = (mail?.category || '').trim()
    const nextCategory = shouldAdd
        ? (currentCategory || nextLabels[0] || '')
        : (currentCategory.toLowerCase() === trimmedLabel.toLowerCase() ? (nextLabels[0] || '') : currentCategory)

    if (
        nextLabels.length === labels.length
        && nextLabels.every((label, index) => label === labels[index])
        && nextCategory === currentCategory
    ) {
        return mail
    }

    return {
        ...mail,
        labels: nextLabels,
        category: nextCategory,
    }
}

function createDefaultAdvancedSearchDraft() {
    return {
        scope: 'all',
        mailboxes: [],
        from: '',
        to: '',
        cc: '',
        subject: '',
        keywords: '',
        dateStart: '',
        dateEnd: '',
        readStatus: 'all',
        hasAttachments: false,
    }
}

function dedupeStringsCaseInsensitive(values) {
    const next = []
    const seen = new Set()
        ; (values || []).forEach((value) => {
            const trimmed = (value || '').toString().trim()
            if (!trimmed) return
            const key = trimmed.toLowerCase()
            if (seen.has(key)) return
            seen.add(key)
            next.push(trimmed)
        })
    return next
}

function buildAdvancedSearchPayload(draft) {
    const readStatus = ['all', 'read', 'unread'].includes(draft?.readStatus) ? draft.readStatus : 'all'
    const mailboxes = dedupeStringsCaseInsensitive(draft?.mailboxes)
    const scope = draft?.scope === 'mailboxes' && mailboxes.length > 0 ? 'mailboxes' : 'all'

    const normalizeField = (value) => {
        const trimmed = (value || '').toString().trim()
        return trimmed ? trimmed : null
    }

    const payload = {
        scope,
        mailboxes: scope === 'mailboxes' ? mailboxes : [],
        readStatus,
        hasAttachments: !!draft?.hasAttachments,
    }

    const from = normalizeField(draft?.from)
    const to = normalizeField(draft?.to)
    const cc = normalizeField(draft?.cc)
    const subject = normalizeField(draft?.subject)
    const keywords = normalizeField(draft?.keywords)
    const dateStart = normalizeField(draft?.dateStart)
    const dateEnd = normalizeField(draft?.dateEnd)

    if (from) payload.from = from
    if (to) payload.to = to
    if (cc) payload.cc = cc
    if (subject) payload.subject = subject
    if (keywords) payload.keywords = keywords
    if (dateStart) payload.dateStart = dateStart
    if (dateEnd) payload.dateEnd = dateEnd

    return payload
}

function isValidImapLabelKeyword(value) {
    const trimmed = (value || '').trim()
    if (!trimmed) return false
    return !trimmed.split('').some((char) => (
        /\s/.test(char) || ['(', ')', '{', '%', '*', '"', '\\', ']'].includes(char)
    ))
}

function isCurrentLabelMailbox(mailbox, labelKey) {
    const normalizedMailbox = stripLabelMailboxNamespace(mailbox).toLowerCase()
    const normalizedLabel = (labelKey || '').trim().toLowerCase()
    return normalizedMailbox !== '' && normalizedMailbox === normalizedLabel
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

    const style = typeof window !== 'undefined' ? window.getComputedStyle(document.documentElement) : null
    const cssVar = (name) => (style?.getPropertyValue(name)?.trim() || '')
    const scheme = (document?.documentElement?.dataset?.theme || '') === 'dark' ? 'dark' : 'light'

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(subject)}</title>
  <style>
    :root {
      color-scheme: ${scheme};
      --bg: ${cssVar('--c-bg-alt')};
      --card: ${cssVar('--c-surface-2')};
      --line: ${cssVar('--c-border-1')};
      --text: ${cssVar('--c-text-1')};
      --muted: ${cssVar('--c-text-2')};
      --accent: ${cssVar('--c-primary')};
      --shadow: ${cssVar('--shadow-1')};
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 32px;
      background: var(--bg);
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
      box-shadow: var(--shadow);
    }
    .mail-header {
      padding: 28px 32px 22px;
      border-bottom: 1px solid var(--line);
      background: var(--card);
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
        background: var(--card);
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

    const {
        themeMode,
        themeName,
        availableThemes,
        refreshThemes,
        setThemeMode,
        setThemeName,
    } = useTheme()

    const [activeSection, setActiveSection] = useState('mail')
    const [accountId, setAccountId] = useState(null)
    const [accountForm, setAccountForm] = useState({})
    const [email, setEmail] = useState('')

    const [connected, setConnected] = useState(false)
    const [connecting, setConnecting] = useState(false)
    const [folders, setFolders] = useState([])
    const [labels, setLabels] = useState([])
    const [selectedFolder, setSelectedFolder] = useState('INBOX')
    const [searchText, setSearchText] = useState('')
    const [listMode, setListMode] = useState('mailbox')
    const [activeSearch, setActiveSearch] = useState(null)
    const [isAdvancedSearchOpen, setIsAdvancedSearchOpen] = useState(false)
    const [advancedSearchDraft, setAdvancedSearchDraft] = useState(() => createDefaultAdvancedSearchDraft())
    const [mails, setMails] = useState([])
    const [selectedMail, setSelectedMail] = useState(null)
    const [mailContent, setMailContent] = useState(null)
    const [loadingMails, setLoadingMails] = useState(false)
    const [loadingContent, setLoadingContent] = useState(false)
    const [currentPage, setCurrentPage] = useState(1)
    const [perPage, setPerPage] = useState(50)
    const [inlineComposeSession, setInlineComposeSession] = useState(null)
    const [tabs, setTabs] = useState([])
    const [activeTabId, setActiveTabId] = useState(null)
    const [tabContents, setTabContents] = useState({})
    const [loadingTab, setLoadingTab] = useState(false)

    const [accountMenuOpen, setAccountMenuOpen] = useState(false)
    const [settingsMenuOpen, setSettingsMenuOpen] = useState(false)
    const [settingsPageOpen, setSettingsPageOpen] = useState(false)
    const [isMailFullscreen, setIsMailFullscreen] = useState(false)
    const [isSyncing, setIsSyncing] = useState(false)
    const [actionNotices, setActionNotices] = useState([])
    const [noticeNow, setNoticeNow] = useState(Date.now())

    const accountButtonRef = useRef(null)
    const accountMenuRef = useRef(null)
    const settingsButtonRef = useRef(null)
    const settingsMenuRef = useRef(null)
    const iframeRef = useRef(null)
    const syncAbortRef = useRef(null)
    const isSyncingRef = useRef(false)
    const nextMailWindowId = useRef(0)
    const nextTabId = useRef(0)
    const nextNoticeIdRef = useRef(0)
    const pendingNoticeActionsRef = useRef(new Map())
    const prevCanUseRemoteMailRef = useRef(false)
    const lastConnectAttemptAtRef = useRef(0)
    const lastMailboxBeforeSearchRef = useRef(null)
    const canUseRemoteMail = backendReachable && networkOnline && (remoteMailAvailable || connected)
    const totalCount = Array.isArray(mails) ? mails.length : 0
    const perPageNum = Math.max(1, Number.parseInt(perPage, 10) || 50)
    const maxPage = Math.max(1, Math.ceil(totalCount / perPageNum))
    const searchMailboxOptions = useMemo(
        () => dedupeStringsCaseInsensitive(folders).filter((mailbox) => !isMailboxSectionRoot(mailbox)),
        [folders],
    )

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

        }
    }

    const accountLabel = accountForm.display_name || accountForm.email_address || 'User'
    const accountEmailLabel = accountForm.email_address || ''

    const handleAccountButtonClick = () => setAccountMenuOpen(!accountMenuOpen)
    const closeAccountMenu = () => setAccountMenuOpen(false)
    const closeSettingsMenu = () => setSettingsMenuOpen(false)

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
            if (settingsMenuRef.current && !settingsMenuRef.current.contains(event.target) &&
                settingsButtonRef.current && !settingsButtonRef.current.contains(event.target)) {
                closeSettingsMenu()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [])

    const persistThemeToBackend = useCallback(async (themeValue) => {
        if (!backendReachable || !accountId) return
        try {
            await fetch(apiUrl(`/api/account/${accountId}/theme`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ theme: themeValue }),
            })
        } catch {

        }
    }, [accountId, backendReachable])

    const chooseSystemTheme = useCallback(async () => {
        closeSettingsMenu()
        await setThemeMode('system')
        await persistThemeToBackend('SYSTEM')
    }, [persistThemeToBackend, setThemeMode])

    const chooseManualTheme = useCallback(async (name) => {
        closeSettingsMenu()
        await setThemeMode('manual')
        await setThemeName(name)
        await persistThemeToBackend(name)
    }, [persistThemeToBackend, setThemeMode, setThemeName])

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

    const ensureImapConnected = useCallback(async (options = {}) => {
        const { force = false, throttleMs = 15_000 } = options
        if (!backendReachable || !networkOnline || !accountId) return false
        if (connected) return true
        if (connecting) return false
        const now = Date.now()
        if (!force && throttleMs > 0 && now - lastConnectAttemptAtRef.current < throttleMs) {
            return false
        }
        lastConnectAttemptAtRef.current = now
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

            let res = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' })
            if (res.ok) {
                const data = await res.json()
                const normalized = normalizeMailboxResponse(data)
                setFolders(normalized.allMailboxes)
                setLabels(normalized.labels)
            }

            if (networkOnline) {
                const ok = canUseRemoteMail || (await ensureImapConnected())
                if (!ok) return
                res = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), { cache: 'no-store' })
                if (res.ok) {
                    const data = await res.json()
                    const normalized = normalizeMailboxResponse(data)
                    setFolders(normalized.allMailboxes)
                    setLabels(normalized.labels)
                }
            }
        } catch {
            setFolders([])
            setLabels([])
        }
    }, [accountId, backendReachable, canUseRemoteMail, ensureImapConnected, networkOnline])

    const handleReconnectImap = useCallback(async () => {
        if (!accountId || !backendReachable || !networkOnline || connecting) return
        const ok = await ensureImapConnected({ force: true, throttleMs: 0 })
        await refreshStatus(accountId)
        if (ok) {
            loadFolders()
        }
    }, [accountId, backendReachable, connecting, ensureImapConnected, loadFolders, networkOnline, refreshStatus])

    const loadMailsFromCache = useCallback(async (folder, _page, _limit) => {
        if (listMode === 'search') return false
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
                const chunkWithMailbox = chunk.map((mail) => ({ ...mail, mailbox: folder }))
                if (typeof data.total_count === 'number') {
                    totalCount = data.total_count
                }
                allMails.push(...chunkWithMailbox)

                if (chunkWithMailbox.length === 0) break
                if (typeof totalCount === 'number' && allMails.length >= totalCount) break
                if (chunkWithMailbox.length < pageSize) break
                nextPage += 1
            }

            setMails(allMails)
            return true
        } catch {
            setMails([])
        }
        return false
    }, [accountId, backendReachable, listMode])

    const syncMailsFromRemote = useCallback(async (folder, _page, _limit) => {
        if (listMode === 'search') return
        if (!accountId || !canUseRemoteMail) return
        if (isSyncingRef.current) return
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
                const chunkWithMailbox = chunk.map((mail) => ({ ...mail, mailbox: folder }))
                if (typeof data.total_count === 'number') {
                    totalCount = data.total_count
                }
                allMails.push(...chunkWithMailbox)

                if (chunkWithMailbox.length === 0) break
                if (typeof totalCount === 'number' && allMails.length >= totalCount) break
                if (chunkWithMailbox.length < pageSize) break
                nextPage += 1
            }

            if (abort.signal.aborted === false) {
                setMails(allMails)
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
    }, [accountId, canUseRemoteMail, listMode])

    const loadMails = useCallback(
        async (folder, page, limit, forceRemote = false) => {
            if (listMode === 'search') return
            if (!accountId || !backendReachable) return
            setLoadingMails(true)
            try {

                if (syncAbortRef.current) {
                    syncAbortRef.current.abort()
                }

                if (forceRemote || canUseRemoteMail) {

                    const res = await fetch(
                        apiUrl(`/api/mail/${accountId}/list?mailbox=${encodeURIComponent(folder)}&page=${page}&per_page=${limit}`),
                        { cache: 'no-store' },
                    )
                    if (res.ok) {
                        const data = await res.json()
                        const mailList = Array.isArray(data?.mails) ? data.mails : []
                        setMails(mailList.map((mail) => ({ ...mail, mailbox: folder })))
                    } else {
                        const loaded = await loadMailsFromCache(folder, page, limit)
                        if (!loaded) setMails([])
                    }
                } else {

                    await loadMailsFromCache(folder, page, limit)
                }
            } catch {
                const loaded = await loadMailsFromCache(folder, page, limit)
                if (!loaded) setMails([])
            } finally {
                setLoadingMails(false)
            }
        },
        [accountId, backendReachable, canUseRemoteMail, listMode, loadMailsFromCache],
    )

    const exitSearchMode = useCallback(() => {
        setListMode('mailbox')
        setActiveSearch(null)
        setSearchText('')
        setMails([])
        setSelectedMail(null)
        setMailContent(null)
        setCurrentPage(1)
        lastMailboxBeforeSearchRef.current = null
    }, [])

    const clearAdvancedSearch = useCallback(() => {
        const backFolder = lastMailboxBeforeSearchRef.current || selectedFolder || 'INBOX'
        exitSearchMode()
        setSelectedFolder(backFolder)
    }, [exitSearchMode, selectedFolder])

    const handleSelectFolder = useCallback((folder) => {
        const nextFolder = (folder || '').toString().trim()
        if (!nextFolder) return
        if (listMode === 'search') {
            exitSearchMode()
        }
        setSelectedFolder(nextFolder)
    }, [exitSearchMode, listMode])

    const executeAdvancedSearch = useCallback(async (options = {}) => {
        const { draftOverride } = options
        if (!accountId || !backendReachable) return

        const criteria = { ...advancedSearchDraft, ...(draftOverride || {}) }
        const payload = buildAdvancedSearchPayload(criteria)

        if (listMode !== 'search') {
            lastMailboxBeforeSearchRef.current = selectedFolder || 'INBOX'
        }

        setActiveSection('mail')
        setCurrentPage(1)
        setListMode('search')
        setSelectedMail(null)
        setMailContent(null)
        setMails([])
        setLoadingMails(true)

        const startedAt = Date.now()
        let source = 'offline'
        let endpoint = `/api/offline/${accountId}/search-advanced`

        try {
            if (networkOnline) {
                const ok = canUseRemoteMail || (await ensureImapConnected({ force: true }))
                if (ok) {
                    source = 'remote'
                    endpoint = `/api/mail/${accountId}/search-advanced`
                }
            }

            setActiveSearch({ criteria, totalCount: null, source, startedAt })

            const res = await fetch(apiUrl(endpoint), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                cache: 'no-store',
            })

            if (!res.ok) {
                const errBody = await res.json().catch(() => null)
                const msg = errBody?.error || errBody?.message || 'Search failed.'
                console.error('Advanced search error:', msg)
                window.alert(msg)
                setActiveSearch({ criteria, totalCount: 0, source, startedAt })
                setMails([])
                return
            }

            const data = await res.json().catch(() => ({}))
            const items = Array.isArray(data?.mails) ? data.mails : []
            const normalized = items
                .map((mail) => (
                    mail && typeof mail === 'object'
                        ? { ...mail, mailbox: mail.mailbox || selectedFolder || 'INBOX' }
                        : null
                ))
                .filter(Boolean)

            setMails(normalized)
            setActiveSearch({
                criteria,
                totalCount: typeof data?.total_count === 'number' ? data.total_count : normalized.length,
                source,
                startedAt,
            })
            setIsAdvancedSearchOpen(false)
        } catch (error) {
            console.error('Advanced search failed:', error)
            window.alert('Search failed.')
            setActiveSearch({ criteria, totalCount: 0, source, startedAt })
            setMails([])
        } finally {
            setLoadingMails(false)
        }
    }, [
        accountId,
        advancedSearchDraft,
        backendReachable,
        canUseRemoteMail,
        ensureImapConnected,
        listMode,
        networkOnline,
        selectedFolder,
    ])

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
        if (activeSection !== 'mail' || !backendReachable || listMode === 'search') return
        setCurrentPage(1)
    }, [activeSection, backendReachable, listMode, selectedFolder])

    useEffect(() => {
        if (activeSection !== 'mail' || !backendReachable || listMode === 'search') return

        let cancelled = false
        const folder = selectedFolder

        loadMailsFromCache(folder, 1, 250).then(() => {
            if (cancelled || !canUseRemoteMail) return
            syncMailsFromRemote(folder, 1, 250)
        })

        return () => {
            cancelled = true
        }
    }, [activeSection, backendReachable, canUseRemoteMail, listMode, selectedFolder, loadMailsFromCache, syncMailsFromRemote])

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
            const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
            let endpoint

            endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
            let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })

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

                prefetchInlineAssets(mail.id, mailbox).then((html) => {
                    if (!html) return
                    setMailContent((prev) => (prev && prev.id === mail.id ? { ...prev, html_body: html } : prev))
                })
            }
        } catch {

        }
        setLoadingContent(false)
    }

    const queueAction = async (actionType, targetUid, payload = {}, targetFolderOverride = null) => {
        if (!accountId || !backendReachable) return
        const response = await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action_type: actionType,
                target_uid: targetUid || null,
                target_folder: targetFolderOverride || selectedFolder || 'INBOX',
                payload,
            }),
        })
        if (!response.ok) {
            const errorBody = await response.json().catch(() => null)
            throw new Error(errorBody?.error || errorBody?.message || `Failed to queue ${actionType}`)
        }
        const responseBody = await response.json().catch(() => null)
        refreshStatus(accountId)
        if (networkOnline) {
            flushQueue(accountId)
        }
        return responseBody
    }

    const dismissActionNotice = useCallback((noticeId) => {
        setActionNotices((prev) => prev.filter((notice) => notice.id !== noticeId))
    }, [])

    const enqueueUndoableAction = useCallback(({ label, apply, undo, commit, variant = 'default', commitLabel = 'Apply now', undoLabel = 'Undo' }) => {
        nextNoticeIdRef.current += 1
        const id = nextNoticeIdRef.current
        const durationMs = 10_000
        const expiresAt = Date.now() + durationMs

        apply()
        setActionNotices((prev) => [...prev, { id, label, durationMs, expiresAt, variant, commitLabel, undoLabel }])

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
        const mailboxById = new Map(
            affectedMails.map((mail) => [mail.id, mail.mailbox || sourceFolder]),
        )
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
            commit: () => Promise.all(ids.map((id) => (
                queueAction('delete', id, {}, mailboxById.get(id) || sourceFolder)
            ))),
        })
    }

    const moveMailsOptimistic = async (mailIds, destination) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        if (ids.length === 0 || !destination) return
        const sourceFolder = selectedFolder || 'INBOX'
        const destinationLabel = folderInfo(destination).label
        const affectedMails = mails.filter((mail) => ids.includes(mail.id))
        const mailboxById = new Map(
            affectedMails.map((mail) => [mail.id, mail.mailbox || sourceFolder]),
        )
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
            commit: () => Promise.all(ids.map((id) => (
                queueAction('move', id, { destination }, mailboxById.get(id) || sourceFolder)
            ))),
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
        const mailboxById = new Map(
            mails.filter((mail) => ids.includes(mail.id)).map((mail) => [mail.id, mail.mailbox || sourceFolder]),
        )
        await Promise.all(ids.map((id) => (
            queueAction(seen ? 'mark_read' : 'mark_unread', id, {}, mailboxById.get(id) || sourceFolder)
        )))
    }

    const createMailbox = async (name) => {
        const mailboxName = name.trim()
        if (!mailboxName || !accountId || !backendReachable) return false
        if (folders.includes(mailboxName)) return true

        try {
            if (networkOnline) {
                const ok = canUseRemoteMail || (await ensureImapConnected({ force: true }))
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

    const sendComposedMail = async (composed) => {
        try {
            const payload = parseComposeBody(composed, email || accountEmailLabel)
            if (payload.to.length === 0) {
                window.alert('Please add at least one recipient.')
                return false
            }
            await queueAction('send', null, payload)
            return true
        } catch (error) {
            console.error('Failed to queue send action:', error)
            window.alert(error?.message || 'Failed to send email.')
            return false
        }
    }

    const saveComposeDraft = useCallback(async (composed) => {
        const payload = buildDraftSavePayload(composed, email || accountEmailLabel)
        const response = await queueAction('save_draft', payload.draft_id, payload, 'Drafts')
        await loadFolders()
        if (folderInfo(selectedFolder || '').label === 'Drafts') {
            await loadMailsFromCache(selectedFolder || 'Drafts', 1, perPage)
        }
        return response?.draft_id || payload.draft_id || null
    }, [accountEmailLabel, email, loadFolders, loadMailsFromCache, perPage, queueAction, selectedFolder])

    const detachMailToWindow = async () => {
        if (!selectedMail) return
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            nextMailWindowId.current += 1
            const mailWindowLabel = `mail-${nextMailWindowId.current}`
            const mailbox = selectedMail?.mailbox || selectedFolder || 'INBOX'
            const mailData = {
                mail: selectedMail,
                mailContent: mailContent,
                accountId: accountId,
                mailbox: mailbox,
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

            const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
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
                <button className="db-logo-btn" style={{ padding: 0, height: '40px', background: 'transparent', minWidth: '130px', border: 'none' }}>
                    <img src="/img/logo/guvercin-righttext-nobackground.svg" alt="Guvercin" style={{ height: '100%', width: 'auto', display: 'block' }} />
                </button>
                <div className="db-search">
                    <input
                        type="text"
                        placeholder="Search..."
                        value={searchText}
                        onChange={(e) => setSearchText(e.target.value)}
                        onKeyDown={(e) => {
                            if (e.key !== 'Enter') return
                            const trimmed = searchText.trim()
                            if (!trimmed) {
                                setIsAdvancedSearchOpen(true)
                                return
                            }
                            executeAdvancedSearch({ draftOverride: { keywords: trimmed } })
                        }}
                    />
                    <button
                        type="button"
                        className="db-search-filters-btn"
                        onClick={() => setIsAdvancedSearchOpen(true)}
                        title={t('Advanced search')}
                    >
                        <img src="/img/icons/more-choice.svg" className="svg-icon-inline" />
                    </button>
                    <button
                        type="button"
                        className="db-search-btn"
                        onClick={() => {
                            const trimmed = searchText.trim()
                            if (!trimmed) {
                                setIsAdvancedSearchOpen(true)
                                return
                            }
                            executeAdvancedSearch({ draftOverride: { keywords: trimmed } })
                        }}
                        aria-label={t('Search')}
                        title={t('Search')}
                    >
                        <img src="/img/icons/search.svg" className="svg-icon-inline" />
                    </button>
                </div>
                <div className="db-navbar-right">
                    <div className="db-clock">
                        <span className="db-clock-item">{time}</span>
                        <span className="db-clock-item">{date}</span>
                    </div>
                    <div className={`db-sync-indicator ${syncState === 'syncing' ? 'is-syncing' : ''}`}>
                        <button type="button" className="db-icon-btn db-sync-indicator__btn" aria-label="Sync and network status">
                            {networkOnline && canUseRemoteMail ? <img src="/img/icons/online.svg" className="svg-icon-inline" /> : (networkOnline ? <img src="/img/icons/online-but-problem.svg" className="svg-icon-inline" /> : <img src="/img/icons/offline.svg" className="svg-icon-inline" />)}
                            <span
                                className={`db-sync-indicator__dot ${canUseRemoteMail ? 'live' : 'offline'} ${syncState === 'syncing' ? 'syncing' : ''}`}
                                aria-hidden="true"
                            />
                        </button>
                        <div className="db-sync-popover" role="tooltip">
                            <div className="db-sync-popover__title">Network</div>
                            <div className="db-sync-popover__row">Internet: {networkOnline ? 'online' : 'offline'}</div>
                            <div className="db-sync-popover__row">Mode: {canUseRemoteMail ? 'Live' : 'Offline Cache'}</div>
                            <div className="db-sync-popover__row">Sync: {syncState}</div>
                            <div className="db-sync-popover__row">Queue: {queueDepth}</div>
                            <div className="db-sync-popover__row">Backend: {backendReachable ? 'reachable' : 'down'}</div>
                            <div className="db-sync-popover__row">IMAP: {imapReachable ? 'reachable' : 'down'}</div>
                            <div className="db-sync-popover__row">SMTP: {smtpReachable ? 'configured' : 'not set'}</div>
                            <button
                                type="button"
                                className="db-sync-popover__action"
                                onClick={handleReconnectImap}
                                disabled={!networkOnline || !backendReachable || connecting}
                            >
                                {connecting ? 'Reconnecting...' : 'Reconnect IMAP'}
                            </button>
                            {lastSyncAt && <div className="db-sync-popover__row">Last sync: {lastSyncAt}</div>}
                            {formatTransfer(transfer?.receiving) && <div className="db-sync-popover__row">{formatTransfer(transfer.receiving)}</div>}
                            {formatTransfer(transfer?.sending) && <div className="db-sync-popover__row">{formatTransfer(transfer.sending)}</div>}
                            {lastError && <div className="db-sync-popover__error">Error: {lastError}</div>}
                        </div>
                    </div>
                    <button className="db-icon-btn" title="Notifications"><img src="/img/icons/notification.svg" className="svg-icon-inline" /></button>
                    <div className="db-settings-wrapper">
                        <button
                            type="button"
                            className="db-icon-btn"
                            title="Settings"
                            ref={settingsButtonRef}
                            onClick={async () => {
                                const next = !settingsMenuOpen
                                setSettingsMenuOpen(next)
                                if (next) await refreshThemes()
                            }}
                        >
                            <img src="/img/icons/settings.svg" className="svg-icon-inline" />
                        </button>
                        {settingsMenuOpen && (
                            <div className="db-settings-menu" ref={settingsMenuRef}>
                                <div className="db-settings-menu__title">{t('Theme')}</div>
                                <button
                                    type="button"
                                    className={`db-settings-menu__item ${themeMode !== 'manual' ? 'active' : ''}`}
                                    onClick={chooseSystemTheme}
                                >
                                    {t('System (default)')}
                                </button>
                                <div className="db-settings-menu__divider" />
                                {['light', 'dark'].filter((n) => availableThemes.includes(n)).map((name) => (
                                    <button
                                        key={name}
                                        type="button"
                                        className={`db-settings-menu__item ${themeMode === 'manual' && themeName === name ? 'active' : ''}`}
                                        onClick={() => chooseManualTheme(name)}
                                    >
                                        {t(name === 'light' ? 'Light' : 'Dark')}
                                    </button>
                                ))}
                                {availableThemes.filter((n) => n !== 'light' && n !== 'dark').map((name) => (
                                    <button
                                        key={name}
                                        type="button"
                                        className={`db-settings-menu__item ${themeMode === 'manual' && themeName === name ? 'active' : ''}`}
                                        onClick={() => chooseManualTheme(name)}
                                    >
                                        {name}
                                    </button>
                                ))}
                                <div className="db-settings-menu__divider" />
                                <button
                                    type="button"
                                    className="db-settings-menu__item"
                                    onClick={() => {
                                        closeSettingsMenu()
                                        navigate('/theme-import')
                                    }}
                                >
                                    {t('Import Theme')}
                                </button>
                            </div>
                        )}
                    </div>
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
                            <div
                                className="account-popover"
                                ref={accountMenuRef}
                                onWheel={(e) => e.stopPropagation()}
                            >
                                <div className="account-popover__avatar-row">
                                    <div className="account-popover__avatar">
                                        <Avatar
                                            email={accountEmailLabel}
                                            name={accountLabel}
                                            accountId={accountId}
                                            size={64}
                                        />
                                    </div>
                                    <button
                                        type="button"
                                        className="account-popover__settings-btn"
                                        title="Settings"
                                        onClick={() => {
                                            closeAccountMenu()
                                            setSettingsPageOpen(true)
                                        }}
                                    >
                                        <img src="/img/icons/settings.svg" className="svg-icon-inline" alt="Settings" />
                                    </button>
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
                        { key: 'mail', icon: <img src="/img/icons/mail.svg" alt="Mail" className="svg-icon-inline" />, label: t('Mail') },
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
                                listMode={listMode}
                                activeSearch={activeSearch}
                                onClearSearch={clearAdvancedSearch}
                                onSelectFolder={handleSelectFolder}
                                ensureImapConnected={ensureImapConnected}
                                folders={folders}
                                labels={labels}
                                selectedFolder={selectedFolder}
                                setSelectedFolder={setSelectedFolder}
                                mails={mails}
                                setMails={setMails}
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
                                queueAction={queueAction}
                                createMailbox={createMailbox}
                                canUseRemoteMail={canUseRemoteMail}
                                inlineComposeSession={inlineComposeSession}
                                setInlineComposeSession={setInlineComposeSession}
                                sendComposedMail={sendComposedMail}
                                saveComposeDraft={saveComposeDraft}
                                enqueueUndoableAction={enqueueUndoableAction}
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
                            <div key={notice.id} className={`db-action-notice ${notice.variant === 'warning' ? 'db-action-notice--warning' : ''}`}>
                                <div className="db-action-notice__body">
                                    <span className="db-action-notice__text">{notice.label}</span>
                                    <div className="db-action-notice__actions">
                                        <button
                                            type="button"
                                            className="db-action-notice__icon-btn db-action-notice__icon-btn--confirm"
                                            onClick={() => commitActionNotice(notice.id)}
                                            aria-label={notice.commitLabel || 'Apply now'}
                                            title={notice.commitLabel || 'Apply now'}
                                        >
                                            ✓
                                        </button>
                                        <button
                                            type="button"
                                            className="db-action-notice__icon-btn db-action-notice__icon-btn--cancel"
                                            onClick={() => undoActionNotice(notice.id)}
                                            aria-label={notice.undoLabel || 'Cancel'}
                                            title={notice.undoLabel || 'Cancel'}
                                        >
                                            <img src="/img/icons/close.svg" className="svg-icon-inline" />
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
            {isAdvancedSearchOpen && (
                <div className="db-advanced-search-modal" onMouseDown={() => setIsAdvancedSearchOpen(false)}>
                    <div
                        className="db-advanced-search-panel"
                        onMouseDown={(e) => e.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label={t('Advanced search')}
                    >
                        <div className="db-advanced-search-panel__header">
                            <div className="db-advanced-search-panel__title">{t('Advanced search')}</div>
                            <button
                                type="button"
                                className="db-advanced-search-panel__close"
                                onClick={() => setIsAdvancedSearchOpen(false)}
                                aria-label="Close"
                                title="Close"
                            >
                                <img src="/img/icons/close.svg" className="svg-icon-inline" />
                            </button>
                        </div>

                        <div className="db-advanced-search-form">
                            <div className="db-advanced-search-grid">
                                <div className="db-advanced-search-label">{t('Search in')}</div>
                                <div className="db-advanced-search-mailboxes">
                                    <label className="db-advanced-search-mailbox-item">
                                        <input
                                            type="checkbox"
                                            checked={advancedSearchDraft.mailboxes.length === 0}
                                            onChange={(e) => {
                                                const checked = e.target.checked
                                                setAdvancedSearchDraft((prev) => (
                                                    checked
                                                        ? { ...prev, scope: 'all', mailboxes: [] }
                                                        : {
                                                            ...prev,
                                                            scope: 'mailboxes',
                                                            mailboxes: dedupeStringsCaseInsensitive([selectedFolder || 'INBOX']),
                                                        }
                                                ))
                                            }}
                                        />
                                        <span>{t('All folders')}</span>
                                    </label>
                                    <div className="db-advanced-search-mailbox-list">
                                        {searchMailboxOptions.length === 0 ? (
                                            <div className="db-advanced-search-mailbox-empty">{t('No results found.')}</div>
                                        ) : (
                                            searchMailboxOptions.map((mailbox) => {
                                                const checked = advancedSearchDraft.mailboxes
                                                    .some((entry) => entry.toLowerCase() === mailbox.toLowerCase())
                                                const label = folderInfo(mailbox).label
                                                return (
                                                    <label key={mailbox} className="db-advanced-search-mailbox-item">
                                                        <input
                                                            type="checkbox"
                                                            checked={advancedSearchDraft.scope === 'mailboxes' && checked}
                                                            onChange={(e) => {
                                                                const nextChecked = e.target.checked
                                                                setAdvancedSearchDraft((prev) => {
                                                                    const current = dedupeStringsCaseInsensitive(prev.mailboxes)
                                                                    const exists = current.some((entry) => entry.toLowerCase() === mailbox.toLowerCase())
                                                                    const next = nextChecked
                                                                        ? (exists ? current : [...current, mailbox])
                                                                        : current.filter((entry) => entry.toLowerCase() !== mailbox.toLowerCase())
                                                                    const nextMailboxes = dedupeStringsCaseInsensitive(next)
                                                                    const nextScope = nextMailboxes.length > 0 ? 'mailboxes' : 'all'
                                                                    return { ...prev, scope: nextScope, mailboxes: nextMailboxes }
                                                                })
                                                            }}
                                                        />
                                                        <span title={mailbox}>{label}</span>
                                                    </label>
                                                )
                                            })
                                        )}
                                    </div>
                                </div>

                                <div className="db-advanced-search-label">{t('From')}</div>
                                <input
                                    className="db-advanced-search-input"
                                    type="text"
                                    value={advancedSearchDraft.from}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, from: e.target.value }))}
                                />

                                <div className="db-advanced-search-label">{t('To')}</div>
                                <input
                                    className="db-advanced-search-input"
                                    type="text"
                                    value={advancedSearchDraft.to}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, to: e.target.value }))}
                                />

                                <div className="db-advanced-search-label">{t('Cc')}</div>
                                <input
                                    className="db-advanced-search-input"
                                    type="text"
                                    value={advancedSearchDraft.cc}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, cc: e.target.value }))}
                                />

                                <div className="db-advanced-search-label">{t('Subject')}</div>
                                <input
                                    className="db-advanced-search-input"
                                    type="text"
                                    value={advancedSearchDraft.subject}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, subject: e.target.value }))}
                                />

                                <div className="db-advanced-search-label">{t('Keywords')}</div>
                                <input
                                    className="db-advanced-search-input"
                                    type="text"
                                    value={advancedSearchDraft.keywords}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, keywords: e.target.value }))}
                                />

                                <div className="db-advanced-search-label">{t('Date')}</div>
                                <div className="db-advanced-search-date-row">
                                    <div className="db-advanced-search-date-field">
                                        <span className="db-advanced-search-date-caption">{t('Start')}</span>
                                        <input
                                            className="db-advanced-search-input"
                                            type="date"
                                            value={advancedSearchDraft.dateStart}
                                            onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, dateStart: e.target.value }))}
                                        />
                                    </div>
                                    <div className="db-advanced-search-date-field">
                                        <span className="db-advanced-search-date-caption">{t('End')}</span>
                                        <input
                                            className="db-advanced-search-input"
                                            type="date"
                                            value={advancedSearchDraft.dateEnd}
                                            onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, dateEnd: e.target.value }))}
                                        />
                                    </div>
                                </div>

                                <div className="db-advanced-search-label">{t('Read status')}</div>
                                <select
                                    className="db-advanced-search-select"
                                    value={advancedSearchDraft.readStatus}
                                    onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, readStatus: e.target.value }))}
                                >
                                    <option value="all">{t('All')}</option>
                                    <option value="read">{t('Read')}</option>
                                    <option value="unread">{t('Unread')}</option>
                                </select>

                                <div className="db-advanced-search-label">{t('Has attachments')}</div>
                                <label className="db-advanced-search-checkbox">
                                    <input
                                        type="checkbox"
                                        checked={advancedSearchDraft.hasAttachments}
                                        onChange={(e) => setAdvancedSearchDraft((prev) => ({ ...prev, hasAttachments: e.target.checked }))}
                                    />
                                    <span>{t('Has attachments')}</span>
                                </label>
                            </div>

                            <div className="db-advanced-search-actions">
                                <button
                                    type="button"
                                    className="db-advanced-search-btn"
                                    onClick={() => executeAdvancedSearch()}
                                >
                                    {t('Search')}
                                </button>
                                <button
                                    type="button"
                                    className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                    onClick={() => setAdvancedSearchDraft(createDefaultAdvancedSearchDraft())}
                                >
                                    {t('Clear filters')}
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
            {settingsPageOpen && (
                <SettingsPage onClose={() => setSettingsPageOpen(false)} accountId={accountId} />
            )}
        </div>
    )
}

function MailSection({
    accountId,
    accountEmail,
    backendReachable,
    networkOnline,
    listMode,
    activeSearch,
    onClearSearch,
    onSelectFolder,
    ensureImapConnected,
    folders, labels, selectedFolder, setSelectedFolder, mails, setMails,
    selectedMail, setSelectedMail, mailContent, setMailContent, loadingMails, loadingContent,
    connecting, loadMailsFromCache, syncMailsFromRemote, prefetchInlineAssets, isSyncing,
    openMail, detachMailToWindow, detachMailToWindowFromList, iframeRef, getShortTime,
    currentPage, setCurrentPage, maxPage: _maxPage, perPage, setPerPage,
    isMailFullscreen, toggleMailFullscreen,
    deleteMailsOptimistic, moveMailsOptimistic, setMailsSeenState, queueAction, createMailbox,
    canUseRemoteMail, inlineComposeSession, setInlineComposeSession, sendComposedMail, saveComposeDraft, enqueueUndoableAction,
    tabs, setTabs, activeTabId, setActiveTabId, tabContents, setTabContents, loadingTab, setLoadingTab, nextTabId,
}) {
    const { t } = useTranslation()
    const hasFolderAccess = folders.length > 0
    const hasMailSource = canUseRemoteMail || hasFolderAccess
    const [activeRibbonTab, setActiveRibbonTab] = useState('home')
    const [expandedFolders, setExpandedFolders] = useState(['INBOX'])
    const [folderWidth, setFolderWidth] = useState(240)
    const [listWidth, setListWidth] = useState(320)
    const [minListWidth, setMinListWidth] = useState(360)
    const [foldersHidden, setFoldersHidden] = useState(false)
    const [mailsHidden, setMailsHidden] = useState(false)
    const [layoutMode, setLayoutMode] = useState('full') // 'full' | 'medium' | 'narrow'
    const [overlayPanel, setOverlayPanel] = useState(null) // null | 'folders' | 'mails'
    // track if user manually closed each panel (so auto-expand doesn't override)
    const userClosedFolders = useRef(false)
    const userClosedMails = useRef(false)
    const [selectMode, setSelectMode] = useState(false)
    const [selectedMailIds, setSelectedMailIds] = useState(() => new Set())
    const [lastSelectedMailId, setLastSelectedMailId] = useState(null)
    const [isSelectionMenuOpen, setIsSelectionMenuOpen] = useState(false)
    const [isFilterMenuOpen, setIsFilterMenuOpen] = useState(false)
    const [isSortMenuOpen, setIsSortMenuOpen] = useState(false)
    const [isMoveMenuOpen, setIsMoveMenuOpen] = useState(false)
    const [isLabelMenuOpen, setIsLabelMenuOpen] = useState(false)
    const [activeFilter, setActiveFilter] = useState('all')
    const [sortBy, setSortBy] = useState('date')
    const [sortDirection, setSortDirection] = useState('desc')
    const [isPerPageOpen, setIsPerPageOpen] = useState(false)
    const [attachmentsExpanded, setAttachmentsExpanded] = useState(true)
    const [fileActionLoading, setFileActionLoading] = useState('')
    const [layoutCols, setLayoutCols] = useState(1)
    const [movePopoverStyle, setMovePopoverStyle] = useState(null)
    const [labelPopoverStyle, setLabelPopoverStyle] = useState(null)
    const [mailItemMenu, setMailItemMenu] = useState(null)
    const [mailItemMoveMenuStyle, setMailItemMoveMenuStyle] = useState(null)
    const [mailItemLabelMenuStyle, setMailItemLabelMenuStyle] = useState(null)
    const [dragOverTarget, setDragOverTarget] = useState(null)
    const [composeExitPrompt, setComposeExitPrompt] = useState(null)
    const [composeActionBusy, setComposeActionBusy] = useState(false)
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
    const homeReplyLabel = hasMultipleActionMails ? 'Reply All' : 'Reply'
    const homeForwardLabel = hasMultipleActionMails ? 'Forward All' : 'Forward'
    const readToggleLabel = allActionMailsSeen ? 'Unread' : 'Read'
    const moveFolderOptions = useMemo(() => folders.filter(isMoveTargetMailbox), [folders])
    const labelOptions = useMemo(() => {
        const seen = new Set()
        return labels
            .map((mailbox) => {
                const labelKey = stripLabelMailboxNamespace(mailbox)
                return {
                    mailbox,
                    labelKey,
                    labelLabel: folderInfo(mailbox).label,
                }
            })
            .filter((option) => {
                if (!option.labelKey) return false
                const key = option.labelKey.toLowerCase()
                if (seen.has(key)) return false
                seen.add(key)
                return true
            })
            .sort((left, right) => left.labelLabel.localeCompare(right.labelLabel, undefined, { sensitivity: 'base' }))
    }, [labels])
    const labelNamespacePrefix = useMemo(
        () => getMailboxNamespacePrefix(labels, LABEL_NAMESPACE_ROOTS) || 'Labels/',
        [labels],
    )
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

        return new Intl.DateTimeFormat(undefined, options).format(dt)
    }

    const createEmptyComposeDraft = useCallback((draft = {}) => normalizeComposeDraft(draft), [])
    const closeComposeExitPrompt = useCallback(() => {
        setComposeActionBusy(false)
        setComposeExitPrompt(null)
    }, [])

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
            const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
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

    const hydrateComposeDraftFromSavedMail = useCallback((mail, content) => createEmptyComposeDraft({
        draftId: content?.id || mail?.id,
        source: 'draft',
        composeSurface: 'inline',
        from: content?.from_address || accountEmail || '',
        toRecipients: parseComposeRecipients(mail?.recipient_to || ''),
        ccRecipients: parseComposeRecipients(content?.cc || ''),
        bccRecipients: parseComposeRecipients(content?.bcc || ''),
        subject: content?.subject || mail?.subject || '',
        plainBody: content?.plain_body || '',
        htmlBody: content?.html_body || '',
        format: (content?.html_body || '').trim() ? 'html' : 'plain',
        attachments: Array.isArray(content?.attachments)
            ? content.attachments.map((attachment) => ({
                id: attachment.id,
                name: attachment.filename,
                mimeType: attachment.content_type,
                size: attachment.size,
                base64: attachment.data_base64 || '',
                disposition: attachment.is_inline ? 'inline' : 'attachment',
                contentId: attachment.content_id || undefined,
                source: attachment.is_inline ? 'html-inline' : 'manual',
            }))
            : [],
        showCc: !!(content?.cc || '').trim(),
        showBcc: !!(content?.bcc || '').trim(),
    }), [accountEmail, createEmptyComposeDraft])

    const closeComposeTab = useCallback((tabId) => {
        setTabs((prev) => prev.filter((tab) => tab.id !== tabId))
        if (activeTabId === tabId) {
            setActiveTabId(null)
        }
    }, [activeTabId, setActiveTabId, setTabs])

    const restoreComposeTarget = useCallback((target, nextDraft) => {
        const normalizedDraft = createEmptyComposeDraft(nextDraft)

        if (target?.type === 'tab') {
            const tabId = target.id || `tab-${Date.now()}`
            setTabs((prev) => {
                const withoutExisting = prev.filter((tab) => tab.id !== tabId)
                return [...withoutExisting, {
                    id: tabId,
                    kind: 'compose',
                    source: target.source || normalizedDraft.source || 'new',
                    baselineDraft: normalizedDraft,
                    draft: { ...normalizedDraft, composeSurface: 'tab' },
                }]
            })
            setActiveTabId(tabId)
            return
        }

        setInlineComposeSession({
            id: target?.id || createComposeSessionId(),
            kind: 'compose',
            source: target?.source || normalizedDraft.source || 'new',
            baselineDraft: normalizedDraft,
            draft: { ...normalizedDraft, composeSurface: 'inline' },
        })
        setActiveTabId(null)
        setSelectedMail(null)
        setMailContent(null)
        if (isMailFullscreen) {
            toggleMailFullscreen()
        }
    }, [createEmptyComposeDraft, isMailFullscreen, setActiveTabId, setInlineComposeSession, setMailContent, setSelectedMail, setTabs, toggleMailFullscreen])

    const closeComposeTarget = useCallback((target) => {
        if (target?.type === 'tab') {
            closeComposeTab(target.id)
            return
        }
        setInlineComposeSession(null)
    }, [closeComposeTab, setInlineComposeSession])

    const updateComposeTabDraft = useCallback((tabId, nextDraft) => {
        setTabs((prev) => prev.map((tab) => (
            tab.id === tabId && tab.kind === 'compose'
                ? {
                    ...tab,
                    draft: normalizeComposeDraft(
                        typeof nextDraft === 'function' ? nextDraft(tab.draft) : nextDraft,
                    ),
                }
                : tab
        )))
    }, [setTabs])

    const openComposeInTab = useCallback((sessionOrDraft, fallbackSource = 'new') => {
        const source = sessionOrDraft?.source || fallbackSource
        const normalizedDraft = createEmptyComposeDraft(sessionOrDraft?.draft || sessionOrDraft)
        const draft = { ...normalizedDraft, composeSurface: 'tab' }
        const sourceId = sessionOrDraft?.id || null
        nextTabId.current += 1
        const tabId = `tab-${nextTabId.current}`

        setTabs((prev) => [...prev, { id: tabId, kind: 'compose', source, baselineDraft: normalizedDraft, draft }])
        setActiveTabId(tabId)
        setSelectedMail(null)
        setMailContent(null)

        if (sourceId && inlineComposeSession?.id === sourceId) {
            setInlineComposeSession(null)
        }
    }, [createEmptyComposeDraft, inlineComposeSession, nextTabId, setActiveTabId, setInlineComposeSession, setMailContent, setSelectedMail, setTabs])

    const openComposeWindow = useCallback(async (sessionOrDraft, fallbackSource = 'new') => {
        if (!accountId) return false
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            nextComposeWindowId.current += 1
            const label = `compose-${nextComposeWindowId.current}`
            const source = sessionOrDraft?.source || fallbackSource
            const normalizedDraft = createEmptyComposeDraft(sessionOrDraft?.draft || sessionOrDraft)
            const draft = { ...normalizedDraft, composeSurface: 'window' }

            await invoke('open_compose_window', {
                label,
                composeDataJson: JSON.stringify({
                    accountId,
                    accountEmail,
                    source,
                    draft,
                    baselineDraft: normalizedDraft,
                }),
            })

            if (sessionOrDraft?.id && inlineComposeSession?.id === sessionOrDraft.id) {
                setInlineComposeSession(null)
            } else if (sessionOrDraft?.id) {
                const matchingTab = tabs.find((tab) => tab.id === sessionOrDraft.id && tab.kind === 'compose')
                if (matchingTab) {
                    closeComposeTab(sessionOrDraft.id)
                }
            }

            setSelectedMail(null)
            setMailContent(null)
            return true
        } catch (error) {
            console.error('Failed to open compose window:', error)
            return false
        }
    }, [accountEmail, accountId, closeComposeTab, createEmptyComposeDraft, inlineComposeSession, setInlineComposeSession, setMailContent, setSelectedMail, tabs])

    const openInlineCompose = useCallback(({ source = 'new', draft = {} }, options = {}) => {
        const preserveExisting = options?.preserveExisting !== false
        if (inlineComposeSession && preserveExisting) {
            openComposeInTab(inlineComposeSession, inlineComposeSession.source)
        }

        const normalizedDraft = createEmptyComposeDraft(draft)
        setInlineComposeSession({
            id: createComposeSessionId(),
            kind: 'compose',
            source,
            baselineDraft: normalizedDraft,
            draft: { ...normalizedDraft, composeSurface: 'inline' },
        })
        setActiveTabId(null)
        setSelectedMail(null)
        setMailContent(null)
        if (isMailFullscreen) {
            toggleMailFullscreen()
        }
    }, [createEmptyComposeDraft, inlineComposeSession, isMailFullscreen, openComposeInTab, setActiveTabId, setInlineComposeSession, setMailContent, setSelectedMail, toggleMailFullscreen])

    const openMailOrDraft = useCallback(async (mail) => {
        if (!mail) return
        const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
        const isDraftMailbox = folderInfo(mailbox).label === 'Drafts'
        if (isDraftMailbox) {
            const content = await loadMailContentForDraft(mail)
            openInlineCompose({
                source: 'draft',
                draft: hydrateComposeDraftFromSavedMail(mail, content),
            }, { preserveExisting: false })
            return
        }
        await openMail(mail)
    }, [hydrateComposeDraftFromSavedMail, loadMailContentForDraft, openInlineCompose, openMail, selectedFolder])

    const enqueueDelayedSend = useCallback(({ draft, target, onAfterClose, onUndoRestore, onCommitted }) => {
        const payload = parseComposeBody(draft, accountEmail)
        if (payload.to.length === 0) {
            window.alert('Please add at least one recipient.')
            return false
        }
        enqueueUndoableAction({
            label: 'Mail will be sent in 10 seconds',
            variant: 'warning',
            commitLabel: 'Send now',
            undoLabel: 'Undo',
            apply: () => {
                closeComposeTarget(target)
                onAfterClose?.()
            },
            undo: () => {
                restoreComposeTarget(target, draft)
                onUndoRestore?.()
            },
            commit: async () => {
                const sentOk = await sendComposedMail(draft)
                if (!sentOk) {
                    restoreComposeTarget(target, draft)
                    return
                }
                await onCommitted?.()
            },
        })
        return true
    }, [accountEmail, closeComposeTarget, enqueueUndoableAction, restoreComposeTarget, sendComposedMail])

    const requestComposeExit = useCallback(({ target, draft, intent = 'discard', pendingMail = null, baselineDraft = null }) => {
        const hasMeaningfulChanges = baselineDraft
            ? isComposeDraftModified(draft, baselineDraft)
            : isComposeDraftDirty(draft)
        if (!hasMeaningfulChanges) {
            closeComposeTarget(target)
            if (intent === 'open_mail' && pendingMail) {
                openMailOrDraft(pendingMail)
            }
            return
        }

        setComposeExitPrompt({
            target,
            draft,
            intent,
            pendingMail,
        })
    }, [closeComposeTarget, openMailOrDraft])

    const continueComposeExitIntent = useCallback(async (prompt) => {
        if (prompt?.intent === 'open_mail' && prompt.pendingMail) {
            await openMailOrDraft(prompt.pendingMail)
        }
    }, [openMailOrDraft])

    const handleComposeExitAction = useCallback(async (action) => {
        if (!composeExitPrompt) return
        if (action === 'cancel') {
            setComposeActionBusy(false)
            closeComposeExitPrompt()
            return
        }

        const prompt = composeExitPrompt
        setComposeActionBusy(true)
        try {
            if (action === 'send') {
                const queued = enqueueDelayedSend({
                    draft: prompt.draft,
                    target: prompt.target,
                    onAfterClose: () => {
                        void continueComposeExitIntent(prompt)
                    },
                })
                if (queued) {
                    closeComposeExitPrompt()
                }
                return
            }

            if (action === 'discard') {
                closeComposeTarget(prompt.target)
                closeComposeExitPrompt()
                await continueComposeExitIntent(prompt)
                return
            }

            if (action === 'save') {
                await saveComposeDraft(prompt.draft)
                closeComposeTarget(prompt.target)
                closeComposeExitPrompt()
                await continueComposeExitIntent(prompt)
            }
        } catch (error) {
            console.error('Failed to finish compose exit action:', error)
            window.alert(error?.message || 'Failed to complete compose action.')
        } finally {
            setComposeActionBusy(false)
        }
    }, [closeComposeExitPrompt, closeComposeTarget, composeExitPrompt, continueComposeExitIntent, enqueueDelayedSend, saveComposeDraft])

    const attemptOpenMail = useCallback(async (mail) => {
        if (!mail) return
        if (!inlineComposeSession) {
            await openMailOrDraft(mail)
            return
        }

        const hasMeaningfulChanges = inlineComposeSession?.baselineDraft
            ? isComposeDraftModified(inlineComposeSession.draft, inlineComposeSession.baselineDraft)
            : isComposeDraftDirty(inlineComposeSession.draft)
        if (!hasMeaningfulChanges) {
            setInlineComposeSession(null)
            await openMailOrDraft(mail)
            return
        }

        setComposeExitPrompt({
            target: {
                type: 'inline',
                id: inlineComposeSession.id,
                source: inlineComposeSession.source,
            },
            draft: inlineComposeSession.draft,
            intent: 'open_mail',
            pendingMail: mail,
        })
    }, [inlineComposeSession, openMailOrDraft, setInlineComposeSession])

    const composeDraft = useCallback((draft, source = 'new') => {
        openInlineCompose({ source, draft })
    }, [openInlineCompose])

    const fetchMailRawBytes = useCallback(async (mail) => {
        if (!mail || !accountId) return null

        const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
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

    const buildLabelSelectionStates = useCallback((targetMails) => {
        const mailsToCheck = Array.isArray(targetMails) ? targetMails.filter(Boolean) : []
        if (mailsToCheck.length === 0) return []

        return labelOptions.map((option) => {
            const selectedCount = mailsToCheck.reduce((count, mail) => {
                const hasLabel = getMailLabels(mail).some((label) => label.toLowerCase() === option.labelKey.toLowerCase())
                return count + (hasLabel ? 1 : 0)
            }, 0)

            let state = 'unchecked'
            if (selectedCount === mailsToCheck.length) state = 'checked'
            else if (selectedCount > 0) state = 'indeterminate'

            return {
                ...option,
                state,
            }
        })
    }, [labelOptions])

    const promptForNewLabelKey = useCallback(() => {
        const name = window.prompt('New label name')
        if (!name) return null

        const labelKey = name.trim().replace(/^\/+|\/+$/g, '')
        if (!labelKey) return null
        if (!isValidImapLabelKeyword(labelKey)) {
            window.alert('Label name contains characters not supported by IMAP keywords.')
            return null
        }
        return labelKey
    }, [])

    const createLabel = useCallback(async (relativeName) => {
        const labelKey = (relativeName || '').trim().replace(/^\/+|\/+$/g, '')
        if (!labelKey) return null
        if (!isValidImapLabelKeyword(labelKey)) {
            window.alert('Label name contains characters not supported by IMAP keywords.')
            return null
        }

        const mailboxName = applyMailboxNamespace(labelKey, labelNamespacePrefix)
        const created = await createMailbox(mailboxName)
        return created ? labelKey : null
    }, [createMailbox, labelNamespacePrefix])

    const toggleLabelsOptimistic = useCallback(async (mailIds, labelKey, shouldAdd) => {
        const ids = Array.from(new Set((mailIds || []).filter(Boolean)))
        const trimmedLabel = (labelKey || '').trim()
        if (ids.length === 0 || !trimmedLabel) return false

        const idSet = new Set(ids)
        const shouldPruneCurrentView = !shouldAdd && isCurrentLabelMailbox(selectedFolder, trimmedLabel)
        const previousMails = mails
        const previousSelectedMail = selectedMail
        const previousMailContent = mailContent
        const previousSelectedMailIds = new Set(selectedMailIds)
        const previousTabs = tabs
        const previousMailItemMenu = mailItemMenu

        setMails((prev) => {
            const next = prev
                .map((mail) => (idSet.has(mail.id) ? toggleMailLabelState(mail, trimmedLabel, shouldAdd) : mail))
            return shouldPruneCurrentView ? next.filter((mail) => !idSet.has(mail.id)) : next
        })

        setSelectedMail((prev) => {
            if (!prev || !idSet.has(prev.id)) return prev
            if (shouldPruneCurrentView) return null
            return toggleMailLabelState(prev, trimmedLabel, shouldAdd)
        })

        if (shouldPruneCurrentView && selectedMail && idSet.has(selectedMail.id)) {
            setMailContent(null)
        }

        if (shouldPruneCurrentView) {
            setSelectedMailIds((prev) => new Set([...prev].filter((id) => !idSet.has(id))))
        }

        setTabs((prev) => prev.map((tab) => (
            tab.kind === 'mail' && idSet.has(tab.mail.id)
                ? { ...tab, mail: toggleMailLabelState(tab.mail, trimmedLabel, shouldAdd) }
                : tab
        )))

        setMailItemMenu((prev) => {
            if (!prev || !idSet.has(prev.mail.id)) return prev
            return {
                ...prev,
                mail: toggleMailLabelState(prev.mail, trimmedLabel, shouldAdd),
            }
        })

        try {
            const sourceFolder = selectedFolder || 'INBOX'
            const mailboxById = new Map(
                mails
                    .filter((mail) => idSet.has(mail.id))
                    .map((mail) => [mail.id, mail.mailbox || sourceFolder]),
            )
            await Promise.all(ids.map((id) => (
                queueAction(
                    shouldAdd ? 'label_add' : 'label_remove',
                    id,
                    { label: trimmedLabel },
                    mailboxById.get(id) || sourceFolder,
                )
            )))
            return true
        } catch (error) {
            setMails(previousMails)
            setSelectedMail(previousSelectedMail)
            setMailContent(previousMailContent)
            setSelectedMailIds(previousSelectedMailIds)
            setTabs(previousTabs)
            setMailItemMenu(previousMailItemMenu)
            window.alert(error?.message || 'The label action failed.')
            return false
        }
    }, [
        mailContent,
        mailItemMenu,
        mails,
        queueAction,
        selectedFolder,
        selectedMail,
        selectedMailIds,
        setMailContent,
        setMailItemMenu,
        setMails,
        setSelectedMail,
        setTabs,
        tabs,
    ])

    const createAndApplyLabel = useCallback(async (mailIds) => {
        const labelKey = promptForNewLabelKey()
        if (!labelKey) return false
        const createdLabel = await createLabel(labelKey)
        if (!createdLabel) return false
        return toggleLabelsOptimistic(mailIds, createdLabel, true)
    }, [createLabel, promptForNewLabelKey, toggleLabelsOptimistic])

    const renderLabelChecklist = useCallback((targetMails, onToggleLabel, onCreateLabel, options = {}) => {
        const states = buildLabelSelectionStates(targetMails)
        const { className = '', style } = options

        return (
            <div
                className={`db-submenu-popover db-label-popover ${className}`.trim()}
                style={style}
                onWheel={(e) => e.stopPropagation()}
            >
                {states.length === 0 ? (
                    <div className="db-label-popover__empty">No labels yet.</div>
                ) : (
                    states.map((option) => (
                        <button
                            key={option.labelKey}
                            type="button"
                            className={`db-label-popover__item ${option.state === 'checked' ? 'checked' : ''} ${option.state === 'indeterminate' ? 'indeterminate' : ''}`}
                            onClick={() => onToggleLabel(option.labelKey, option.state !== 'checked')}
                        >
                            <span className="db-label-popover__check">{option.state === 'checked' ? <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" /> : (option.state === 'indeterminate' ? <img src="/img/icons/choice-unchoosen.svg" className="svg-icon-inline" /> : '')}</span>
                            <span className="db-label-popover__label">{option.labelLabel}</span>
                        </button>
                    ))
                )}
                <div className="db-submenu-popover__divider" />
                <button type="button" className="db-submenu-popover__item" onClick={onCreateLabel}>
                    <img src="/img/icons/plus.svg" className="svg-icon-inline" /> New Label
                </button>
            </div>
        )
    }, [buildLabelSelectionStates])

    const closeMailItemMenu = useCallback(() => {
        setMailItemMenu(null)
        setMailItemMoveMenuStyle(null)
        setMailItemLabelMenuStyle(null)
    }, [])

    const closeActionMenus = () => {
        setIsMoveMenuOpen(false)
        setIsLabelMenuOpen(false)
        closeMailItemMenu()
    }

    const resetBulkSelection = () => {
        setSelectedMailIds(new Set())
        setSelectMode(false)
        setLastSelectedMailId(null)
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
    const containerRef = useRef(null)
    const submenuScrollRef = useRef(null)
    const moveMenuRef = useRef(null)
    const labelMenuRef = useRef(null)
    const submenuMoreRef = useRef(null)
    const [isSubmenuMoreOpen, setIsSubmenuMoreOpen] = useState(false)
    const [submenuVisibleCount, setSubmenuVisibleCount] = useState(99)
    const mailItemMenuRef = useRef(null)
    const isResizingFolder = useRef(false)
    const isResizingList = useRef(false)
    const mailToolbarRef = useRef(null)
    const isDraggingRef = useRef(false)
    const dragPreviewRef = useRef(null)
    const nextComposeWindowId = useRef(0)

    useEffect(() => () => {
        if (dragPreviewRef.current) {
            dragPreviewRef.current.remove()
            dragPreviewRef.current = null
        }
    }, [])

    const createMailDragPreview = useCallback((count) => {
        const node = document.createElement('div')
        node.className = 'db-mail-drag-preview'
        node.textContent = `📧 ${count} mails`
        node.style.position = 'fixed'
        node.style.top = '-1000px'
        node.style.left = '-1000px'
        node.style.zIndex = '999999'
        node.style.pointerEvents = 'none'
        document.body.appendChild(node)
        return node
    }, [])

    const handleMailDragStart = useCallback((event, mail) => {
        if (!event?.dataTransfer || !mail?.id) return
        const draggedId = mail.id
        const ids = (
            selectedMailIds.size > 0 && selectedMailIds.has(draggedId)
                ? Array.from(selectedMailIds)
                : [draggedId]
        )

        isDraggingRef.current = true
        setDragOverTarget(null)

        if (dragPreviewRef.current) {
            dragPreviewRef.current.remove()
            dragPreviewRef.current = null
        }

        try {
            if (typeof event.dataTransfer.setDragImage === 'function') {
                const preview = createMailDragPreview(ids.length)
                dragPreviewRef.current = preview
                event.dataTransfer.setDragImage(preview, 14, 14)
            }
        } catch {

        }

        try {
            event.dataTransfer.effectAllowed = 'copyMove'
        } catch {

        }

        try {
            event.dataTransfer.setData(MAIL_IDS_DRAG_MIME, JSON.stringify({ ids }))
        } catch {

        }

        try {
            event.dataTransfer.setData('text/plain', ids.join(','))
        } catch {

        }
    }, [createMailDragPreview, selectedMailIds])

    const handleMailDragEnd = useCallback(() => {
        isDraggingRef.current = false
        setDragOverTarget(null)
        if (dragPreviewRef.current) {
            dragPreviewRef.current.remove()
            dragPreviewRef.current = null
        }
    }, [])

    const syncPopoverPosition = useCallback((menuRef, setStyle, estimatedWidth = 220) => {
        const node = menuRef.current
        if (!node) {
            setStyle(null)
            return
        }

        const rect = node.getBoundingClientRect()
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
        setMailItemLabelMenuStyle(null)
        setMailItemMenu({
            mail,
            moveMenuOpen: false,
            labelMenuOpen: false,
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
        setMailItemLabelMenuStyle(null)
        setMailItemMenu((prev) => {
            if (!prev) return prev
            return { ...prev, moveMenuOpen: !prev.moveMenuOpen, labelMenuOpen: false }
        })
    }, [clampFloatingMenuPosition])

    const toggleMailItemLabelMenu = useCallback((event) => {
        event.stopPropagation()
        const rect = event.currentTarget.getBoundingClientRect()
        setMailItemLabelMenuStyle(clampFloatingMenuPosition(rect.right + 6, rect.top, 260, 320))
        setMailItemMoveMenuStyle(null)
        setMailItemMenu((prev) => {
            if (!prev) return prev
            return { ...prev, moveMenuOpen: false, labelMenuOpen: !prev.labelMenuOpen }
        })
    }, [clampFloatingMenuPosition])

    const recomputeMinListWidth = useCallback(() => {
        const el = mailToolbarRef.current
        if (!el) return

        const rect = el.getBoundingClientRect()
        const style = window.getComputedStyle(el)
        const padRight = parseFloat(style.paddingRight) || 0

        let maxRight = 0
        for (const child of Array.from(el.children)) {
            const cr = child.getBoundingClientRect()
            maxRight = Math.max(maxRight, cr.right - rect.left)
        }

        const needed = Math.ceil(maxRight + padRight + 2)
        setMinListWidth((prev) => (prev === needed ? prev : needed))
        setListWidth((prev) => (prev < needed ? needed : prev))
    }, [])

    const tabIframeRefs = useRef({})

    const openMailInTab = async (mail, existingContent) => {
        const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
        const isDraftMailbox = folderInfo(mailbox).label === 'Drafts'
        if (isDraftMailbox) {
            const content = existingContent || await loadMailContentForDraft(mail)
            openComposeInTab({
                source: 'draft',
                draft: hydrateComposeDraftFromSavedMail(mail, content),
            }, 'draft')
            return
        }

        nextTabId.current += 1
        const tabId = `tab-${nextTabId.current}`
        let content = existingContent
        if (!content) {
            setLoadingTab(true)
            try {
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

            }
            setLoadingTab(false)
        }
        if (mail.seen !== true) {
            setMailsSeenState([mail.id], true)
        }
        setTabs(prev => [...prev, { id: tabId, kind: 'mail', mail, mailbox: mail?.mailbox || selectedFolder || 'INBOX' }])
        setTabContents(prev => ({ ...prev, [tabId]: content }))
        setActiveTabId(tabId)

        setSelectedMail(null)
        setMailContent(null)
    }

    const closeTab = (e, tabId) => {
        e.stopPropagation()
        const tab = tabs.find((item) => item.id === tabId)
        if (tab?.kind === 'compose') {
            requestComposeExit({
                target: { type: 'tab', id: tabId, source: tab.source },
                draft: tab.draft,
                baselineDraft: tab.baselineDraft,
                intent: 'discard',
            })
            return
        }
        setTabs(prev => {
            const remaining = prev.filter(t => t.id !== tabId)
            return remaining
        })
        setTabContents(prev => { const n = { ...prev }; delete n[tabId]; return n })
        if (activeTabId === tabId) setActiveTabId(null)
    }

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
            if (labelMenuRef.current && !labelMenuRef.current.contains(e.target)) {
                setIsLabelMenuOpen(false)
            }
            if (mailItemMenuRef.current && !mailItemMenuRef.current.contains(e.target)) {
                closeMailItemMenu()
            }
        }
        document.addEventListener('mousedown', handleClickOutside)
        return () => document.removeEventListener('mousedown', handleClickOutside)
    }, [closeMailItemMenu])

    useEffect(() => {
        const sync = () => {
            if (isMoveMenuOpen) {
                syncPopoverPosition(moveMenuRef, setMovePopoverStyle, 220)
            }
            if (isLabelMenuOpen) {
                syncPopoverPosition(labelMenuRef, setLabelPopoverStyle, 260)
            }
        }

        if (!isMoveMenuOpen && !isLabelMenuOpen) {
            setMovePopoverStyle(null)
            setLabelPopoverStyle(null)
            return
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
    }, [activeRibbonTab, activeTabId, isLabelMenuOpen, isMoveMenuOpen, syncPopoverPosition])

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                if (mailItemMenu) {
                    closeMailItemMenu()
                    return
                }
                if (isMoveMenuOpen) {
                    setIsMoveMenuOpen(false)
                    return
                }
                if (isLabelMenuOpen) {
                    setIsLabelMenuOpen(false)
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
                    setLastSelectedMailId(null)
                } else if (selectedMail) {
                    setSelectedMail(null)
                    setMailContent(null)
                }
            }
        }
        window.addEventListener('keydown', handleKeyDown)
        return () => window.removeEventListener('keydown', handleKeyDown)
    }, [closeMailItemMenu, isFilterMenuOpen, isLabelMenuOpen, isMoveMenuOpen, isSelectionMenuOpen, isSortMenuOpen, mailItemMenu, selectMode, selectedMail, setMailContent, setSelectedMail])

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

    useEffect(() => {
        const frame = window.requestAnimationFrame(recomputeMinListWidth)
        return () => window.cancelAnimationFrame(frame)
    }, [recomputeMinListWidth, isMailFullscreen, displayCols])

    // Auto-close folder overlay in narrow mode when user selects a folder
    useEffect(() => {
        setOverlayPanel(null)
    }, [selectedFolder])

    // Auto-collapse panels based on container width
    useLayoutEffect(() => {
        const el = containerRef.current
        if (!el || typeof ResizeObserver === 'undefined') return

        const MIN_CONTENT = 480 // minimum px for mail content to be comfortably visible
        const SIDEBAR_WIDTH = 48 * 3 // 3 icon bars on left

        const compute = () => {
            const available = el.offsetWidth
            const needsForFull = folderWidth + listWidth + MIN_CONTENT
            const needsForMedium = listWidth + MIN_CONTENT

            if (available >= needsForFull) {
                // Full mode: show everything
                setLayoutMode('full')
                setOverlayPanel(null)
                if (!userClosedFolders.current) setFoldersHidden(false)
                if (!userClosedMails.current) setMailsHidden(false)
            } else if (available >= needsForMedium) {
                // Medium mode: hide folders, show mail list normally
                setLayoutMode('medium')
                setOverlayPanel(null)
                setFoldersHidden(true)
                if (!userClosedMails.current) setMailsHidden(false)
            } else {
                // Narrow mode: hide both, use overlay
                setLayoutMode('narrow')
                setFoldersHidden(true)
                setMailsHidden(true)
            }
        }

        const ro = new ResizeObserver(compute)
        ro.observe(el)
        compute()
        return () => ro.disconnect()
    }, [folderWidth, listWidth])

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

        if (event.shiftKey && lastSelectedMailId && lastSelectedMailId !== mailId) {
            const currentIndex = pagedVisibleMails.findIndex(mail => mail.id === mailId)
            const lastIndex = pagedVisibleMails.findIndex(mail => mail.id === lastSelectedMailId)

            if (currentIndex !== -1 && lastIndex !== -1) {
                const startIndex = Math.min(currentIndex, lastIndex)
                const endIndex = Math.max(currentIndex, lastIndex)
                const rangeIds = pagedVisibleMails.slice(startIndex, endIndex + 1).map(mail => mail.id)

                setSelectedMailIds(prev => {
                    const next = new Set(prev)
                    rangeIds.forEach(id => next.add(id))
                    return next
                })
                setLastSelectedMailId(mailId)
                return
            }
        }

        toggleMailSelected(mailId)
        setLastSelectedMailId(mailId)
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
        setLastSelectedMailId(nextSelectedIds.length > 0 ? nextSelectedIds[nextSelectedIds.length - 1] : null)
        setIsSelectionMenuOpen(false)
    }, [visibleMails])

    const buildTree = (list, namespaceRoots = []) => {
        const tree = []
        const normalizedNamespaceRoots = namespaceRoots.map((root) => root.toLowerCase())

        list.forEach((path) => {
            const rawParts = path.split('/').filter(Boolean)
            if (rawParts.length === 0) return

            const startsWithNamespace = normalizedNamespaceRoots.includes(rawParts[0].toLowerCase())
            const parts = startsWithNamespace ? rawParts.slice(1) : rawParts
            const rawStartIndex = rawParts.length - parts.length
            if (parts.length === 0) return

            let currentLevel = tree
            parts.forEach((part, index) => {
                const fullPath = rawParts.slice(0, rawStartIndex + index + 1).join('/')
                let existing = currentLevel.find((item) => item.fullPath === fullPath)
                if (!existing) {
                    existing = {
                        name: part,
                        fullPath,
                        children: [],
                    }
                    currentLevel.push(existing)
                }
                currentLevel = existing.children
            })
        })

        const priorityMap = {
            'INBOX': 1,
            'STARRED': 2,
            'SNOOZED': 3,
            'SENT': 4,
            'SENT ITEMS': 4,
            'ALL MAIL': 5,
            'DRAFTS': 6,
            'ARCHIVE': 7,
            'TRASH': 8,
            'SPAM': 9,
            'JUNK': 9,
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

    const folderMailboxes = useMemo(
        () => folders.filter((mailbox) => !isLabelMailbox(mailbox) && !isMailboxSectionRoot(mailbox)),
        [folders],
    )
    const folderTree = buildTree(folderMailboxes, ['Folders'])
    const labelTree = buildTree(labels, ['Labels', 'Labels', '[Labels]'])

    const renderFolderItem = (node, depth = 0) => {
        const info = folderInfo(node.fullPath)
        const isSelected = listMode !== 'search' && selectedFolder === node.fullPath
        const isExpanded = expandedFolders.includes(node.fullPath)
        const hasChildren = node.children.length > 0
        const labelKey = isLabelMailbox(node.fullPath) ? stripLabelMailboxNamespace(node.fullPath) : ''
        const isDroppableLabel = Boolean(labelKey)
        const isDroppableFolder = isMoveTargetMailbox(node.fullPath)
        const isDroppable = isDroppableLabel || isDroppableFolder

        return (
            <div key={node.fullPath} className="db-folder-node">
                <li className={`db-folder-item ${isSelected ? 'selected' : ''}`} style={{ paddingLeft: `${depth * 12}px` }}>
                    <div
                        className={`db-folder-item-content${isDroppable ? ' dnd-target' : ''}${dragOverTarget === node.fullPath ? ' dnd-over' : ''}`}
                        onClick={() => (onSelectFolder ? onSelectFolder(node.fullPath) : setSelectedFolder(node.fullPath))}
                        onDragEnter={isDroppable ? (e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            setDragOverTarget(node.fullPath)
                        } : undefined}
                        onDragOver={isDroppable ? (e) => {
                            e.preventDefault()
                            e.stopPropagation()
                            try {
                                e.dataTransfer.dropEffect = isDroppableLabel ? 'copy' : 'move'
                            } catch {

                            }
                            setDragOverTarget(node.fullPath)
                        } : undefined}
                        onDragLeave={isDroppable ? (e) => {
                            if (e.currentTarget && e.relatedTarget && e.currentTarget.contains(e.relatedTarget)) return
                            setDragOverTarget((prev) => (prev === node.fullPath ? null : prev))
                        } : undefined}
                        onDrop={isDroppable ? async (e) => {
                            e.preventDefault()
                            e.stopPropagation()

                            setDragOverTarget(null)

                            const ids = parseDraggedMailIds(e.dataTransfer)
                            if (ids.length === 0) return

                            const isExactSelectionSet = selectedMailIds.size > 0
                                && selectedMailIds.size === ids.length
                                && ids.every((id) => selectedMailIds.has(id))

                            let ok = true
                            try {
                                if (isDroppableLabel) {
                                    ok = await toggleLabelsOptimistic(ids, labelKey, true)
                                } else if (isDroppableFolder) {
                                    await moveMailsOptimistic(ids, node.fullPath)
                                }
                            } catch {
                                ok = false
                            }

                            if (ok && isExactSelectionSet) {
                                resetBulkSelection()
                            }
                        } : undefined}
                    >
                        {hasChildren ? (
                            <span className={`db-folder-chevron ${isExpanded ? 'expanded' : ''}`} onClick={(e) => toggleExpand(e, node.fullPath)}>
                                <img src="/img/icons/dock-shown.svg" className="svg-icon-inline" />
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

    const renderFolderSection = (title, nodes, withDivider = false) => (
        <div className={`db-folder-section${withDivider ? ' db-folder-section--divided' : ''}`}>
            <div className="db-folder-section__header">
                <span>{title}</span>
                {title === t('Folders') && (
                    <button
                        type="button"
                        className="db-folder-add-btn"
                        onClick={async () => {
                            const name = window.prompt('New folder name:')
                            if (!name) return
                            const mailboxName = applyMailboxNamespace(name, getMailboxNamespacePrefix(folders, ['Folders']))
                            await createMailbox(mailboxName)
                        }}
                        title="New folder"
                    >
                        <img src="/img/icons/plus.svg" className="svg-icon-inline" />
                    </button>
                )}
                {(title === t('Labels') || title === 'Labels') && (
                    <button
                        type="button"
                        className="db-folder-add-btn"
                        onClick={async () => {
                            const labelKey = await promptForNewLabelKey()
                            if (!labelKey) return
                            await createLabel(labelKey)
                        }}
                        title="New label"
                    >
                        <img src="/img/icons/plus.svg" className="svg-icon-inline" />
                    </button>
                )}
            </div>
            {nodes.map((node) => renderFolderItem(node))}
        </div>
    )

    const handleNewMail = async () => {
        openInlineCompose({ source: 'new', draft: createEmptyComposeDraft() })
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

    const handleLabelToggleAction = async (labelKey, shouldAdd) => {
        if (!hasAnyActionMail) return
        await toggleLabelsOptimistic(actionableMailIds, labelKey, shouldAdd)
    }

    const handleCreateLabelAction = async () => {
        if (!hasAnyActionMail) return
        await createAndApplyLabel(actionableMailIds)
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

    const composeReplyDraft = async (mailList) => {
        const replyMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (replyMails.length === 0) return

        if (replyMails.length > 1) {
            const recipients = dedupeEmails(replyMails.map((mail) => mail.address || ''))
            composeDraft({
                to: recipients.join(', '),
                subject: 'Re: Selected mails',
                plainBody: `\n\n${buildMultiMailSummary(replyMails)}`,
                format: 'plain',
                htmlBody: '',
            }, 'reply')
            return
        }

        const mail = replyMails[0]
        const content = await loadMailContentForDraft(mail)
        composeDraft({
            to: mail.address || '',
            cc: dedupeEmails(parseEmailList(content?.cc || '')).join(', '),
            showCc: !!(content?.cc || '').trim(),
            subject: prefixSubject('Re:', content?.subject || mail.subject),
            plainBody: `\n\n${buildQuotedMailBlock(mail, content)}`,
            format: 'plain',
            htmlBody: '',
        }, 'reply')
    }

    const composeForwardDraft = async (mailList) => {
        const forwardMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (forwardMails.length === 0) return

        if (forwardMails.length > 1) {
            composeDraft({
                to: '',
                subject: `Fwd: ${forwardMails.length} mails`,
                plainBody: buildMultiMailSummary(forwardMails),
                format: 'plain',
                htmlBody: '',
            }, 'forward')
            return
        }

        const mail = forwardMails[0]
        const content = await loadMailContentForDraft(mail)
        composeDraft({
            to: '',
            subject: prefixSubject('Fwd:', content?.subject || mail.subject),
            plainBody: buildQuotedMailBlock(mail, content),
            format: 'plain',
            htmlBody: '',
        }, 'forward')
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

    const handleMailItemMenuLabelToggle = async (labelKey, shouldAdd) => {
        if (!mailItemMenu?.mail) return
        await toggleLabelsOptimistic([mailItemMenu.mail.id], labelKey, shouldAdd)
    }

    const handleMailItemMenuCreateLabel = async () => {
        if (!mailItemMenu?.mail) return
        await createAndApplyLabel([mailItemMenu.mail.id])
    }

    const activeTab = tabs.find((tab) => tab.id === activeTabId) || null
    const activeTabContent = activeTab?.kind === 'mail' && activeTabId ? tabContents[activeTabId] : null
    const activeTabMail = activeTab?.kind === 'mail'
        ? (mails.find((mail) => mail.id === activeTab.mail.id) || activeTab.mail)
        : null
    const activeComposeTab = activeTab?.kind === 'compose' ? activeTab : null
    const activeTabReadLabel = activeTabMail?.seen === true ? 'Unread' : 'Read'
    const fileActionsDisabled = !selectedMail || loadingContent || fileActionLoading !== ''
    const mailItemMenuMail = mailItemMenu?.mail
        ? (mails.find((mail) => mail.id === mailItemMenu.mail.id) || mailItemMenu.mail)
        : null
    const mailItemReadLabel = mailItemMenuMail?.seen === true ? 'Mark as unread' : 'Mark as read'

    const getTabTitle = useCallback((tab) => {
        if (!tab) return ''
        if (tab.kind === 'compose') {
            return getComposeTitle(tab.draft)
        }
        return tab.mail?.subject || '(No Subject)'
    }, [])

    const closeTabsForMailIds = (mailIds) => {
        const ids = new Set(mailIds)
        const affectedTabIds = tabs
            .filter((tab) => tab.kind === 'mail' && ids.has(tab.mail.id))
            .map((tab) => tab.id)
        setTabs((prev) => prev.filter((tab) => tab.kind !== 'mail' || !ids.has(tab.mail.id)))
        setTabContents((prev) => {
            const next = { ...prev }
            affectedTabIds.forEach((tabId) => {
                if (tabId in next) {
                    delete next[tabId]
                }
            })
            return next
        })
        if (activeTabId && activeTab?.kind === 'mail' && ids.has(activeTab.mail.id)) {
            setActiveTabId(null)
        }
    }

    const patchOpenTabsForMail = (mailId, patch) => {
        setTabs((prev) => prev.map((tab) => (
            tab.kind === 'mail' && tab.mail.id === mailId ? { ...tab, mail: { ...tab.mail, ...patch } } : tab
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
            showCc: !!(content?.cc || '').trim(),
            subject: prefixSubject('Re:', content?.subject || activeTabMail.subject),
            plainBody: `\n\n${buildQuotedMailBlock(activeTabMail, content)}`,
            format: 'plain',
            htmlBody: '',
        }, 'reply')
    }

    const handleActiveTabForwardAction = async () => {
        if (!activeTabMail) return
        const content = await loadMailContentForDraft(activeTabMail)
        composeDraft({
            to: '',
            subject: prefixSubject('Fwd:', content?.subject || activeTabMail.subject),
            plainBody: buildQuotedMailBlock(activeTabMail, content),
            format: 'plain',
            htmlBody: '',
        }, 'forward')
    }

    const handleActiveTabReadToggleAction = async () => {
        if (!activeTabMail) return
        const nextSeen = activeTabMail.seen !== true
        await setMailsSeenState([activeTabMail.id], nextSeen)
        patchOpenTabsForMail(activeTabMail.id, { seen: nextSeen })
    }

    const handleActiveTabLabelToggleAction = async (labelKey, shouldAdd) => {
        if (!activeTabMail) return
        await toggleLabelsOptimistic([activeTabMail.id], labelKey, shouldAdd)
    }

    const handleActiveTabCreateLabelAction = async () => {
        if (!activeTabMail) return
        await createAndApplyLabel([activeTabMail.id])
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

    const handleActiveComposeTabSend = async () => {
        if (!activeComposeTab) return
        enqueueDelayedSend({
            draft: activeComposeTab.draft,
            target: { type: 'tab', id: activeComposeTab.id, source: activeComposeTab.source },
        })
        closeActionMenus()
    }

    const handleActiveComposeTabDiscard = () => {
        if (!activeComposeTab) return
        requestComposeExit({
            target: { type: 'tab', id: activeComposeTab.id, source: activeComposeTab.source },
            draft: activeComposeTab.draft,
            baselineDraft: activeComposeTab.baselineDraft,
            intent: 'discard',
        })
        closeActionMenus()
    }

    const handleActiveComposeTabWindow = async () => {
        if (!activeComposeTab) return
        await openComposeWindow(activeComposeTab, activeComposeTab.source)
        closeActionMenus()
    }

    const updateInlineComposeDraft = useCallback((nextDraft) => {
        setInlineComposeSession((prev) => (
            prev
                ? {
                    ...prev,
                    draft: normalizeComposeDraft(
                        typeof nextDraft === 'function' ? nextDraft(prev.draft) : nextDraft,
                    ),
                }
                : prev
        ))
    }, [setInlineComposeSession])

    const handleInlineComposeSend = async (draft) => {
        if (!inlineComposeSession) return
        enqueueDelayedSend({
            draft: draft || inlineComposeSession.draft,
            target: { type: 'inline', id: inlineComposeSession.id, source: inlineComposeSession.source },
        })
    }

    const handleInlineComposeDiscard = useCallback(() => {
        if (!inlineComposeSession) return
        requestComposeExit({
            target: { type: 'inline', id: inlineComposeSession.id, source: inlineComposeSession.source },
            draft: inlineComposeSession.draft,
            baselineDraft: inlineComposeSession.baselineDraft,
            intent: 'discard',
        })
    }, [inlineComposeSession, requestComposeExit])

    return (
        <div className="mail-section-wrapper">
            { }
            <div className="mail-tab-bar">
                <button
                    className={`mail-tab-item main-tab ${!activeTabId ? 'active' : ''}`}
                    onClick={() => setActiveTabId(null)}
                >
                    <img src="/img/icons/inbox.svg" className="svg-icon-inline" /> {selectedFolder || 'Inbox'}
                </button>
                {tabs.map(tab => (
                    <button
                        key={tab.id}
                        className={`mail-tab-item ${activeTabId === tab.id ? 'active' : ''}`}
                        onClick={() => setActiveTabId(tab.id)}
                    >
                        <span className="mail-tab-label">{getTabTitle(tab)}</span>
                        <span className="mail-tab-close" onClick={(e) => closeTab(e, tab.id)}><img src="/img/icons/close.svg" className="svg-icon-inline" /></span>
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
                <SubmenuBar
                    submenuScrollRef={submenuScrollRef}
                    submenuMoreRef={submenuMoreRef}
                    submenuVisibleCount={submenuVisibleCount}
                    setSubmenuVisibleCount={setSubmenuVisibleCount}
                >


                        {activeTabId ? (
                            activeComposeTab ? (
                                <ul>
                                    <li><button disabled={!activeComposeTab} onClick={handleActiveComposeTabSend}>📨 Send</button></li>
                                    <li><button disabled={!activeComposeTab} onClick={handleActiveComposeTabDiscard}><img src="/img/icons/close.svg" className="svg-icon-inline" /> Discard</button></li>
                                    <li><button disabled={!activeComposeTab} onClick={handleActiveComposeTabWindow}><img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" /> Open in Window</button></li>
                                </ul>
                            ) : (
                                <ul>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabDeleteAction}><img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" /> {t('Delete')}</button></li>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabMoveToTrashAction}><img src="/img/icons/move-to-folder.svg" className="svg-icon-inline" /> {t('Move to Trash')}</button></li>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabArchiveAction}><img src="/img/icons/archive.svg" className="svg-icon-inline" /> {t('Archive')}</button></li>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabReplyAction}><img src="/img/icons/reply.svg" className="svg-icon-inline" /> Reply</button></li>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabForwardAction}><img src="/img/icons/forward.svg" className="svg-icon-inline" /> Forward</button></li>
                                    <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                                        <button
                                            disabled={!activeTabMail}
                                            title={activeTabMail ? undefined : 'Open a mail first'}
                                            className={isMoveMenuOpen ? 'submenu-open' : ''}
                                            onClick={() => {
                                                setIsLabelMenuOpen(false)
                                                setIsMoveMenuOpen((prev) => !prev)
                                            }}
                                        >
                                            <img src="/img/icons/folder.svg" className="svg-icon-inline" /> {t('Move')}
                                        </button>
                                        {isMoveMenuOpen && (
                                            <div
                                                className="db-submenu-popover"
                                                style={movePopoverStyle || undefined}
                                                onWheel={(e) => e.stopPropagation()}
                                            >
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
                                                    <img src="/img/icons/plus.svg" className="svg-icon-inline" /> New Folder
                                                </button>
                                            </div>
                                        )}
                                    </li>
                                    <li className="db-submenu-menu-wrap" ref={labelMenuRef}>
                                        <button
                                            disabled={!activeTabMail}
                                            title={activeTabMail ? undefined : 'Open a mail first'}
                                            className={isLabelMenuOpen ? 'submenu-open' : ''}
                                            onClick={() => {
                                                setIsMoveMenuOpen(false)
                                                setIsLabelMenuOpen((prev) => !prev)
                                            }}
                                        >
                                            <img src="/img/icons/label.svg" className="svg-icon-inline" /> Labels
                                        </button>
                                        {isLabelMenuOpen && renderLabelChecklist(
                                            activeTabMail ? [activeTabMail] : [],
                                            handleActiveTabLabelToggleAction,
                                            handleActiveTabCreateLabelAction,
                                            { style: labelPopoverStyle || undefined },
                                        )}
                                    </li>
                                    <li><button disabled={!activeTabMail} onClick={handleActiveTabReadToggleAction}><img src="/img/icons/read.svg" className="svg-icon-inline" /> {activeTabReadLabel}</button></li>
                                </ul>
                            )
                        ) : activeRibbonTab === 'home' && (
                            <ul>
                                <li><button onClick={handleNewMail}><img src="/img/icons/new-mail.svg" className="svg-icon-inline" /> {t('New Mail')}</button></li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleDeleteAction}><img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" /> {t('Delete')}</button></li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleMoveToTrashAction}><img src="/img/icons/move-to-folder.svg" className="svg-icon-inline" /> {t('Move to Trash')}</button></li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleArchiveAction}><img src="/img/icons/archive.svg" className="svg-icon-inline" /> {t('Archive')}</button></li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleReplyAction}>{hasMultipleActionMails ? <img src="/img/icons/reply-all.svg" className="svg-icon-inline" /> : <img src="/img/icons/reply.svg" className="svg-icon-inline" />} {homeReplyLabel}</button></li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleForwardAction}>{hasMultipleActionMails ? <img src="/img/icons/forward-all.svg" className="svg-icon-inline" /> : <img src="/img/icons/forward.svg" className="svg-icon-inline" />} {homeForwardLabel}</button></li>
                                <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                                    <button
                                        disabled={!hasAnyActionMail}
                                        title={selectionRequiredTitle}
                                        className={isMoveMenuOpen ? 'submenu-open' : ''}
                                        onClick={() => {
                                            setIsLabelMenuOpen(false)
                                            setIsMoveMenuOpen((prev) => !prev)
                                        }}
                                    >
                                        <img src="/img/icons/folder.svg" className="svg-icon-inline" /> {t('Move')}
                                    </button>
                                    {isMoveMenuOpen && (
                                        <div
                                            className="db-submenu-popover"
                                            style={movePopoverStyle || undefined}
                                            onWheel={(e) => e.stopPropagation()}
                                        >
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
                                                <img src="/img/icons/plus.svg" className="svg-icon-inline" /> New Folder
                                            </button>
                                        </div>
                                    )}
                                </li>
                                <li className="db-submenu-menu-wrap" ref={labelMenuRef}>
                                    <button
                                        disabled={!hasAnyActionMail}
                                        title={selectionRequiredTitle}
                                        className={isLabelMenuOpen ? 'submenu-open' : ''}
                                        onClick={() => {
                                            setIsMoveMenuOpen(false)
                                            setIsLabelMenuOpen((prev) => !prev)
                                        }}
                                    >
                                        <img src="/img/icons/label.svg" className="svg-icon-inline" /> Labels
                                    </button>
                                    {isLabelMenuOpen && renderLabelChecklist(
                                        actionableMails,
                                        handleLabelToggleAction,
                                        handleCreateLabelAction,
                                        { style: labelPopoverStyle || undefined },
                                    )}
                                </li>
                                <li><button disabled={!hasAnyActionMail} onClick={handleReadToggleAction}><img src="/img/icons/read.svg" className="svg-icon-inline" /> {readToggleLabel}</button></li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'file' && (
                            <ul>
                                <li>
                                    <button disabled={fileActionsDisabled} onClick={handleDownloadHtml}>
                                        <img src="/img/icons/save.svg" className="svg-icon-inline" /> {fileActionLoading === 'html' ? 'Saving HTML...' : 'Download as HTML'}
                                    </button>
                                </li>
                                <li>
                                    <button disabled={fileActionsDisabled} onClick={handleDownloadMsg}>
                                        <img src="/img/icons/mail.svg" className="svg-icon-inline" /> {fileActionLoading === 'msg' ? 'Saving MSG...' : 'Download as MSG'}
                                    </button>
                                </li>
                                <li>
                                    <button disabled={fileActionsDisabled} onClick={handleDownloadEml}>
                                        <img src="/img/icons/mail.svg" className="svg-icon-inline" /> {fileActionLoading === 'eml' ? 'Saving EML...' : 'Download as EML'}
                                    </button>
                                </li>
                                <li>
                                    <button disabled={fileActionsDisabled} onClick={handleDownloadPdf}>
                                        <img src="/img/icons/all-mails.svg" className="svg-icon-inline" /> {fileActionLoading === 'pdf' ? 'Saving PDF...' : 'Download as PDF'}
                                    </button>
                                </li>
                                <li>
                                    <button disabled={fileActionsDisabled} onClick={handlePrintMail}>
                                        <img src="/img/icons/print.svg" className="svg-icon-inline" /> {fileActionLoading === 'print' ? 'Preparing print...' : 'Print'}
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
                                }}><img src="/img/icons/reload.svg" className="svg-icon-inline" /> {t('Update Folder')}</button></li>
                                <li><button onClick={() => { }}><img src="/img/icons/online.svg" className="svg-icon-inline" /> {t('Send All')}</button></li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'folder' && (
                            <ul>
                                <li><button onClick={() => { }}><img src="/img/icons/folder.svg" className="svg-icon-inline" /> {t('New Folder')}</button></li>
                                <li><button onClick={() => { }}><img src="/img/icons/label.svg" className="svg-icon-inline" /> {t('Rename')}</button></li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'view' && (
                            <ul>
                                <li><button onClick={() => { }}>📖 {t('Reading Pane')}</button></li>
                                <li><button onClick={() => { }}>📏 {t('Layout')}</button></li>
                            </ul>
                        )}
                    </SubmenuBar>
            </div>


            { }
            {activeTabId ? (
                <div className="mail-tab-content">
                    {activeTab?.kind === 'mail' && loadingTab ? (
                        <div className="db-loading" style={{ paddingTop: 60 }}><div className="db-spinner" />Loading...</div>
                    ) : activeComposeTab ? (
                        <ComposeMailContent
                            draft={activeComposeTab.draft}
                            onDraftChange={(nextDraft) => updateComposeTabDraft(activeComposeTab.id, nextDraft)}
                            onSend={(draft) => enqueueDelayedSend({
                                draft,
                                target: { type: 'tab', id: activeComposeTab.id, source: activeComposeTab.source },
                            })}
                            onDiscard={() => requestComposeExit({
                                target: { type: 'tab', id: activeComposeTab.id, source: activeComposeTab.source },
                                draft: activeComposeTab.draft,
                                baselineDraft: activeComposeTab.baselineDraft,
                                intent: 'discard',
                            })}
                            onOpenInWindow={() => openComposeWindow(activeComposeTab, activeComposeTab.source)}
                            accountEmail={accountEmail}
                        />
                    ) : activeTab ? (
                        <div className="db-mail-content">
                            <div className="db-mail-content-header">
                                <div className="db-mail-content-subject">{activeTabContent?.subject || activeTabMail?.subject || '(No Subject)'}</div>
                                <div className="db-mail-content-actions">
                                    <button
                                        className="db-mail-action-btn"
                                        onClick={() => closeTab({ stopPropagation: () => { } }, activeTabId)}
                                        title="Close tab"
                                    ><img src="/img/icons/close.svg" className="svg-icon-inline" /></button>
                                </div>
                            </div>
                            <div className="db-mail-meta"><strong>From:</strong> {activeTabContent?.from_name ? `${activeTabContent.from_name} <${activeTabContent.from_address}>` : activeTabMail?.address}</div>
                            {!!(activeTabContent?.cc || '').trim() && <div className="db-mail-meta"><strong>CC:</strong> {activeTabContent.cc}</div>}
                            {!!(activeTabContent?.bcc || '').trim() && <div className="db-mail-meta"><strong>BCC:</strong> {activeTabContent.bcc}</div>}
                            <div className="db-mail-meta"><strong>Date:</strong> {formatMailDateLong(activeTabContent?.date || activeTabMail?.date)}</div>
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
                <div
                    className={`mail-section-container mail-section-container--${layoutMode}`}
                    data-fullscreen-mail={isMailFullscreen}
                    ref={containerRef}
                >
                    {/* Backdrop in narrow or medium overlay mode */}
                    {overlayPanel && (
                        <div
                            className="db-panel-backdrop"
                            onClick={() => setOverlayPanel(null)}
                        />
                    )}

                    {/* Collapsed tab buttons shown when panels are auto-hidden */}
                    <div className="db-dock-tabs db-dock-tabs--left">
                        {foldersHidden && (
                            <CollapsedTab
                                label={t('Mailboxes')}
                                title={t('Show mailboxes')}
                                onClick={() => {
                                    // In both medium and narrow mode: use overlay so mail content isn't compressed
                                    setOverlayPanel(prev => prev === 'folders' ? null : 'folders')
                                }}
                            />
                        )}
                        {mailsHidden && (
                            <CollapsedTab
                                label={t('Mails')}
                                title={t('Show mails')}
                                onClick={() => {
                                    if (layoutMode === 'narrow') {
                                        setOverlayPanel(prev => prev === 'mails' ? null : 'mails')
                                    } else {
                                        userClosedMails.current = false
                                        setMailsHidden(false)
                                    }
                                }}
                            />
                        )}
                    </div>

                    {/* Folder panel — shown inline (non-narrow) or as overlay (narrow) */}
                    {!foldersHidden && (
                        <>
                            <div className="db-folder-panel" style={{ width: folderWidth }}>
                                <div className="db-panel-header">
                                    <span className="db-panel-title">{t('Mailboxes')}</span>
                                    <button
                                        type="button"
                                        className="db-panel-hide-btn"
                                        onClick={() => {
                                            userClosedFolders.current = true
                                            setFoldersHidden(true)
                                            if (layoutMode === 'medium') {
                                                userClosedMails.current = false
                                                setMailsHidden(false)
                                            }
                                        }}
                                        title={t('Hide mailboxes')}
                                    >
                                        <img src="/img/icons/dock-shown.svg" className="svg-icon-inline" />
                                    </button>
                                </div>
                                {hasFolderAccess ? (
                                    <div className="db-folder-scroll-area">
                                        <ul className="db-folder-list">
                                            {listMode === 'search' && (
                                                <li className="db-folder-item selected">
                                                    <div className="db-folder-item-content">
                                                        <span className="db-folder-chevron-placeholder" />
                                                        <span className="db-folder-icon">🔎</span>
                                                        <span className="db-folder-text">{t('Search results')}</span>
                                                    </div>
                                                </li>
                                            )}
                                            {folderTree.length > 0 && renderFolderSection(t('Folders'), folderTree)}
                                            {labelTree.length > 0 && renderFolderSection(t('Labels'), labelTree, folderTree.length > 0)}
                                        </ul>
                                    </div>
                                ) : (
                                    <div className="db-empty-muted">
                                        {connecting
                                            ? 'Connecting...'
                                            : canUseRemoteMail
                                                ? 'No mailboxes available.'
                                                : 'No offline mailboxes cached yet.'}
                                    </div>
                                )}
                            </div>
                            {layoutMode !== 'narrow' && (
                                <div
                                    className="db-resizer"
                                    onMouseDown={() => { isResizingFolder.current = true; document.body.classList.add('resizing') }}
                                    title="Resize mailboxes"
                                />
                            )}
                        </>
                    )}

                    {/* Narrow or medium mode: folders shown as overlay (doesn't push mail content) */}
                    {foldersHidden && overlayPanel === 'folders' && (
                        <div className="db-folder-panel db-folder-panel--overlay" style={{ width: folderWidth }}>
                            <div className="db-panel-header">
                                <span className="db-panel-title">{t('Mailboxes')}</span>
                                <button
                                    type="button"
                                    className="db-panel-hide-btn"
                                    onClick={() => setOverlayPanel(null)}
                                    title={t('Hide mailboxes')}
                                >
                                    <img src="/img/icons/dock-shown.svg" className="svg-icon-inline" />
                                </button>
                            </div>
                            {hasFolderAccess ? (
                                <div className="db-folder-scroll-area">
                                    <ul className="db-folder-list">
                                        {listMode === 'search' && (
                                            <li className="db-folder-item selected">
                                                <div className="db-folder-item-content">
                                                    <span className="db-folder-chevron-placeholder" />
                                                    <span className="db-folder-icon">🔎</span>
                                                    <span className="db-folder-text">{t('Search results')}</span>
                                                </div>
                                            </li>
                                        )}
                                        {folderTree.length > 0 && renderFolderSection(t('Folders'), folderTree, false)}
                                        {labelTree.length > 0 && renderFolderSection(t('Labels'), labelTree, folderTree.length > 0)}
                                    </ul>
                                </div>
                            ) : (
                                <div className="db-empty-muted">
                                    {connecting ? 'Connecting...' : canUseRemoteMail ? 'No mailboxes available.' : 'No offline mailboxes cached yet.'}
                                </div>
                            )}
                        </div>
                    )}

                    <div className="db-mail-main">
                        {(!mailsHidden || (layoutMode === 'narrow' && overlayPanel === 'mails')) && (
                            <div
                                className={`db-center-panel${layoutMode === 'narrow' && mailsHidden && overlayPanel === 'mails' ? ' db-center-panel--overlay' : ''}`}
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
                                        onClick={() => {
                                            if (layoutMode === 'narrow') {
                                                setOverlayPanel(null)
                                            } else {
                                                userClosedMails.current = true
                                                setMailsHidden(true)
                                            }
                                        }}
                                        title={t('Hide mails')}
                                    >
                                        <img src="/img/icons/dock-shown.svg" className="svg-icon-inline" />
                                    </button>
                                    <button
                                        type="button"
                                        className="db-mail-toolbar-btn"
                                        onClick={async () => {
                                            if (!backendReachable) return
                                            if (networkOnline) {
                                                const ok = canUseRemoteMail || (await ensureImapConnected({ force: true }))
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
                                        {isSyncing ? <img src="/img/icons/reload.svg" className="svg-icon-inline spinning" /> : <img src="/img/icons/reload.svg" className="svg-icon-inline" />}
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
                                                        setLastSelectedMailId(null)
                                                        setIsSelectionMenuOpen(false)
                                                    }
                                                    return next
                                                })
                                            }}
                                            title="Select"
                                        >
                                            <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" />
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
                                            <img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline" style={{ transform: 'rotate(90deg)' }} />
                                        </button>
                                        {isSelectionMenuOpen && (
                                            <div
                                                className="db-toolbar-dropdown"
                                                role="menu"
                                                aria-label="Selection options"
                                                onWheel={(e) => e.stopPropagation()}
                                            >
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('all')}>
                                                    Select all
                                                </button>
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('read')}>
                                                    All read
                                                </button>
                                                <button type="button" className="db-toolbar-dropdown__item" role="menuitem" onClick={() => applyBulkSelection('unread')}>
                                                    All unread
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
                                            <img src="/img/icons/search.svg" className="svg-icon-inline" />
                                        </button>
                                        {isFilterMenuOpen && (
                                            <div
                                                className="db-toolbar-popover"
                                                role="menu"
                                                aria-label="Filter mails"
                                                onWheel={(e) => e.stopPropagation()}
                                            >
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
                                                        <span className="db-toolbar-popover__check">{activeFilter === option.key ? <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" /> : ''}</span>
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
                                            <img src="/img/icons/sort.svg" className="svg-icon-inline" />
                                        </button>
                                        {isSortMenuOpen && (
                                            <div
                                                className="db-toolbar-popover db-toolbar-popover--sort"
                                                role="menu"
                                                aria-label="Sort mails"
                                                onWheel={(e) => e.stopPropagation()}
                                            >
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
                                                        <span className="db-toolbar-popover__check">{sortBy === option.key ? <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" /> : ''}</span>
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
                                                        <span className="db-toolbar-popover__check">{sortDirection === direction ? <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline" /> : ''}</span>
                                                        <span>{getSortDirectionLabel(sortBy, direction)}</span>
                                                    </button>
                                                ))}
                                            </div>
                                        )}
                                    </div>

                                    <div className="db-toolbar-separator" />

                                    <div className="db-pagination-controls" style={{ gap: '2px' }}>
                                        <button
                                            className="db-pagination-btn"
                                            disabled={displayPage <= 1 || loadingMails}
                                            onClick={() => {
                                                const p = displayPage - 1
                                                setCurrentPage(p)
                                            }}
                                            style={{ fontSize: '8px', padding: '1px 3px' }}
                                        >
                                            <img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline" style={{ transform: 'rotate(180deg)', width: '7px', height: '7px' }} />
                                        </button>
                                        <span className="db-page-num" style={{ fontSize: '10px', minWidth: 'auto' }}>{displayPage}/{filteredMaxPage}</span>
                                        <button
                                            className="db-pagination-btn"
                                            disabled={displayPage >= filteredMaxPage || loadingMails}
                                            onClick={() => {
                                                const p = displayPage + 1
                                                setCurrentPage(p)
                                            }}
                                            style={{ fontSize: '8px', padding: '1px 3px' }}
                                        >
                                            <img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline" style={{ width: '7px', height: '7px' }} />
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
                                                <div
                                                    className="db-perpage-dropdown"
                                                    onWheel={(e) => e.stopPropagation()}
                                                >
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
                                        {isMailFullscreen ? <img src="/img/icons/mails-fullscreen.svg" className="svg-icon-inline" /> : <img src="/img/icons/mails-fullscreen.svg" className="svg-icon-inline" />}
                                    </button>

                                    {isMailFullscreen && (
                                        <>
                                            <div className="db-toolbar-separator" />
                                            <div className="db-layout-controls">
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 1 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(1)}
                                                    title="1 Column"
                                                ><img src="/img/icons/columns-1.svg" className="svg-icon-inline" /></button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 2 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(2)}
                                                    title="2 Columns"
                                                ><img src="/img/icons/columns-2.svg" className="svg-icon-inline" /></button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 3 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(3)}
                                                    title="3 Columns"
                                                ><img src="/img/icons/columns-3.svg" className="svg-icon-inline" /></button>
                                                <button
                                                    className={`db-mail-toolbar-btn ${layoutCols === 4 ? 'active' : ''}`}
                                                    onClick={() => setLayoutCols(4)}
                                                    title="4 Columns"
                                                ><img src="/img/icons/columns-4.svg" className="svg-icon-inline" /></button>
                                            </div>
                                        </>
                                    )}
                                </div>
                                {listMode === 'search' && (
                                    <div className="db-search-results-banner">
                                        <div className="db-search-results-banner__text">
                                            {t('Search results found', {
                                                count: typeof activeSearch?.totalCount === 'number' ? activeSearch.totalCount : mails.length,
                                            })}
                                        </div>
                                        <button
                                            type="button"
                                            className="db-search-results-banner__clear"
                                            onClick={onClearSearch}
                                        >
                                            {t('Clear search')}
                                        </button>
                                    </div>
                                )}
                                {!hasMailSource ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon"><img src="/img/icons/inbox.svg" style={{ width: '240px', height: 'auto' }} /></div>
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
                                        <div className="db-empty-icon">{listMode === 'search' ? <img src="/img/icons/search.svg" style={{ width: '240px', height: 'auto' }} /> : <img src="/img/icons/inbox.svg" style={{ width: '240px', height: 'auto' }} />}</div>
                                        <div className="db-empty-text">
                                            {listMode === 'search' ? t('No results found.') : 'This folder is empty'}
                                        </div>
                                    </div>
                                ) : visibleMails.length === 0 ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon"><img src="/img/icons/search.svg" style={{ width: '240px', height: 'auto' }} /></div>
                                        <div className="db-empty-text">No mails match the current filter.</div>
                                    </div>
                                ) : (
                                    <>
                                        <ul className="db-mail-list" data-cols={displayCols}>
                                            {pagedVisibleMails.map((mail) => {
                                                const isChecked = selectedMailIds.has(mail.id)
                                                const mailLabels = getMailLabels(mail)
                                                const visibleMailLabels = mailLabels.slice(0, 2)
                                                const remainingMailLabelCount = Math.max(0, mailLabels.length - visibleMailLabels.length)

                                                return (
                                                    <li
                                                        key={mail.id}
                                                        className={`db-mail-item ${mail.seen !== true ? 'unread' : ''} ${selectedMail?.id === mail.id ? 'selected' : ''} ${selectMode ? 'select-mode' : ''} ${isChecked ? 'checked' : ''}`}
                                                        onClick={() => {
                                                            if (isDraggingRef.current) return
                                                            attemptOpenMail(mail)
                                                        }}
                                                        onContextMenu={(event) => openMailItemMenuFromContext(event, mail)}
                                                        draggable
                                                        onDragStart={(event) => handleMailDragStart(event, mail)}
                                                        onDragEnd={handleMailDragEnd}
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
                                                                <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline db-mail-avatar-toggle__icon" />
                                                            </button>
                                                        </div>
                                                        <div className="db-mail-item-content">
                                                            <div className="db-mail-item-head">
                                                                <span className="db-mail-sender">{mail.name || mail.address || 'Unknown'}</span>
                                                                <span className="db-mail-time">{getShortTime(mail.date)}</span>
                                                            </div>
                                                            <span className="db-mail-subject">{mail.subject || '(No Subject)'}</span>
                                                            {mailLabels.length > 0 && (
                                                                <div className="db-mail-labels" title={mailLabels.join(', ')}>
                                                                    {visibleMailLabels.map((label) => (
                                                                        <span key={`${mail.id}-${label}`} className="db-mail-label-chip">
                                                                            {label}
                                                                        </span>
                                                                    ))}
                                                                    {remainingMailLabelCount > 0 && (
                                                                        <span className="db-mail-label-chip db-mail-label-chip--more">
                                                                            +{remainingMailLabelCount}
                                                                        </span>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                        <div className="db-mail-quick-actions">
                                                            <button
                                                                className="db-mail-qa-btn"
                                                                title="More actions"
                                                                onClick={(event) => openMailItemMenuFromButton(event, mail)}
                                                            >
                                                                <img src="/img/icons/three-point.svg" className="svg-icon-inline" />
                                                            </button>
                                                            <div className="db-mail-qa-row">
                                                                <button
                                                                    className="db-mail-qa-btn"
                                                                    title="Open in new tab"
                                                                    onClick={(e) => {
                                                                        e.stopPropagation()
                                                                        openMailInTab(mail)
                                                                    }}
                                                                >
                                                                    <img src="/img/icons/open-in-new-tab.svg" className="svg-icon-inline" />
                                                                </button>
                                                                <button
                                                                    className="db-mail-qa-btn"
                                                                    title="Open in new window"
                                                                    onClick={(e) => detachMailToWindowFromList(e, mail)}
                                                                >
                                                                    <img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" />
                                                                </button>
                                                            </div>
                                                        </div>
                                                    </li>
                                                )
                                            })}
                                        </ul>
                                        {mailItemMenuMail && (
                                            <div ref={mailItemMenuRef}>
                                                <div
                                                    className="db-submenu-popover db-mail-item-menu"
                                                    style={mailItemMenu.style}
                                                    onWheel={(e) => e.stopPropagation()}
                                                >
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuDelete}>
                                                        <img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" /> Delete
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuMoveToTrash}>
                                                        <img src="/img/icons/move-to-folder.svg" className="svg-icon-inline" /> Move to Trash
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuArchive}>
                                                        <img src="/img/icons/archive.svg" className="svg-icon-inline" /> Archive
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuReply}>
                                                        <img src="/img/icons/reply.svg" className="svg-icon-inline" /> Reply
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuForward}>
                                                        <img src="/img/icons/forward.svg" className="svg-icon-inline" /> Forward
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="db-submenu-popover__item db-mail-item-menu__submenu-trigger"
                                                        onClick={toggleMailItemMoveMenu}
                                                    >
                                                        <span><img src="/img/icons/folder.svg" className="svg-icon-inline" /> Move</span>
                                                        <span className="db-mail-item-menu__chevron">›</span>
                                                    </button>
                                                    <button
                                                        type="button"
                                                        className="db-submenu-popover__item db-mail-item-menu__submenu-trigger"
                                                        onClick={toggleMailItemLabelMenu}
                                                    >
                                                        <span><img src="/img/icons/label.svg" className="svg-icon-inline" /> Labels</span>
                                                        <span className="db-mail-item-menu__chevron">›</span>
                                                    </button>
                                                    <button type="button" className="db-submenu-popover__item" onClick={handleMailItemMenuReadToggle}>
                                                        <img src="/img/icons/read.svg" className="svg-icon-inline" /> {mailItemReadLabel}
                                                    </button>
                                                </div>
                                                {mailItemMenu.moveMenuOpen && (
                                                    <div
                                                        className="db-submenu-popover db-mail-item-menu"
                                                        style={mailItemMoveMenuStyle || undefined}
                                                        onWheel={(e) => e.stopPropagation()}
                                                    >
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
                                                            <img src="/img/icons/plus.svg" className="svg-icon-inline" /> New Folder
                                                        </button>
                                                    </div>
                                                )}
                                                {mailItemMenu.labelMenuOpen && (
                                                    renderLabelChecklist(
                                                        mailItemMenuMail ? [mailItemMenuMail] : [],
                                                        handleMailItemMenuLabelToggle,
                                                        handleMailItemMenuCreateLabel,
                                                        { className: 'db-mail-item-menu', style: mailItemLabelMenuStyle || undefined },
                                                    )
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
                                        <div className="db-empty-icon"><img src="/img/logo/guvercin-notext-nobackground.svg" alt="Guvercin" style={{ width: '1024px', height: 'auto' }} /></div>
                                        <div className="db-empty-text">
                                            {connecting
                                                ? 'Connecting...'
                                                : canUseRemoteMail
                                                    ? 'No messages loaded yet.'
                                                    : 'Offline cache is not available yet.'}
                                        </div>
                                    </div>
                                ) : inlineComposeSession ? (
                                    <ComposeMailContent
                                        draft={inlineComposeSession.draft}
                                        onDraftChange={updateInlineComposeDraft}
                                        onSend={handleInlineComposeSend}
                                        onDiscard={handleInlineComposeDiscard}
                                        onOpenInTab={() => openComposeInTab(inlineComposeSession, inlineComposeSession.source)}
                                        onOpenInWindow={() => openComposeWindow(inlineComposeSession, inlineComposeSession.source)}
                                        accountEmail={accountEmail}
                                    />
                                ) : !selectedMail ? (
                                    <div className="db-empty-state">
                                        <div className="db-empty-icon"><img src="/img/logo/guvercin-notext-nobackground.svg" alt="Guvercin" style={{ width: '600px', height: 'auto' }} /></div>
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
                                                    <img src="/img/icons/open-in-new-tab.svg" className="svg-icon-inline" />
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={detachMailToWindow}
                                                    title="Open in new window"
                                                >
                                                    <img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" />
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => setSelectedMail(null)}
                                                    title="Close"
                                                >
                                                    <img src="/img/icons/close.svg" className="svg-icon-inline" />
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
                                                    {attachmentsExpanded ? <img src="/img/icons/dock-shown.svg" className="svg-icon-inline" style={{ marginRight: "6px" }} /> : <img src="/img/icons/dock-hidden.svg" className="svg-icon-inline" style={{ marginRight: "6px" }} />}
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
                                                                    href={attachmentUrl(accountId, mailContent.id, at.id, selectedMail?.mailbox || selectedFolder || 'INBOX', canUseRemoteMail)}
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
            {composeExitPrompt && (
                <div className="db-advanced-search-modal" onMouseDown={() => handleComposeExitAction('cancel')}>
                    <div
                        className="db-compose-exit-panel"
                        onMouseDown={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Leave message"
                    >
                        <div className="db-compose-exit-panel__header">
                            <div className="db-compose-exit-panel__title">Do you want to leave this message?</div>
                            <button
                                type="button"
                                className="db-advanced-search-panel__close"
                                onClick={() => handleComposeExitAction('cancel')}
                                aria-label="Close"
                                title="Close"
                            >
                                <img src="/img/icons/close.svg" className="svg-icon-inline" />
                            </button>
                        </div>
                        <div className="db-compose-exit-panel__body">
                            {composeExitPrompt.intent === 'open_mail'
                                ? 'Opening another mail will close the current compose.'
                                : 'This message has unsaved changes.'}
                        </div>
                        <div className="db-compose-exit-panel__actions">
                            <button
                                type="button"
                                className="db-advanced-search-btn db-compose-exit-panel__btn db-compose-exit-panel__btn--send"
                                onClick={() => handleComposeExitAction('send')}
                                disabled={composeActionBusy}
                            >
                                {composeActionBusy ? 'Working...' : 'Send'}
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary db-compose-exit-panel__btn"
                                onClick={() => handleComposeExitAction('discard')}
                                disabled={composeActionBusy}
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary db-compose-exit-panel__btn"
                                onClick={() => handleComposeExitAction('cancel')}
                                disabled={composeActionBusy}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-compose-exit-panel__btn db-compose-exit-panel__btn--save"
                                onClick={() => handleComposeExitAction('save')}
                                disabled={composeActionBusy}
                            >
                                Save to Drafts
                            </button>
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
