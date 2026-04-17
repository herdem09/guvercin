import React, { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from 'react'
import { useNavigate, useLocation } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import {
    normalizeMailboxResponse,
    dedupeStringsCaseInsensitive,
    indexInOrderIgnoreCase,
    defaultMailboxSidebarPriority,
} from '../utils/mailboxes'
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
import { queueComposeSend } from '../utils/composeSend.js'
import { buildThreads } from '../utils/threading.js'
import ExternalLinkPrompt from '../components/ExternalLinkPrompt.jsx'
import {
    copyTextToClipboard,
    getLinkClickBehavior,
    getUrlDomain,
    installIframeLinkInterceptor,
    openExternalUrl,
    sanitizeMailHtml,
    setDomainLinkBehavior,
    setLinkClickBehavior,
} from '../utils/externalLinks.js'
import './DashboardPage.css'
import SettingsPage from './SettingsPage.jsx'

const EMPTY_OBJECT = Object.freeze({})
const TOOLBAR_STYLE_DEFAULT = 'icon_text_small'
const TOOLBAR_STYLE_OPTIONS = new Set([
    'icon_small',
    'icon_large',
    'text_small',
    'icon_text_small',
    'icon_text_large_vertical',
])

function normalizeToolbarStyle(value) {
    const normalized = (value || '').toString().trim().toLowerCase()
    return TOOLBAR_STYLE_OPTIONS.has(normalized) ? normalized : TOOLBAR_STYLE_DEFAULT
}

function resizeIframeToContent(iframe) {
    if (!iframe) return
    try {
        const doc = iframe.contentDocument
        if (!doc) return
        const body = doc.body
        const html = doc.documentElement
        const height = Math.max(
            1,
            Math.ceil(
                Math.max(
                    html?.scrollHeight || 0,
                    body?.scrollHeight || 0,
                    html?.getBoundingClientRect?.().height || 0,
                    body?.getBoundingClientRect?.().height || 0,
                ),
            ),
        )
        iframe.style.height = `${height}px`
    } catch {
        // ignore (sandbox / cross-origin)
    }
}

function ResizableHtmlIframe({ html, title, onLinkClick }) {
    const ref = useRef(null)

    useEffect(() => {
        const iframe = ref.current
        if (!iframe) return
        let disposeLinks = null

        const handleResize = () => resizeIframeToContent(iframe)
        const attachImageListeners = () => {
            try {
                const doc = iframe.contentDocument
                const images = Array.from(doc?.images || [])
                images.forEach((img) => {
                    if (!img) return
                    if (img.complete && img.naturalWidth > 0) return
                    img.addEventListener('load', handleResize, { once: true })
                    img.addEventListener('error', handleResize, { once: true })
                })
            } catch {
                // ignore
            }
        }

        iframe.onload = () => {
            handleResize()
            attachImageListeners()
            if (disposeLinks) disposeLinks()
            disposeLinks = installIframeLinkInterceptor(iframe, onLinkClick)
            window.setTimeout(handleResize, 50)
            window.setTimeout(handleResize, 250)
        }

        iframe.srcdoc = sanitizeMailHtml(html) || ''
        window.setTimeout(handleResize, 50)
        return () => {
            if (iframe) iframe.onload = null
            if (disposeLinks) disposeLinks()
        }
    }, [html, onLinkClick])

    return <iframe ref={ref} title={title} sandbox="allow-same-origin allow-scripts" />
}

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
                setSubmenuVisibleCount((prev) => (prev === items.length ? prev : items.length))
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
            setSubmenuVisibleCount((prev) => (prev === count ? prev : count))
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

function LayoutFrame({ region, bar, children }) {
    if (!bar) return children
    const safeRegion = ['top', 'bottom', 'left', 'right'].includes(region) ? region : 'top'
    const isRow = safeRegion === 'left' || safeRegion === 'right'
    const placeBefore = safeRegion === 'top' || safeRegion === 'left'
    const wrapBar = (node) => (
        <div className={`db-layout-region db-layout-region--${safeRegion}`} style={{ display: 'contents' }}>
            {node}
        </div>
    )
    return (
        <div className={`db-layout-frame db-layout-frame--${isRow ? 'row' : 'column'}`}>
            {placeBefore && wrapBar(bar)}
            <div className="db-layout-frame__content">
                {children}
            </div>
            {!placeBefore && wrapBar(bar)}
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
    const timeOptions = { hour: '2-digit', minute: '2-digit' }
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

async function buildVisualPdfBytesFromHtml(html, { accountId } = {}) {
    const pageWidthPt = 595.28
    const pageHeightPt = 841.89
    const marginPt = 20
    const printableWidthPt = pageWidthPt - marginPt * 2
    const printableHeightPt = pageHeightPt - marginPt * 2

    const frame = document.createElement('iframe')
    frame.style.position = 'fixed'
    frame.style.left = '-10000px'
    frame.style.top = '0'
    frame.style.width = '1024px'
    frame.style.height = '1000px'
    frame.style.border = '0'
    frame.style.background = 'white'
    frame.setAttribute('aria-hidden', 'true')

    const cleanup = () => {
        window.setTimeout(() => frame.remove(), 200)
    }

    const awaitLoad = () => new Promise((resolve, reject) => {
        const timer = window.setTimeout(() => reject(new Error('HTML render timed out.')), 20000)
        frame.onload = () => {
            window.clearTimeout(timer)
            resolve()
        }
    })

    document.body.appendChild(frame)
    frame.srcdoc = html
    await awaitLoad()

    const doc = frame.contentDocument
    if (!doc) {
        cleanup()
        throw new Error('HTML render failed.')
    }

    if (accountId) {
        const imgs = Array.from(doc.querySelectorAll('img'))
        imgs.forEach((img) => {
            const src = `${img.getAttribute('src') || ''}`.trim()
            if (/^https?:\/\//i.test(src)) {
                img.setAttribute('crossorigin', 'anonymous')
                img.src = apiUrl(`/api/mail/${accountId}/proxy-image?url=${encodeURIComponent(src)}`)
            }
        })
    }

    const images = Array.from(doc.images || [])
    const awaitImages = async () => {
        const start = Date.now()
        await Promise.all(images.map((img) => new Promise((resolve) => {
            if (!img) return resolve()
            if (img.complete && img.naturalWidth > 0) return resolve()
            const done = () => {
                img.removeEventListener('load', done)
                img.removeEventListener('error', done)
                resolve()
            }
            img.addEventListener('load', done)
            img.addEventListener('error', done)
        })))
        // extra small wait for layout
        const elapsed = Date.now() - start
        if (elapsed < 150) {
            await new Promise((r) => window.setTimeout(r, 150 - elapsed))
        }
    }

    await awaitImages()

    try {
        const [{ default: html2canvas }, { PDFDocument }] = await Promise.all([
            import('html2canvas'),
            import('pdf-lib'),
        ])

        const body = doc.body
        const rect = body.getBoundingClientRect()
        const width = Math.max(1, Math.ceil(rect.width || doc.documentElement.scrollWidth || 1024))
        const height = Math.max(1, Math.ceil(doc.documentElement.scrollHeight || body.scrollHeight || 1000))
        frame.style.width = `${width}px`
        frame.style.height = `${Math.min(height, 1200)}px`

        const canvas = await html2canvas(body, {
            backgroundColor: '#ffffff',
            scale: 2,
            useCORS: true,
            allowTaint: false,
            windowWidth: width,
            windowHeight: height,
            scrollX: 0,
            scrollY: 0,
        })

        const ptPerPx = printableWidthPt / canvas.width
        const sliceHeightPx = Math.max(1, Math.floor(printableHeightPt / ptPerPx))

        const pdf = await PDFDocument.create()

        const toJpegBytes = (canvasEl) => {
            const dataUrl = canvasEl.toDataURL('image/jpeg', 0.92)
            const base64 = dataUrl.split(',')[1] || ''
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
            return bytes
        }

        for (let y = 0; y < canvas.height; y += sliceHeightPx) {
            const slice = document.createElement('canvas')
            slice.width = canvas.width
            slice.height = Math.min(sliceHeightPx, canvas.height - y)
            const ctx = slice.getContext('2d')
            ctx.drawImage(canvas, 0, y, canvas.width, slice.height, 0, 0, canvas.width, slice.height)

            const jpegBytes = toJpegBytes(slice)
            const jpg = await pdf.embedJpg(jpegBytes)
            const page = pdf.addPage([pageWidthPt, pageHeightPt])
            const drawHeightPt = slice.height * ptPerPx
            page.drawImage(jpg, {
                x: marginPt,
                y: pageHeightPt - marginPt - drawHeightPt,
                width: printableWidthPt,
                height: drawHeightPt,
            })
        }

        const out = await pdf.save()
        cleanup()
        return out
    } catch (error) {
        cleanup()
        throw error
    }
}

const DashboardPage = () => {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const location = useLocation()
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
    const [appLayout, setAppLayout] = useState({
        top: ['main', 'tabs'],
        bottom: ['tools'],
        left: ['apps', 'mailboxes', 'maillist'],
        right: []
    })
    const [accountId, setAccountId] = useState(null)
    const [accountForm, setAccountForm] = useState({})
    const [email, setEmail] = useState('')

    const [connected, setConnected] = useState(false)
    const [connecting, setConnecting] = useState(false)
    const [folders, setFolders] = useState([])
    const [labels, setLabels] = useState([])
    const [mailboxCounts, setMailboxCounts] = useState({})
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
    const [settingsPageOpen, setSettingsPageOpen] = useState(false)
    const [toolbarStyle, setToolbarStyle] = useState(() => normalizeToolbarStyle(localStorage.getItem('toolbar_style')))
    const [isMailFullscreen, setIsMailFullscreen] = useState(false)
    const [appMenuVisible, setAppMenuVisible] = useState(true)
    const [isSyncing, setIsSyncing] = useState(false)
    const [actionNotices, setActionNotices] = useState([])
    const [noticeNow, setNoticeNow] = useState(Date.now())

    const accountButtonRef = useRef(null)
    const accountMenuRef = useRef(null)
    const accountWrapperRef = useRef(null)
    const iframeRef = useRef(null)
    const mailIframeLinkCleanupRef = useRef(null)

    const [externalLinkPromptUrl, setExternalLinkPromptUrl] = useState(null)

    const handleExternalLink = useCallback(async (url) => {
        const behavior = await getLinkClickBehavior(url)
        if (behavior === 'open') {
            await openExternalUrl(url)
            return
        }
        if (behavior === 'copy') {
            await copyTextToClipboard(url)
            return
        }
        setExternalLinkPromptUrl(url)
    }, [])

    const closeExternalLinkPrompt = useCallback(() => setExternalLinkPromptUrl(null), [])

    const onExternalLinkPromptSelect = useCallback(async (action, remember, rememberDomain) => {
        const url = externalLinkPromptUrl
        setExternalLinkPromptUrl(null)
        if (!url) return
        if (action === 'open') {
            await openExternalUrl(url)
        } else if (action === 'copy') {
            await copyTextToClipboard(url)
        }
        
        if (action === 'open' || action === 'copy') {
            if (remember) {
              await setLinkClickBehavior(action)
            } else if (rememberDomain) {
              const domain = getUrlDomain(url)
              if (domain) {
                await setDomainLinkBehavior(domain, action)
              }
            }
        }
    }, [externalLinkPromptUrl])
    const syncAbortRef = useRef(null)
    const isSyncingRef = useRef(false)
    const autoRefreshInFlightRef = useRef(false)
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
        if (location.state?.openSettings) {
            setSettingsPageOpen(true)
            navigate(location.pathname, { replace: true, state: {} })
        }
    }, [location.pathname, location.state, navigate])

    useEffect(() => {
        if (!accountMenuOpen) return
        const onPointerDown = (e) => {
            if (accountWrapperRef.current?.contains(e.target)) return
            setAccountMenuOpen(false)
        }
        document.addEventListener('mousedown', onPointerDown)
        document.addEventListener('touchstart', onPointerDown, { passive: true })
        return () => {
            document.removeEventListener('mousedown', onPointerDown)
            document.removeEventListener('touchstart', onPointerDown)
        }
    }, [accountMenuOpen])

    useEffect(() => {
        if (!accountMenuOpen) return
        const onKey = (e) => {
            if (e.key === 'Escape') setAccountMenuOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [accountMenuOpen])

    useEffect(() => {
        const syncToolbarStyle = () => {
            setToolbarStyle(normalizeToolbarStyle(localStorage.getItem('toolbar_style')))
        }
        window.addEventListener('guvercin-toolbar-style-changed', syncToolbarStyle)
        return () => window.removeEventListener('guvercin-toolbar-style-changed', syncToolbarStyle)
    }, [])

    const fetchMailboxCounts = useCallback(async () => {
        if (!accountId || !backendReachable) return
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/mailbox-counts`), { cache: 'no-store' })
            if (!res.ok) return
            const data = await res.json()
            if (data.counts && typeof data.counts === 'object') {
                setMailboxCounts(data.counts)
            }
        } catch {
            /* keep previous */
        }
    }, [accountId, backendReachable])

    const mailboxCountDisplayMode = useMemo(() => {
        const m = (accountForm.mailbox_count_display || 'both').toString().toLowerCase()
        return ['unread_only', 'total_only', 'both', 'none'].includes(m) ? m : 'both'
    }, [accountForm.mailbox_count_display])

    useEffect(() => {
        const loadLayout = () => {
            const l = localStorage.getItem('layout')
            if (l) {
                try {
                    setAppLayout(JSON.parse(l))
                } catch (e) {}
            }
        }
        loadLayout()
        window.addEventListener('guvercin-layout-changed', loadLayout)
        return () => window.removeEventListener('guvercin-layout-changed', loadLayout)
    }, [])

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

    useEffect(() => {
        setMailboxCounts({})
    }, [accountId])

    const fetchAccount = async (id) => {
        try {
            const res = await fetch(apiUrl('/api/auth/accounts'), { cache: 'no-store' })
            const data = await res.json()
            const accounts = Array.isArray(data?.accounts) ? data.accounts : []
            const acc = accounts.find((a) => a.account_id?.toString() === id.toString())
            if (acc) {
                setAccountForm(acc)
                setEmail(acc.email_address || '')
                const nextToolbarStyle = normalizeToolbarStyle(acc.toolbar_style || acc.toolbarStyle || localStorage.getItem('toolbar_style'))
                setToolbarStyle(nextToolbarStyle)
                localStorage.setItem('toolbar_style', nextToolbarStyle)
                if (acc.layout) {
                    try {
                        const parsed = JSON.parse(acc.layout)
                        setAppLayout(parsed)
                        localStorage.setItem('layout', acc.layout)
                    } catch (e) {}
                }
            }
        } catch {

        }
    }

    const accountLabel = accountForm.display_name || accountForm.email_address || 'User'
    const accountEmailLabel = accountForm.email_address || ''

    const layoutRegions = useMemo(() => {
        const fallback = {
            top: ['main', 'tabs'],
            bottom: ['tools'],
            left: ['apps', 'mailboxes', 'maillist'],
            right: []
        }
        const source = appLayout || fallback
        const map = {
            main: 'top',
            tabs: 'top',
            tools: 'bottom',
            apps: 'left',
            mailboxes: 'left',
            maillist: 'left'
        }
        const zones = ['top', 'bottom', 'left', 'right']
        zones.forEach((zone) => {
            const items = Array.isArray(source[zone]) ? source[zone] : []
            items.forEach((item) => {
                map[item] = zone
            })
        })
        return map
    }, [appLayout])

    const mainBarRegion = layoutRegions.main || 'top'
    const appsBarRegion = layoutRegions.apps || 'left'
    const isMainBarVertical = mainBarRegion === 'left' || mainBarRegion === 'right'
    const isMailboxesRight = layoutRegions.mailboxes === 'right'
    const isMaillistRight = layoutRegions.maillist === 'right'

    const handleAccountButtonClick = () => setAccountMenuOpen(!accountMenuOpen)
    const closeAccountMenu = () => setAccountMenuOpen(false)
    const handleAccountSettings = () => {
        closeAccountMenu()
        navigate('/account-settings')
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

    const foldersLoadedRef = useRef(null)

    const loadFolders = useCallback(async () => {
        if (!accountId || !backendReachable) return
        try {
            // First load from local cache
            let localRes = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' })
            if (localRes.ok) {
                const data = await localRes.json()
                const normalized = normalizeMailboxResponse(data)
                setFolders(prev => (JSON.stringify(prev) === JSON.stringify(normalized.allMailboxes) ? prev : normalized.allMailboxes))
                setLabels(prev => (JSON.stringify(prev) === JSON.stringify(normalized.labels) ? prev : normalized.labels))
            }

            // Then try remote if online
            if (networkOnline) {
                const ok = remoteMailAvailable || (await ensureImapConnected())
                if (ok) {
                    const remoteRes = await fetch(apiUrl(`/api/mail/${accountId}/mailboxes`), { cache: 'no-store' })
                    if (remoteRes.ok) {
                        const data = await remoteRes.json()
                        const normalized = normalizeMailboxResponse(data)
                        setFolders(prev => (JSON.stringify(prev) === JSON.stringify(normalized.allMailboxes) ? prev : normalized.allMailboxes))
                        setLabels(prev => (JSON.stringify(prev) === JSON.stringify(normalized.labels) ? prev : normalized.labels))
                    }
                }
            }
            void fetchMailboxCounts()
        } catch (err) {
            console.error('Error loading folders:', err)
        }
    }, [accountId, backendReachable, remoteMailAvailable, ensureImapConnected, networkOnline, fetchMailboxCounts])

    const handleReconnectImap = useCallback(async () => {
        if (!accountId || !backendReachable || !networkOnline || connecting) return
        const ok = await ensureImapConnected({ force: true, throttleMs: 0 })
        await refreshStatus(accountId)
        if (ok) {
            loadFolders()
        }
    }, [accountId, backendReachable, connecting, ensureImapConnected, loadFolders, networkOnline, refreshStatus])

    const loadMailsFromCache = useCallback(async (folder) => {
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
                const chunkWithMailbox = chunk.map(m => ({ ...m, mailbox: folder }))
                allMails.push(...chunkWithMailbox)
                
                if (typeof data.total_count === 'number') totalCount = data.total_count
                if (chunk.length < pageSize) break
                nextPage++
            }
            
            setMails(allMails)
            return true
        } catch (err) {
            console.error('Error loading mails from cache:', err)
            return false
        }
    }, [accountId, backendReachable, listMode])

    const syncMailsFromRemote = useCallback(async (targetFolder) => {
        const folder = targetFolder || selectedFolder
        if (!accountId || !remoteMailAvailable || !folder || listMode === 'search') return false
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/sync-mailbox?mailbox=${encodeURIComponent(folder)}`), { method: 'POST' })
            return res.ok
        } catch (err) {
            console.error('Error syncing mails from remote:', err)
            return false
        }
    }, [accountId, remoteMailAvailable, listMode, selectedFolder])

    const loadMails = useCallback(async (options = {}) => {
        const { forceRemote = false, allowCache = true } = options
        if (!accountId || !backendReachable) return
        
        if (allowCache) {
            await loadMailsFromCache(selectedFolder)
        }

        if (forceRemote || remoteMailAvailable) {
            const ok = await syncMailsFromRemote(selectedFolder)
            if (ok) {
                await loadMailsFromCache(selectedFolder)
                void fetchMailboxCounts()
            }
        }
    }, [accountId, backendReachable, remoteMailAvailable, selectedFolder, loadMailsFromCache, syncMailsFromRemote, fetchMailboxCounts])

    useEffect(() => {
        if (!accountId || !backendReachable) return
        loadMails({ allowCache: true, forceRemote: false })
    }, [accountId, backendReachable, selectedFolder, loadMails])

    const prevRemoteMailAvailableRef = useRef(false)
    useEffect(() => {
        const prev = prevRemoteMailAvailableRef.current
        prevRemoteMailAvailableRef.current = remoteMailAvailable
        if (!prev && remoteMailAvailable && activeSection === 'mail' && backendReachable) {
            loadFolders()
        }
    }, [activeSection, backendReachable, remoteMailAvailable, loadFolders])

    useEffect(() => {
        const currentRefKey = `${accountId}-${backendReachable}-${activeSection}`
        if (accountId && activeSection === 'mail' && backendReachable) {
            if (foldersLoadedRef.current === currentRefKey) return
            foldersLoadedRef.current = currentRefKey
            loadFolders()
        }
    }, [accountId, activeSection, backendReachable, loadFolders])

    useEffect(() => {
        if (folders.length > 0 && !folders.find(f => f.name === selectedFolder)) {
            setSelectedFolder(folders[0].name)
        }
    }, [folders, selectedFolder])

    useEffect(() => {
        if (activeSection !== 'mail' || !backendReachable || listMode === 'search') return
        setCurrentPage(1)
    }, [activeSection, backendReachable, listMode, selectedFolder])

    useEffect(() => {
        if (!accountId || activeSection !== 'mail' || !backendReachable || listMode === 'search') return
        if (!selectedFolder) return

        const MAIL_AUTO_REFRESH_INTERVAL_MS = 15_000
        let cancelled = false

        const tick = async () => {
            if (cancelled) return
            if (autoRefreshInFlightRef.current) return
            autoRefreshInFlightRef.current = true
            try {
                await loadMails({ allowCache: true, forceRemote: false })
                if (cancelled) return
                void fetchMailboxCounts()
            } finally {
                autoRefreshInFlightRef.current = false
            }
        }

        const timer = window.setInterval(tick, MAIL_AUTO_REFRESH_INTERVAL_MS)
        return () => {
            cancelled = true
            window.clearInterval(timer)
        }
    }, [
        accountId,
        activeSection,
        backendReachable,
        fetchMailboxCounts,
        listMode,
        loadMails,
        selectedFolder,
    ])


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
        try {
            const sourceFolder = selectedFolder || 'INBOX'
            const mailboxById = new Map(
                mails.filter((mail) => ids.includes(mail.id)).map((mail) => [mail.id, mail.mailbox || sourceFolder]),
            )
            await Promise.all(ids.map((id) => (
                queueAction(seen ? 'mark_read' : 'mark_unread', id, {}, mailboxById.get(id) || sourceFolder)
            )))
        } catch (error) {
            console.error('Failed to queue seen-state change:', error)
        }
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
            const ok = await queueComposeSend({
                draft: composed,
                accountEmail: email || accountEmailLabel,
                queueAction,
                confirm: async (normalized, context = {}) => {
                    if (context?.type === 'forward_many') {
                        const forwardCount = Number(context?.count) || 0
                        if (forwardCount <= 1) return true
                        const forwardPreview = (normalized?.forwardTargets || [])
                            .slice(0, 8)
                            .map((t) => `- ${(t?.from || '').trim() || '(unknown)'} :: ${(t?.subject || '').trim() || '(No Subject)'}`)
                            .join('\n')
                        const forwardSuffix = forwardCount > 8 ? `\n...and ${forwardCount - 8} more` : ''
                        return window.confirm(`Send ${forwardCount} separate forwards?\n\n${forwardPreview}${forwardSuffix}`)
                    }

                    const count = Array.isArray(normalized?.bulkReplyTargets) ? normalized.bulkReplyTargets.length : 0
                    if (count <= 0) return true
                    const preview = normalized.bulkReplyTargets
                        .slice(0, 8)
                        .map((t) => `- ${t.address || '(unknown)'} :: ${t.subject || '(No Subject)'}`)
                        .join('\n')
                    const suffix = count > 8 ? `\n...and ${count - 8} more` : ''
                    return window.confirm(`Send ${count} separate replies?\n\n${preview}${suffix}`)
                },
            })
            return ok
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
        if (!iframeRef.current || !mailContent?.html_body) return
        const iframe = iframeRef.current
        try {
            const doc = iframe.contentDocument
            doc.open()
            doc.write(sanitizeMailHtml(mailContent.html_body))
            doc.close()
            resizeIframeToContent(iframe)
            window.setTimeout(() => resizeIframeToContent(iframe), 50)
            window.setTimeout(() => resizeIframeToContent(iframe), 250)
            if (mailIframeLinkCleanupRef.current) mailIframeLinkCleanupRef.current()
            mailIframeLinkCleanupRef.current = installIframeLinkInterceptor(iframe, (href) => {
                handleExternalLink(href)
            })
            const images = Array.from(doc?.images || [])
            images.forEach((img) => {
                if (!img) return
                if (img.complete && img.naturalWidth > 0) return
                img.addEventListener('load', () => resizeIframeToContent(iframe), { once: true })
                img.addEventListener('error', () => resizeIframeToContent(iframe), { once: true })
            })
        } catch {
            // ignore
        }
        return () => {
            if (mailIframeLinkCleanupRef.current) {
                mailIframeLinkCleanupRef.current()
                mailIframeLinkCleanupRef.current = null
            }
        }
    }, [iframeRef, mailContent, handleExternalLink])

    useEffect(() => {
        if (mailContent?.html_body) return
        if (mailIframeLinkCleanupRef.current) {
            mailIframeLinkCleanupRef.current()
            mailIframeLinkCleanupRef.current = null
        }
    }, [mailContent])

    const nowForClock = new Date()
    const hour12Pref = systemHour12Preference()
    const timeFormatter = new Intl.DateTimeFormat(undefined, {
        hour: '2-digit',
        minute: '2-digit',
        hour12: typeof hour12Pref === 'boolean' ? hour12Pref : undefined
    })
    const timeStr = timeFormatter.format(nowForClock)
    const dateDayMonth = new Intl.DateTimeFormat(undefined, { day: '2-digit', month: '2-digit' })
        .format(nowForClock)
        .replace(/[\/-]/g, '.')
    const dateYear = new Intl.DateTimeFormat(undefined, { year: 'numeric' }).format(nowForClock)
    const [timeMain, timeSuffix] = timeStr.includes(' ')
        ? timeStr.split(' ')
        : [timeStr, '']
    const [timeTop, timeBottomRaw] = timeMain.includes(':')
        ? timeMain.split(':')
        : [timeMain, '']
    const timeBottom = timeSuffix ? `${timeBottomRaw} ${timeSuffix}`.trim() : timeBottomRaw

    const mainBarNode = (
            <div className={`db-navbar db-navbar--${mainBarRegion}`}>
                <button
                    className="db-logo-btn"
                    style={{
                        padding: 0,
                        height: '40px',
                        background: 'transparent',
                        minWidth: isMainBarVertical ? '0' : '130px',
                        border: 'none'
                    }}
                >
                    <img src="/img/logo/guvercin-righttext-nobackground.svg" alt="Guvercin" style={{ height: '100%', width: 'auto', display: 'block' }} />
                </button>
                {isMainBarVertical ? (
                    <button
                        type="button"
                        className="db-search-compact-btn"
                        onClick={() => setIsAdvancedSearchOpen(true)}
                        title={t('Advanced search')}
                        aria-label={t('Advanced search')}
                    >
                        <img src="/img/icons/search.svg" className="svg-icon-inline" />
                    </button>
                ) : (
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
                )}
                <div className="db-navbar-right">
                    <div className="db-navbar-right__top">
                        <div className={`db-clock${isMainBarVertical ? ' db-clock--stack' : ''}`}>
                            {isMainBarVertical ? (
                                <>
                                    <span className="db-clock-item db-clock-item--stack">{timeTop} {timeBottom}</span>
                                    <span className="db-clock-item db-clock-item--stack">{dateDayMonth} {dateYear}</span>
                                </>
                            ) : (
                                <>
                                    <span className="db-clock-item">{time}</span>
                                    <span className="db-clock-item">{date}</span>
                                </>
                            )}
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
                    </div>
                    <div className="db-navbar-right__bottom">
                        <div className="db-account-wrapper" ref={accountWrapperRef}>
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
            </div>
    )

    const appsBarNode = (
                <div className={`db-sidebar${appMenuVisible ? '' : ' db-sidebar--hidden'}`}>
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
    )

    const dashboardContent = activeSection === 'mail' ? (
                            <MailSection
                                injectedMainBar={mainBarNode}
                                injectedAppsBar={appsBarNode}
                                appLayout={appLayout}
                                onExternalLink={handleExternalLink}
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
	                                setLoadingContent={setLoadingContent}
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
                                accountForm={accountForm}
                                mailboxCounts={mailboxCounts}
                                mailboxCountDisplayMode={mailboxCountDisplayMode}
                                appMenuVisible={appMenuVisible}
                                setAppMenuVisible={setAppMenuVisible}
                                toolbarStyle={toolbarStyle}
                            />
    ) : (
        <LayoutFrame region={mainBarRegion} bar={mainBarNode}>
            <LayoutFrame region={appsBarRegion} bar={appsBarNode}>
                <div className="db-main-container">
                    <div className="db-content-area">
                        <div className="db-section-area">
                            {activeSection === 'calendar' && <CalendarSection />}
                            {activeSection === 'contacts' && <ContactsSection />}
                            {activeSection === 'todo' && <TodoSection />}
                        </div>
                    </div>
                </div>
            </LayoutFrame>
        </LayoutFrame>
    )

    return (
        <div className="dashboard-page">
            <ExternalLinkPrompt
                open={!!externalLinkPromptUrl}
                url={externalLinkPromptUrl || ''}
                onCancel={closeExternalLinkPrompt}
                onSelect={onExternalLinkPromptSelect}
            />
            {dashboardContent}
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

                        <div className="db-advanced-search-topbar">
                            <div className="db-search db-search--advanced">
                                <input
                                    type="text"
                                    placeholder="Search..."
                                    value={searchText}
                                    onChange={(e) => setSearchText(e.target.value)}
                                    onKeyDown={(e) => {
                                        if (e.key !== 'Enter') return
                                        const trimmed = searchText.trim()
                                        if (!trimmed) return
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
                                        if (!trimmed) return
                                        executeAdvancedSearch({ draftOverride: { keywords: trimmed } })
                                    }}
                                    aria-label={t('Search')}
                                    title={t('Search')}
                                >
                                    <img src="/img/icons/search.svg" className="svg-icon-inline" />
                                </button>
                            </div>
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
                <SettingsPage 
                    onClose={() => setSettingsPageOpen(false)} 
                    accountId={accountId} 
                    onRefreshAccount={() => fetchAccount(accountId)}
                />
            )}
        </div>
    )
}

function MailSection({
    injectedMainBar,
    injectedAppsBar,
    appLayout,
    onExternalLink,
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
	    selectedMail, setSelectedMail, mailContent, setMailContent, loadingMails, loadingContent, setLoadingContent,
	    connecting, loadMailsFromCache, syncMailsFromRemote, prefetchInlineAssets, isSyncing,
	    openMail, detachMailToWindow, detachMailToWindowFromList, iframeRef, getShortTime,
    currentPage, setCurrentPage, maxPage: _maxPage, perPage, setPerPage,
    isMailFullscreen, toggleMailFullscreen,
    deleteMailsOptimistic, moveMailsOptimistic, setMailsSeenState, queueAction, createMailbox,
    canUseRemoteMail, inlineComposeSession, setInlineComposeSession, sendComposedMail, saveComposeDraft, enqueueUndoableAction,
    tabs, setTabs, activeTabId, setActiveTabId, tabContents, setTabContents, loadingTab, setLoadingTab,     nextTabId,
    accountForm,
    mailboxCounts,
    mailboxCountDisplayMode,
    appMenuVisible,
    setAppMenuVisible,
    toolbarStyle,
}) {
    const { t } = useTranslation()
    const hasFolderAccess = folders.length > 0
    const hasMailSource = canUseRemoteMail || hasFolderAccess
    const safeToolbarStyle = normalizeToolbarStyle(toolbarStyle)
    const [activeRibbonTab, setActiveRibbonTab] = useState('home')
    const [expandedFolders, setExpandedFolders] = useState(['INBOX'])
    const [folderWidth, setFolderWidth] = useState(240)
    const [listWidth, setListWidth] = useState(360)
    const [minListWidth, setMinListWidth] = useState(360)
	    const [expandedThreadIds, setExpandedThreadIds] = useState(() => new Set())
	    const [activeThreadReaderId, setActiveThreadReaderId] = useState(null)
	    const [threadReaderOpenIds, setThreadReaderOpenIds] = useState(() => new Set())
	    const [threadReaderLoadingIds, setThreadReaderLoadingIds] = useState(() => new Set())
	    const [threadReaderContentById, setThreadReaderContentById] = useState(() => ({}))
	    // Guard against rare builds/runtime states where this identifier is missing/undefined.
	    // `typeof` is safe even for undeclared identifiers (avoids ReferenceError in WebKit).
	    const threadReaderContentByIdSafe = (
	        typeof threadReaderContentById === 'undefined' || !threadReaderContentById
	    ) ? EMPTY_OBJECT : threadReaderContentById
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
    const [isDownloadAsMenuOpen, setIsDownloadAsMenuOpen] = useState(false)
    const [activeFilter, setActiveFilter] = useState('all')
    const [sortBy, setSortBy] = useState('date')
    const [sortDirection, setSortDirection] = useState('desc')
    const [isPerPageOpen, setIsPerPageOpen] = useState(false)
    const [attachmentsExpanded, setAttachmentsExpanded] = useState(true)
    const [fileActionLoading, setFileActionLoading] = useState('')
    const [importPreview, setImportPreview] = useState(null) // { mail, content, kind, fileName }
    const [importLoading, setImportLoading] = useState(false)
    const [importError, setImportError] = useState('')
    const [layoutCols, setLayoutCols] = useState(1)
    const [movePopoverStyle, setMovePopoverStyle] = useState(null)
    const [labelPopoverStyle, setLabelPopoverStyle] = useState(null)
    const [downloadAsPopoverStyle, setDownloadAsPopoverStyle] = useState(null)
    const [mailItemMenu, setMailItemMenu] = useState(null)
    const [mailItemMoveMenuStyle, setMailItemMoveMenuStyle] = useState(null)
    const [mailItemLabelMenuStyle, setMailItemLabelMenuStyle] = useState(null)
    const [dragOverTarget, setDragOverTarget] = useState(null)
    const [composeExitPrompt, setComposeExitPrompt] = useState(null)
    const [composeActionBusy, setComposeActionBusy] = useState(false)
    const [blockSenderModal, setBlockSenderModal] = useState(null)
    const [blockSenderApplyExisting, setBlockSenderApplyExisting] = useState(false)
    const [blockSenderSelectedFolder, setBlockSenderSelectedFolder] = useState('')
    const displayCols = isMailFullscreen ? layoutCols : 1
    const perPageValue = Math.max(1, Number.parseInt(perPage, 10) || 50)

    useEffect(() => {
        if (!accountId) return
        setExpandedThreadIds(new Set())
        setActiveThreadReaderId(null)
    }, [accountId])

    const resolveLayoutData = (layout) => {
        const fallback = {
            top: ['main', 'tabs'],
            bottom: ['tools'],
            left: ['apps', 'mailboxes', 'maillist'],
            right: []
        }
        const source = layout && typeof layout === 'object' ? layout : fallback
        const pick = (key) => (Array.isArray(source[key]) ? source[key].filter(Boolean) : [])
        return {
            top: pick('top'),
            bottom: pick('bottom'),
            left: pick('left'),
            right: pick('right'),
        }
    }

    const stripLayout = (layoutData, removeKeys) => {
        const remove = new Set(removeKeys)
        const strip = (items) => items.filter((item) => !remove.has(item))
        return {
            top: strip(layoutData.top || []),
            bottom: strip(layoutData.bottom || []),
            left: strip(layoutData.left || []),
            right: strip(layoutData.right || []),
        }
    }

    const layoutData = useMemo(() => resolveLayoutData(appLayout), [appLayout])
    const layoutRegions = useMemo(() => {
        const source = layoutData
        const map = {
            main: 'top',
            tabs: 'top',
            tools: 'bottom',
            apps: 'left',
            mailboxes: 'left',
            maillist: 'left'
        }
        const zones = ['top', 'bottom', 'left', 'right']
        zones.forEach((zone) => {
            const items = Array.isArray(source[zone]) ? source[zone] : []
            items.forEach((item) => {
                map[item] = zone
            })
        })
        return map
    }, [layoutData])

    const mainBarRegion = layoutRegions.main || 'top'
    const appsBarRegion = layoutRegions.apps || 'left'
    const innerLayoutData = useMemo(() => stripLayout(layoutData, ['main', 'apps']), [layoutData])
    const appMenuLeftPad = appMenuVisible && appsBarRegion === 'left' ? 48 : 0
    const isMailboxesRight = layoutRegions.mailboxes === 'right'
    const isMaillistRight = layoutRegions.maillist === 'right'

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

    const threadedEnabled = listMode !== 'search'
    useEffect(() => {
        if (threadedEnabled) return
        setActiveThreadReaderId(null)
    }, [threadedEnabled])
    const threadData = useMemo(() => {
        if (!threadedEnabled) return { threads: [], threadByMailId: new Map() }
        const threads = buildThreads(visibleMails, { threadOrder: 'asc', mailbox: selectedFolder })
        const threadByMailId = new Map()
        threads.forEach((thread) => {
            ;(thread?.mails || []).forEach((mail) => {
                if (mail?.id != null) threadByMailId.set(String(mail.id), thread)
            })
        })
        return { threads, threadByMailId }
    }, [threadedEnabled, visibleMails, selectedFolder])

    const visibleThreads = threadData.threads
    const selectedThread = selectedMail ? threadData.threadByMailId.get(String(selectedMail.id)) : null
    const showThreadReader = !!(threadedEnabled && selectedThread && activeThreadReaderId && String(activeThreadReaderId) === String(selectedThread.id))

    useEffect(() => {
        if (!threadedEnabled || !selectedThread?.id) return
        setExpandedThreadIds((prev) => {
            const next = new Set(prev)
            next.add(selectedThread.id)
            return next
        })
    }, [selectedThread?.id, threadedEnabled])

    const itemCount = threadedEnabled ? visibleThreads.length : visibleMails.length
    const filteredMaxPage = Math.max(1, Math.ceil(itemCount / perPageValue))
    const displayPage = Math.min(currentPage, filteredMaxPage)
    const pageStart = (displayPage - 1) * perPageValue
    const pagedVisibleMails = threadedEnabled ? [] : visibleMails.slice(pageStart, pageStart + perPageValue)
    const pagedVisibleThreads = threadedEnabled ? visibleThreads.slice(pageStart, pageStart + perPageValue) : []
    const selectedGlobalIndex = useMemo(() => {
        if (!selectedMail) return -1
        const selectedKey = String(selectedMail?.id ?? '')
        if (!selectedKey) return -1
        return visibleMails.findIndex((mail) => String(mail?.id ?? '') === selectedKey)
    }, [selectedMail, visibleMails])

    const selectedPage = selectedGlobalIndex >= 0 ? Math.floor(selectedGlobalIndex / perPageValue) + 1 : 1
    const selectedPageStart = (selectedPage - 1) * perPageValue
    const selectedIndexInPage = selectedGlobalIndex >= 0 ? (selectedGlobalIndex - selectedPageStart + 1) : 0
    const selectedPageCount = selectedGlobalIndex >= 0
        ? visibleMails.slice(selectedPageStart, selectedPageStart + perPageValue).length
        : 0
    const prevMail = selectedGlobalIndex > 0 ? visibleMails[selectedGlobalIndex - 1] : null
    const nextMail = selectedGlobalIndex >= 0 && selectedGlobalIndex < visibleMails.length - 1
        ? visibleMails[selectedGlobalIndex + 1]
        : null

    const selectedThreadGlobalIndex = useMemo(() => {
        if (!threadedEnabled || !selectedThread?.id) return -1
        return visibleThreads.findIndex((t) => String(t?.id ?? '') === String(selectedThread.id))
    }, [selectedThread?.id, threadedEnabled, visibleThreads])
    const selectedThreadPage = selectedThreadGlobalIndex >= 0
        ? Math.floor(selectedThreadGlobalIndex / perPageValue) + 1
        : 1

    const selectedThreadIndex = useMemo(() => {
        if (!threadedEnabled || !selectedThread) return -1
        return (selectedThread.mails || []).findIndex((m) => String(m?.id ?? '') === String(selectedMail?.id ?? ''))
    }, [selectedMail?.id, selectedThread, threadedEnabled])
    const selectedThreadCount = threadedEnabled && selectedThread ? (selectedThread.mails || []).length : 0
    const latestThreadMail = threadedEnabled && selectedThreadCount > 0
        ? selectedThread.mails[selectedThreadCount - 1]
        : null
    const selectedIsThreadAnchor = !!(latestThreadMail && selectedMail && String(selectedMail.id) === String(latestThreadMail.id))
    const prevThreadMail = threadedEnabled && selectedThreadIndex > 0 ? selectedThread.mails[selectedThreadIndex - 1] : null
    const nextThreadMail = threadedEnabled && selectedThread && selectedThreadIndex >= 0 && selectedThreadIndex < selectedThreadCount - 1
        ? selectedThread.mails[selectedThreadIndex + 1]
        : null

    const fetchMailContentForThreadReader = useCallback(async (mail) => {
        if (!mail || !accountId || !backendReachable) return null
        try {
            const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
            let endpoint = `/api/offline/${accountId}/local-content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
            let res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            if (!res.ok && canUseRemoteMail) {
                endpoint = `/api/mail/${accountId}/content/${mail.id}?mailbox=${encodeURIComponent(mailbox)}`
                res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
            }
            if (!res.ok) return null
            let data = await res.json()
            const html = await prefetchInlineAssets(mail.id, mailbox)
            if (html) data = { ...data, html_body: html }
            return data
        } catch {
            return null
        }
    }, [accountId, backendReachable, canUseRemoteMail, prefetchInlineAssets, selectedFolder])

    const toggleThreadReaderMail = useCallback((mail) => {
        const id = String(mail?.id ?? '')
        if (!id) return
        const wasOpen = threadReaderOpenIds.has(id)
        setThreadReaderOpenIds((prev) => {
            const next = new Set(prev)
            if (next.has(id)) next.delete(id)
            else next.add(id)
            return next
	        })
	
	        if (wasOpen) return
	        const alreadyHave = !!threadReaderContentByIdSafe?.[id]
	        const alreadyLoading = threadReaderLoadingIds.has(id)
	        if (alreadyHave || alreadyLoading) return

        setThreadReaderLoadingIds((prev) => {
            const next = new Set(prev)
            next.add(id)
            return next
        })
        fetchMailContentForThreadReader(mail).then((data) => {
            if (data) setThreadReaderContentById((prev) => ({ ...(prev || {}), [id]: data }))
        }).finally(() => {
            setThreadReaderLoadingIds((prev) => {
                const next = new Set(prev)
                next.delete(id)
                return next
	            })
	        })
	    }, [fetchMailContentForThreadReader, threadReaderContentByIdSafe, threadReaderLoadingIds, threadReaderOpenIds])

    useEffect(() => {
        if (!showThreadReader || !selectedThread?.id) {
            setThreadReaderOpenIds(new Set())
            setThreadReaderLoadingIds(new Set())
            setThreadReaderContentById({})
            return
        }
        setThreadReaderOpenIds(new Set())
        setThreadReaderLoadingIds(new Set())
        setThreadReaderContentById({})
    }, [selectedThread?.id, showThreadReader])

    useEffect(() => {
        if (!threadedEnabled || !showThreadReader) return
        const id = String(selectedMail?.id ?? '')
        if (!id || !mailContent || String(mailContent.id) !== id) return
        setThreadReaderContentById((prev) => ({ ...(prev || {}), [id]: mailContent }))
    }, [mailContent, selectedMail?.id, showThreadReader, threadedEnabled])

    const pagedSelectableMails = useMemo(() => {
        if (!threadedEnabled) return pagedVisibleMails
        const out = []
        pagedVisibleThreads.forEach((thread) => {
            ;(thread?.mails || []).forEach((mail) => {
                if (mail) out.push(mail)
            })
        })
        return out
    }, [pagedVisibleMails, pagedVisibleThreads, threadedEnabled])
    const selectedIdSet = selectedMailIds
    const actionableMails = useMemo(() => {
        if (selectMode && selectedIdSet.size > 0) {
            return mails.filter((mail) => selectedIdSet.has(mail.id))
        }
        if (selectedMail) return [selectedMail]
        return []
    }, [mails, selectMode, selectedIdSet, selectedMail])
    const actionableMailIds = actionableMails.map((mail) => mail.id)
    const hasAnyActionMail = actionableMails.length > 0
    const hasMultipleActionMails = actionableMails.length > 1
    const allActionMailsSeen = hasAnyActionMail && actionableMails.every((mail) => mail.seen === true)
    const homeReplyLabel = hasMultipleActionMails ? 'Bulk Reply' : 'Reply'
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

    const fetchReplySeed = useCallback(async (mail) => {
        if (!mail || !accountId) return null
        const mailbox = mail?.mailbox || selectedFolder || 'INBOX'
        const candidates = canUseRemoteMail
            ? [
                `/api/mail/${accountId}/reply-seed/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
                `/api/offline/${accountId}/reply-seed/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
            ]
            : [
                `/api/offline/${accountId}/reply-seed/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
                `/api/mail/${accountId}/reply-seed/${encodeURIComponent(mail.id)}?mailbox=${encodeURIComponent(mailbox)}`,
            ]

        for (const endpoint of candidates) {
            try {
                const res = await fetch(apiUrl(endpoint), { cache: 'no-store' })
                if (!res.ok) continue
                return await res.json().catch(() => null)
            } catch {
                /* ignore */
            }
        }
        return null
    }, [accountId, canUseRemoteMail, selectedFolder])

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
                    baselineDraft: sessionOrDraft?.baselineDraft || normalizedDraft,
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

    const openImportedMailInCompose = useCallback((content) => {
        if (!content) return
        const attachments = Array.isArray(content?.attachments)
            ? content.attachments.map((attachment) => ({
                id: attachment.id,
                name: attachment.filename,
                mimeType: attachment.content_type,
                size: attachment.size,
                base64: attachment.data_base64 || '',
                disposition: attachment.is_inline ? 'inline' : 'attachment',
                contentId: attachment.content_id || undefined,
                source: attachment.is_inline ? 'html-inline' : 'import',
            }))
            : []
        openInlineCompose({
            source: 'import',
            draft: {
                from: accountEmail || '',
                toRecipients: [],
                ccRecipients: [],
                bccRecipients: [],
                subject: content?.subject || '',
                plainBody: content?.plain_body || '',
                htmlBody: content?.html_body || '',
                format: (content?.html_body || '').trim() ? 'html' : 'plain',
                attachments,
                showCc: false,
                showBcc: false,
            },
        }, { preserveExisting: false })
    }, [accountEmail, openInlineCompose])

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
        if (payload.to.length + payload.cc.length + payload.bcc.length === 0) {
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
            if (intent === 'select_mail' && pendingMail) {
                setSelectedMail(pendingMail)
                setMailContent(null)
                setLoadingContent(false)
            }
            return
        }

        setComposeExitPrompt({
            target,
            draft,
            intent,
            pendingMail,
        })
    }, [closeComposeTarget, openMailOrDraft, setMailContent, setSelectedMail])

    const continueComposeExitIntent = useCallback(async (prompt) => {
        if (prompt?.intent === 'open_mail' && prompt.pendingMail) {
            await openMailOrDraft(prompt.pendingMail)
        }
        if (prompt?.intent === 'select_mail' && prompt.pendingMail) {
            setSelectedMail(prompt.pendingMail)
            setMailContent(null)
            setLoadingContent(false)
        }
    }, [openMailOrDraft, setMailContent, setSelectedMail])

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
        setActiveThreadReaderId(null)
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

    const attemptSelectMailPreview = useCallback(async (mail) => {
        if (!mail) return
        if (!inlineComposeSession) {
            setSelectedMail(mail)
            setMailContent(null)
            setLoadingContent(false)
            return
        }

        const hasMeaningfulChanges = inlineComposeSession?.baselineDraft
            ? isComposeDraftModified(inlineComposeSession.draft, inlineComposeSession.baselineDraft)
            : isComposeDraftDirty(inlineComposeSession.draft)
        if (!hasMeaningfulChanges) {
            setInlineComposeSession(null)
            setSelectedMail(mail)
            setMailContent(null)
            setLoadingContent(false)
            return
        }

        setComposeExitPrompt({
            target: {
                type: 'inline',
                id: inlineComposeSession.id,
                source: inlineComposeSession.source,
            },
            draft: inlineComposeSession.draft,
            intent: 'select_mail',
            pendingMail: mail,
        })
    }, [inlineComposeSession, setInlineComposeSession, setMailContent, setSelectedMail])

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
        return (values || []).filter((value) => {
            const email = `${value || ''}`.trim()
            const key = email.toLowerCase()
            if (!email || seen.has(key)) return false
            seen.add(key)
            return true
        })
    }

    const buildQuotedMailBlock = (mail, content) => {
        const fromLabel = content?.from_name
            ? `${content.from_name} <${content.from_address}>`
            : (mail.name ? `${mail.name} <${mail.address}>` : mail.address)
        const subject = content?.subject || mail.subject || '(No Subject)'
        const date = content?.date || mail.date
        const body = content?.plain_body || htmlToPlainText(content?.html_body) || '(No content)'
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
            const pdfBytes = (content?.html_body || '').trim()
                ? await buildVisualPdfBytesFromHtml(
                    buildMailHtmlDocument(mail, content, formatMailDateLong),
                    { accountId },
                )
                : buildSimplePdfBytes(buildMailPlainText(mail, content, formatMailDateLong))
            const fileName = `${buildExportBaseName(mail, content)}.pdf`
            await saveBlobWithPicker(new Blob([pdfBytes], { type: 'application/pdf' }), {
                suggestedName: fileName,
                types: [{ description: 'PDF file', accept: { 'application/pdf': ['.pdf'] } }],
            })
        })
    }, [accountId, formatMailDateLong, runFileAction])

    const handlePrintMail = useCallback(() => {
        runFileAction('print', async (mail, content) => {
            const html = buildMailHtmlDocument(mail, content, formatMailDateLong)
            await printMailHtml(html)
        })
    }, [formatMailDateLong, runFileAction])

    const triggerBrowserDownload = useCallback((fileName, mimeType, bytes) => {
        const blob = new Blob([bytes], { type: mimeType || 'application/octet-stream' })
        const url = URL.createObjectURL(blob)
        const link = document.createElement('a')
        link.href = url
        link.download = fileName || 'download'
        document.body.appendChild(link)
        link.click()
        link.remove()
        window.setTimeout(() => URL.revokeObjectURL(url), 250)
    }, [])

    const downloadAttachmentFromBase64 = useCallback((attachment) => {
        const base64 = attachment?.data_base64
        if (!base64) return
        const fileName = attachment?.filename || 'attachment'
        const mimeType = attachment?.content_type || 'application/octet-stream'
        try {
            const binary = atob(base64)
            const bytes = new Uint8Array(binary.length)
            for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i)
            triggerBrowserDownload(fileName, mimeType, bytes)
        } catch (error) {
            console.error('Failed to download base64 attachment:', error)
            window.alert('Failed to download attachment.')
        }
    }, [triggerBrowserDownload])

    const handleOpenImportPicker = useCallback(() => {
        setImportError('')
        if (!importFileInputRef.current) return
        importFileInputRef.current.click()
    }, [])

    const handleImportFilePicked = useCallback(async (event) => {
        if (!accountId) return
        const input = event?.target
        const file = input?.files?.[0]
        if (input) input.value = ''
        if (!file) return

        const nameLower = `${file.name || ''}`.toLowerCase()
        const kind = nameLower.endsWith('.eml') ? 'eml' : (nameLower.endsWith('.msg') ? 'msg' : '')
        if (!kind) {
            window.alert('Please select a .eml or .msg file.')
            return
        }

        setImportLoading(true)
        setImportError('')
        try {
            const bytes = await file.arrayBuffer()
            const endpoint = `/api/mail/${accountId}/import-preview?kind=${encodeURIComponent(kind)}`
            const res = await fetch(apiUrl(endpoint), {
                method: 'POST',
                headers: { 'Content-Type': 'application/octet-stream' },
                body: bytes,
            })
            if (!res.ok) {
                const text = await res.text().catch(() => '')
                throw new Error(text || 'Import failed.')
            }
            const data = await res.json()
            setImportPreview({
                mail: data?.mail || null,
                content: data?.content || null,
                kind,
                fileName: file.name || '',
            })
            setSelectedMail(null)
            setMailContent(null)
            setInlineComposeSession(null)
        } catch (error) {
            console.error('Import preview failed:', error)
            const msg = error?.message || 'Import failed.'
            setImportError(msg)
            window.alert(msg)
        } finally {
            setImportLoading(false)
        }
    }, [accountId, setInlineComposeSession, setMailContent, setSelectedMail])

    useEffect(() => {
        if (selectedMail || inlineComposeSession) {
            setImportPreview(null)
        }
    }, [inlineComposeSession, selectedMail])

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
        setIsDownloadAsMenuOpen(false)
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
    const downloadAsMenuRef = useRef(null)
    const submenuMoreRef = useRef(null)
    const [isSubmenuMoreOpen, setIsSubmenuMoreOpen] = useState(false)
    const [submenuVisibleCount, setSubmenuVisibleCount] = useState(99)
    const importFileInputRef = useRef(null)
    const mailItemMenuRef = useRef(null)
    const isResizingFolder = useRef(false)
    const isResizingList = useRef(false)
    const mailToolbarRef = useRef(null)
    const isDraggingRef = useRef(false)
    const dragPreviewRef = useRef(null)
    const nextComposeWindowId = useRef(0)
    const nextImportedMailWindowId = useRef(0)

    useEffect(() => () => {
        if (dragPreviewRef.current) {
            dragPreviewRef.current.remove()
            dragPreviewRef.current = null
        }
    }, [])

    const createMailDragPreview = useCallback((count) => {
        const node = document.createElement('div')
        node.className = 'db-mail-drag-preview'
        node.textContent = count === 1 ? '1 mail' : `${count} mails`
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

    const detachImportedMailToWindow = useCallback(async (mail, content) => {
        if (!accountId || !mail || !content) return
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            nextImportedMailWindowId.current += 1
            const mailWindowLabel = `import-mail-${nextImportedMailWindowId.current}`
            const mailbox = mail?.mailbox || selectedFolder || 'Imported'
            const mailData = {
                mail,
                mailContent: content,
                accountId,
                mailbox,
                preferOffline: !canUseRemoteMail,
            }
            await invoke('open_mail_window', {
                label: mailWindowLabel,
                mailDataJson: JSON.stringify(mailData),
            })
            setImportPreview(null)
        } catch (error) {
            console.error('Failed to open imported mail window:', error)
        }
    }, [accountId, canUseRemoteMail, selectedFolder])

    const syncPopoverPosition = useCallback((
        menuRef,
        setStyle,
        estimatedWidth = 220,
        gapBelow = 6,
        horizontal = 'default',
    ) => {
        const node = menuRef.current
        if (!node) {
            setStyle(null)
            return
        }

        const rect = node.getBoundingClientRect()
        const pad = 12
        let left
        if (horizontal === 'underAnchor') {
            const w = estimatedWidth
            left = rect.left
            if (left + w > window.innerWidth - pad) {
                left = rect.right - w
            }
            if (left < pad) left = pad
            if (left + w > window.innerWidth - pad) {
                left = Math.max(pad, window.innerWidth - w - pad)
            }
        } else {
            left = Math.min(
                Math.max(pad, rect.left),
                Math.max(pad, window.innerWidth - estimatedWidth - pad),
            )
        }

        setStyle({
            left: `${left}px`,
            top: `${rect.bottom + gapBelow}px`,
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
            style: clampFloatingMenuPosition(left, top, 240, 420),
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

    useLayoutEffect(() => {
        if (!mailItemMenu?.mail || !mailItemMenuRef.current) return
        const raf = window.requestAnimationFrame(() => {
            const node = mailItemMenuRef.current?.querySelector?.('.db-submenu-popover.db-mail-item-menu')
            if (!node) return
            const rect = node.getBoundingClientRect()
            const current = mailItemMenu?.style || {}
            const left = Number.parseFloat(current.left) || rect.left
            const top = Number.parseFloat(current.top) || rect.top
            const width = Math.max(200, Math.ceil(rect.width || 240))
            const height = Math.max(160, Math.ceil(rect.height || 420))
            const nextStyle = clampFloatingMenuPosition(left, top, width, height)
            if (nextStyle.left !== current.left || nextStyle.top !== current.top) {
                setMailItemMenu((prev) => (prev ? { ...prev, style: nextStyle } : prev))
            }
        })
        return () => window.cancelAnimationFrame(raf)
    }, [clampFloatingMenuPosition, mailItemMenu?.labelMenuOpen, mailItemMenu?.mail, mailItemMenu?.moveMenuOpen])

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
    const pendingTabLoadsRef = useRef(new Set())
    const loadingTabCountRef = useRef(0)

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
        pendingTabLoadsRef.current.add(tabId)

        // Create + activate the tab immediately so the user doesn't just see the main view ("anasayfa")
        setTabs((prev) => [...prev, { id: tabId, kind: 'mail', mail, mailbox }])
        setActiveTabId(tabId)
        setSelectedMail(null)
        setMailContent(null)

        let content = existingContent
        if (!content) {
            loadingTabCountRef.current += 1
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

            } finally {
                loadingTabCountRef.current = Math.max(0, loadingTabCountRef.current - 1)
                if (loadingTabCountRef.current === 0) {
                    setLoadingTab(false)
                }
            }
        }
        if (mail.seen !== true) {
            setMailsSeenState([mail.id], true)
        }
        if (pendingTabLoadsRef.current.has(tabId)) {
            setTabContents((prev) => ({ ...prev, [tabId]: content }))
        }
        pendingTabLoadsRef.current.delete(tabId)
    }

    const openImportedMailInTab = useCallback((mail, content) => {
        if (!mail || !content) return
        nextTabId.current += 1
        const tabId = `tab-${nextTabId.current}`
        const mailbox = mail?.mailbox || 'Imported'
        setTabs((prev) => [...prev, { id: tabId, kind: 'mail', mail, mailbox }])
        setTabContents((prev) => ({ ...prev, [tabId]: content }))
        setActiveTabId(tabId)
        setSelectedMail(null)
        setMailContent(null)
        setInlineComposeSession(null)
        setImportPreview(null)
    }, [nextTabId, setActiveTabId, setInlineComposeSession, setMailContent, setSelectedMail, setTabContents, setTabs])

    const closeTab = (e, tabId) => {
        e.stopPropagation()
        pendingTabLoadsRef.current.delete(tabId)
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
            doc.write(sanitizeMailHtml(content.html_body))
            doc.close()
            resizeIframeToContent(ref)
            window.setTimeout(() => resizeIframeToContent(ref), 50)
            window.setTimeout(() => resizeIframeToContent(ref), 250)
            const images = Array.from(doc?.images || [])
            images.forEach((img) => {
                if (!img) return
                if (img.complete && img.naturalWidth > 0) return
                img.addEventListener('load', () => resizeIframeToContent(ref), { once: true })
                img.addEventListener('error', () => resizeIframeToContent(ref), { once: true })
            })
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
            if (downloadAsMenuRef.current && !downloadAsMenuRef.current.contains(e.target)) {
                setIsDownloadAsMenuOpen(false)
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
            if (isDownloadAsMenuOpen) {
                syncPopoverPosition(downloadAsMenuRef, setDownloadAsPopoverStyle, 240, 6, 'underAnchor')
            }
        }

        if (!isMoveMenuOpen && !isLabelMenuOpen && !isDownloadAsMenuOpen) {
            setMovePopoverStyle(null)
            setLabelPopoverStyle(null)
            setDownloadAsPopoverStyle(null)
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
    }, [activeRibbonTab, activeTabId, isDownloadAsMenuOpen, isLabelMenuOpen, isMoveMenuOpen, syncPopoverPosition])

    useEffect(() => {
        const handleKeyDown = (e) => {
            if (e.key === 'Escape') {
                if (mailItemMenu) {
                    closeMailItemMenu()
                    return
                }
                if (isFilterMenuOpen) {
                    setIsFilterMenuOpen(false)
                    return
                }
                if (isLabelMenuOpen) {
                    setIsLabelMenuOpen(false)
                    return
                }
                if (isMoveMenuOpen) {
                    setIsMoveMenuOpen(false)
                    return
                }
                if (isSelectionMenuOpen) {
                    setIsSelectionMenuOpen(false)
                    return
                }
                if (isSortMenuOpen) {
                    setIsSortMenuOpen(false)
                    return
                }
                if (selectMode) {
                    setSelectMode(false)
                    setSelectedMailIds(new Set())
                    return
                }
                if (selectedMail) {
                    setMailContent(null)
                    setSelectedMail(null)
                    return
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
        if (!selectedMail) return
        if (threadedEnabled) {
            if (!selectedThread?.id) return
            if (selectedThreadGlobalIndex < 0) return
            if (currentPage !== selectedThreadPage) setCurrentPage(selectedThreadPage)
            return
        }
        if (selectedGlobalIndex < 0) return
        if (currentPage !== selectedPage) setCurrentPage(selectedPage)
    }, [
        currentPage,
        selectedGlobalIndex,
        selectedMail,
        selectedPage,
        selectedThread?.id,
        selectedThreadGlobalIndex,
        selectedThreadPage,
        setCurrentPage,
        threadedEnabled,
    ])

    useEffect(() => {
        const handleMouseMove = (e) => {
            if (isResizingFolder.current) {

                const newWidth = Math.max(160, Math.min(500, e.clientX - appMenuLeftPad))
                setFolderWidth(newWidth)
            } else if (isResizingList.current) {
                const newWidth = Math.max(minListWidth, Math.min(900, e.clientX - appMenuLeftPad - folderWidth))
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
    }, [folderWidth, minListWidth, appMenuLeftPad])

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
            const currentIndex = pagedSelectableMails.findIndex(mail => mail.id === mailId)
            const lastIndex = pagedSelectableMails.findIndex(mail => mail.id === lastSelectedMailId)

            if (currentIndex !== -1 && lastIndex !== -1) {
                const startIndex = Math.min(currentIndex, lastIndex)
                const endIndex = Math.max(currentIndex, lastIndex)
                const rangeIds = pagedSelectableMails.slice(startIndex, endIndex + 1).map(mail => mail.id)

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

    const buildTree = useCallback((list, namespaceRoots = []) => {
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

        const sortFn = (a, b) => {
            let mailboxOrder = []
            let labelOrder = []
            try {
                if (accountForm.mailbox_order) mailboxOrder = JSON.parse(accountForm.mailbox_order)
            } catch {
                mailboxOrder = []
            }
            try {
                if (accountForm.label_order) labelOrder = JSON.parse(accountForm.label_order)
            } catch {
                labelOrder = []
            }

            const isLabel = isLabelMailbox(a.fullPath) || isLabelMailbox(b.fullPath)
            const currentOrder = isLabel ? labelOrder : mailboxOrder

            if (currentOrder.length > 0) {
                const ia = indexInOrderIgnoreCase(currentOrder, a.fullPath)
                const ib = indexInOrderIgnoreCase(currentOrder, b.fullPath)

                if (ia !== -1 && ib !== -1) return ia - ib
                if (ia !== -1) return -1
                if (ib !== -1) return 1
            }

            const pa = defaultMailboxSidebarPriority(a.name)
            const pb = defaultMailboxSidebarPriority(b.name)
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
    }, [accountForm])

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

    const renderFolderCountBadges = (fullPath) => {
        if (!mailboxCountDisplayMode || mailboxCountDisplayMode === 'none') return null
        const raw = mailboxCounts?.[fullPath]
        if (!raw || typeof raw !== 'object') return null
        const unread = Number(raw.unread) || 0
        const total = Number(raw.total) || 0
        const showUnread = mailboxCountDisplayMode === 'unread_only' || mailboxCountDisplayMode === 'both'
        const showTotal = mailboxCountDisplayMode === 'total_only' || mailboxCountDisplayMode === 'both'
        if (!showUnread && !showTotal) return null
        return (
            <span className="db-folder-counts">
                {showUnread && (
                    <span className="db-folder-count-pill db-folder-count-pill--unread" title="Unread">
                        {unread}
                    </span>
                )}
                {showTotal && (
                    <span className="db-folder-count-pill db-folder-count-pill--total" title="Total">
                        {total}
                    </span>
                )}
            </span>
        )
    }

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
                        <div className="db-folder-item-main">
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
                        {renderFolderCountBadges(node.fullPath)}
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

    const handleBlockSenderAction = async (mail, actionType) => {
        if (!mail) return
        const mailsToProcess = Array.isArray(mail) ? mail : [mail]
        const sender = mailsToProcess[0]?.address
        if (!sender) return
        
        let targetFolder = null
        if (actionType === 'Spam') targetFolder = resolveFolderDestination('Spam')
        else if (actionType === 'Trash') targetFolder = resolveFolderDestination('Trash')
        else if (actionType === 'Archive') targetFolder = resolveFolderDestination('Archive')
        else if (actionType === 'Folder') {
            if (!blockSenderSelectedFolder) {
                alert('Please select a folder')
                return
            }
            targetFolder = blockSenderSelectedFolder
        }

        const action = actionType === 'Delete' ? 'delete' : 'move'

        try {
            const res = await fetch(`/api/offline/${activeAccount?.account_id}/blocked-senders`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sender,
                    action_type: action,
                    target_folder: targetFolder,
                    apply_to_existing: blockSenderApplyExisting
                })
            })

            if (!res.ok) throw new Error('Failed to block sender')

            const idsToRemove = blockSenderApplyExisting 
                ? Array.isArray(mails) ? mails.filter(m => m.address?.toLowerCase() === sender.toLowerCase()).map(m => m.id) : []
                : mailsToProcess.map(m => m.id)

            if (idsToRemove.length > 0) {
                if (action === 'delete') {
                    await deleteMailsOptimistic(idsToRemove)
                } else {
                    await moveMailsOptimistic(idsToRemove, targetFolder)
                }
            }
            
            setBlockSenderModal(null)
        } catch (error) {
            console.error('Failed to block sender:', error)
            alert('Failed to block sender')
        }
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

    const composeReplyDraft = async (mailList, replyMode = 'reply') => {
        const replyMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (replyMails.length === 0) return

        if (replyMails.length > 1) {
            const sourceFolder = selectedFolder || 'INBOX'
            const targets = await Promise.all(replyMails.map(async (mail) => {
                const mailbox = mail?.mailbox || sourceFolder
                const content = await loadMailContentForDraft(mail)
                const seed = await fetchReplySeed(mail)
                const replyToCandidates = parseComposeRecipients(seed?.reply_to || '')
                const replyTo = replyToCandidates[0]
                    || content?.from_address
                    || mail.address
                    || ''
                return {
                    uid: mail.id,
                    mailbox,
                    subject: content?.subject || mail.subject || '',
                    address: replyTo,
                    recipientTo: mail?.recipient_to || '',
                    cc: content?.cc || '',
                    date: content?.date || mail.date || '',
                    messageId: seed?.message_id || '',
                    references: seed?.references || '',
                    quote: buildQuotedMailBlock(mail, content),
                }
            }))

            composeDraft({
                format: 'plain',
                plainBody: '',
                htmlBody: '',
                attachments: [],
                bulkReplyTargets: targets,
                bulkReplyOptions: { mode: replyMode === 'reply_all' ? 'reply_all' : 'reply', includeQuote: true },
            }, 'reply')
            return
        }

        const mail = replyMails[0]
        const content = await loadMailContentForDraft(mail)
        const seed = await fetchReplySeed(mail)

        const selfEmail = email || accountEmailLabel
        const replyToCandidates = parseComposeRecipients(seed?.reply_to || '')
        const replyToFallback = content?.from_address || mail.address || ''
        const replyTo = replyToCandidates[0] || replyToFallback
        const replyAllTo = dedupeEmails([
            ...(replyToCandidates.length > 0 ? replyToCandidates : [replyToFallback]),
            ...parseComposeRecipients(mail?.recipient_to || ''),
        ]).filter((addr) => addr.toLowerCase() !== (selfEmail || '').toLowerCase())
        const replyAllCc = dedupeEmails(parseComposeRecipients(content?.cc || '')).filter((addr) => (
            addr.toLowerCase() !== (selfEmail || '').toLowerCase()
            && !replyAllTo.some((existing) => existing.toLowerCase() === addr.toLowerCase())
        ))

        const headers = []
        if ((seed?.message_id || '').trim()) {
            headers.push({ name: 'In-Reply-To', value: seed.message_id.trim() })
            const refs = (seed?.references || '').trim()
            headers.push({ name: 'References', value: refs ? `${refs} ${seed.message_id.trim()}` : seed.message_id.trim() })
        }

        composeDraft({
            to: replyMode === 'reply_all' ? replyAllTo.join(', ') : replyTo,
            cc: replyMode === 'reply_all' ? replyAllCc.join(', ') : '',
            showCc: replyMode === 'reply_all' && replyAllCc.length > 0,
            subject: prefixSubject('Re:', content?.subject || mail.subject),
            plainBody: `\n\n${buildQuotedMailBlock(mail, content)}`,
            format: 'plain',
            htmlBody: '',
            extraHeaders: headers,
            replyContext: { uid: mail.id, mailbox: mail?.mailbox || selectedFolder || 'INBOX' },
        }, 'reply')
    }

    const composeForwardDraft = async (mailList) => {
        const forwardMails = Array.from(new Set((mailList || []).filter(Boolean)))
        if (forwardMails.length === 0) return
        const sourceFolder = selectedFolder || 'INBOX'
        const seenTargets = new Set()
        const forwardTargets = []
        forwardMails.forEach((mail) => {
            const uid = mail?.id
            const mailbox = mail?.mailbox || sourceFolder
            const key = `${uid || ''}@@${mailbox || ''}`
            if (!uid || !mailbox || seenTargets.has(key)) return
            seenTargets.add(key)
            const from = mail?.name
                ? `${mail.name} <${mail.address || ''}>`.trim()
                : `${mail?.address || ''}`.trim()
            forwardTargets.push({
                uid,
                mailbox,
                from,
                subject: mail?.subject || '',
                date: mail?.date || '',
            })
        })

        const count = forwardTargets.length
        const defaultOptions = count > 1
            ? { subjectPrefix: 'Fwd:', forwardStyle: 'eml', bundle: true }
            : { subjectPrefix: 'Fwd:', forwardStyle: 'copy', bundle: false }

        composeDraft({
            to: '',
            cc: '',
            bcc: '',
            subject: count > 1 ? `Fwd: ${count} emails` : '',
            plainBody: '',
            htmlBody: '',
            format: 'plain',
            attachments: [],
            forwardTargets,
            forwardOptions: defaultOptions,
        }, 'forward')
    }

    const handleReplyAction = async () => {
        if (!hasAnyActionMail) return
        await composeReplyDraft(actionableMails, 'reply')
    }

    const handleReplyAllAction = async () => {
        if (!hasAnyActionMail) return
        await composeReplyDraft(actionableMails, 'reply_all')
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
        const mailbox = activeTab?.mailbox || activeTabMail?.mailbox || selectedFolder || 'INBOX'
        await composeReplyDraft([{ ...activeTabMail, mailbox }], 'reply')
    }

    const handleActiveTabReplyAllAction = async () => {
        if (!activeTabMail) return
        const mailbox = activeTab?.mailbox || activeTabMail?.mailbox || selectedFolder || 'INBOX'
        await composeReplyDraft([{ ...activeTabMail, mailbox }], 'reply_all')
    }

    const handleActiveTabForwardAction = async () => {
        if (!activeTabMail) return
        const mailbox = activeTab?.mailbox || activeTabMail?.mailbox || selectedFolder || 'INBOX'
        await composeForwardDraft([{ ...activeTabMail, mailbox }])
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

    const activeFolderKey = selectedFolder || 'INBOX'
    const activeFolderInfo = folderInfo(activeFolderKey)
    const toolbarMainButtonContent = (iconNode, labelNode) => {
        const showIcon = safeToolbarStyle !== 'text_small'
        const showLabel = safeToolbarStyle !== 'icon_small' && safeToolbarStyle !== 'icon_large'
        return (
            <>
                {showIcon && <span className="db-submenu-main-btn__icon">{iconNode}</span>}
                {showLabel && <span className="db-submenu-main-btn__text">{labelNode}</span>}
            </>
        )
    }
    const tabsBarNode = (
            <div className="mail-tab-bar">
                <button
                    className={`mail-tab-item main-tab ${!activeTabId ? 'active' : ''}`}
                    onClick={() => setActiveTabId(null)}
                >
                    {activeFolderInfo.icon} {activeFolderInfo.label}
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
    )

    const toolsBarNode = (
        <div className="db-tools-bar">
            {!activeTabId && (
                <div className="db-main-menu">
                    <ul>
                        <li className={activeRibbonTab === 'home' ? 'active' : ''}>
                            <button onClick={() => setActiveRibbonTab('home')}>{t('Home')}</button>
                        </li>
                        <li className={activeRibbonTab === 'file' ? 'active' : ''}>
                            <button onClick={() => setActiveRibbonTab('file')}>{t('File')}</button>
                        </li>
                        <li className={activeRibbonTab === 'view' ? 'active' : ''}>
                            <button onClick={() => setActiveRibbonTab('view')}>{t('View')}</button>
                        </li>
                        <li className={activeRibbonTab === 'help' ? 'active' : ''}>
                            <button onClick={() => setActiveRibbonTab('help')}>{t('Help')}</button>
                        </li>
                    </ul>
                </div>
            )}
            <div className={`db-submenu db-submenu--${safeToolbarStyle}`}>
                <SubmenuBar
                    submenuScrollRef={submenuScrollRef}
                    submenuMoreRef={submenuMoreRef}
                    submenuVisibleCount={submenuVisibleCount}
                    setSubmenuVisibleCount={setSubmenuVisibleCount}
                >


                        {activeTabId ? (
                            activeComposeTab ? (
                                <ul>
                                    <li><button className="db-submenu-main-btn" disabled={!activeComposeTab} onClick={handleActiveComposeTabSend}>{toolbarMainButtonContent('📨', 'Send')}</button></li>
                                    <li><button className="db-submenu-main-btn" disabled={!activeComposeTab} onClick={handleActiveComposeTabDiscard}>{toolbarMainButtonContent(<img src="/img/icons/close.svg" className="svg-icon-inline" />, 'Discard')}</button></li>
                                    <li><button className="db-submenu-main-btn" disabled={!activeComposeTab} onClick={handleActiveComposeTabWindow}>{toolbarMainButtonContent(<img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" />, 'Open in Window')}</button></li>
                                </ul>
                            ) : (
                                activeTabMail?.isImported ? (
                                    <ul>
                                        <li>
                                            <button
                                                className="db-submenu-main-btn"
                                                type="button"
                                                disabled={!activeTabContent}
                                                onClick={() => openImportedMailInCompose(activeTabContent)}
                                            >
                                                {toolbarMainButtonContent(<img src="/img/icons/new-mail.svg" className="svg-icon-inline" />, t('Edit'))}
                                            </button>
                                        </li>
                                        <li>
                                            <button
                                                className="db-submenu-main-btn"
                                                type="button"
                                                onClick={() => closeTab({ stopPropagation: () => { } }, activeTabId)}
                                            >
                                                {toolbarMainButtonContent(<img src="/img/icons/close.svg" className="svg-icon-inline" />, t('Close'))}
                                            </button>
                                        </li>
                                    </ul>
                                ) : (
                                    <ul>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabDeleteAction}>{toolbarMainButtonContent(<img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" />, t('Delete'))}</button></li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabMoveToTrashAction}>{toolbarMainButtonContent(<img src="/img/icons/move-to-folder.svg" className="svg-icon-inline" />, t('Move to Trash'))}</button></li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabArchiveAction}>{toolbarMainButtonContent(<img src="/img/icons/archive.svg" className="svg-icon-inline" />, t('Archive'))}</button></li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabReplyAction}>{toolbarMainButtonContent(<img src="/img/icons/reply.svg" className="svg-icon-inline" />, 'Reply')}</button></li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabReplyAllAction}>{toolbarMainButtonContent(<img src="/img/icons/reply-all.svg" className="svg-icon-inline" />, 'Reply All')}</button></li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabForwardAction}>{toolbarMainButtonContent(<img src="/img/icons/forward.svg" className="svg-icon-inline" />, 'Forward')}</button></li>
                                        <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                                            <button
                                                disabled={!activeTabMail}
                                                title={activeTabMail ? undefined : 'Open a mail first'}
                                                className={`db-submenu-main-btn ${isMoveMenuOpen ? 'submenu-open' : ''}`.trim()}
                                                onClick={() => {
                                                    setIsLabelMenuOpen(false)
                                                    setIsMoveMenuOpen((prev) => !prev)
                                                }}
                                            >
                                                {toolbarMainButtonContent(<img src="/img/icons/folder.svg" className="svg-icon-inline" />, t('Move'))}
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
                                                className={`db-submenu-main-btn ${isLabelMenuOpen ? 'submenu-open' : ''}`.trim()}
                                                onClick={() => {
                                                    setIsMoveMenuOpen(false)
                                                    setIsLabelMenuOpen((prev) => !prev)
                                                }}
                                            >
                                                {toolbarMainButtonContent(<img src="/img/icons/label.svg" className="svg-icon-inline" />, 'Labels')}
                                            </button>
                                            {isLabelMenuOpen && renderLabelChecklist(
                                                activeTabMail ? [activeTabMail] : [],
                                                handleActiveTabLabelToggleAction,
                                                handleActiveTabCreateLabelAction,
                                                { style: labelPopoverStyle || undefined },
                                            )}
                                        </li>
                                        <li><button className="db-submenu-main-btn" disabled={!activeTabMail} onClick={handleActiveTabReadToggleAction}>{toolbarMainButtonContent(<img src="/img/icons/read.svg" className="svg-icon-inline" />, activeTabReadLabel)}</button></li>
                                    </ul>
                                )
                            )
                        ) : activeRibbonTab === 'home' && (
                            <ul>
                                <li><button className="db-submenu-main-btn" onClick={handleNewMail}>{toolbarMainButtonContent(<img src="/img/icons/new-mail.svg" className="svg-icon-inline" />, t('New Mail'))}</button></li>
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleDeleteAction}>{toolbarMainButtonContent(<img src="/img/icons/recycle-bin.svg" className="svg-icon-inline" />, t('Delete'))}</button></li>
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleMoveToTrashAction}>{toolbarMainButtonContent(<img src="/img/icons/move-to-folder.svg" className="svg-icon-inline" />, t('Move to Trash'))}</button></li>
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleArchiveAction}>{toolbarMainButtonContent(<img src="/img/icons/archive.svg" className="svg-icon-inline" />, t('Archive'))}</button></li>
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleReplyAction}>{toolbarMainButtonContent(hasMultipleActionMails ? <img src="/img/icons/reply-all.svg" className="svg-icon-inline" /> : <img src="/img/icons/reply.svg" className="svg-icon-inline" />, homeReplyLabel)}</button></li>
                                {!hasMultipleActionMails && (
                                    <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleReplyAllAction}>{toolbarMainButtonContent(<img src="/img/icons/reply-all.svg" className="svg-icon-inline" />, 'Reply All')}</button></li>
                                )}
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleForwardAction}>{toolbarMainButtonContent(hasMultipleActionMails ? <img src="/img/icons/forward-all.svg" className="svg-icon-inline" /> : <img src="/img/icons/forward.svg" className="svg-icon-inline" />, homeForwardLabel)}</button></li>
                                <li className="db-submenu-menu-wrap" ref={moveMenuRef}>
                                    <button
                                        disabled={!hasAnyActionMail}
                                        title={selectionRequiredTitle}
                                        className={`db-submenu-main-btn ${isMoveMenuOpen ? 'submenu-open' : ''}`.trim()}
                                        onClick={() => {
                                            setIsLabelMenuOpen(false)
                                            setIsMoveMenuOpen((prev) => !prev)
                                        }}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/folder.svg" className="svg-icon-inline" />, t('Move'))}
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
                                        className={`db-submenu-main-btn ${isLabelMenuOpen ? 'submenu-open' : ''}`.trim()}
                                        onClick={() => {
                                            setIsMoveMenuOpen(false)
                                            setIsLabelMenuOpen((prev) => !prev)
                                        }}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/label.svg" className="svg-icon-inline" />, 'Labels')}
                                    </button>
                                    {isLabelMenuOpen && renderLabelChecklist(
                                        actionableMails,
                                        handleLabelToggleAction,
                                        handleCreateLabelAction,
                                        { style: labelPopoverStyle || undefined },
                                    )}
                                </li>
                                <li><button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={handleReadToggleAction}>{toolbarMainButtonContent(<img src="/img/icons/read.svg" className="svg-icon-inline" />, readToggleLabel)}</button></li>
                                <li>
                                    <button className="db-submenu-main-btn" disabled={!hasAnyActionMail} onClick={() => setBlockSenderModal(actionableMails)}>
                                        {toolbarMainButtonContent(<img src="/img/icons/close.svg" className="svg-icon-inline" />, 'Block Sender')}
                                    </button>
                                </li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'file' && (
                            <ul>
                                <li>
                                    <button className="db-submenu-main-btn" type="button" onClick={handleOpenImportPicker}>
                                        {toolbarMainButtonContent(<img src="/img/icons/plus.svg" className="svg-icon-inline" />, importLoading ? 'Importing...' : t('Import'))}
                                    </button>
                                    <input
                                        ref={importFileInputRef}
                                        type="file"
                                        accept=".eml,.msg"
                                        style={{ display: 'none' }}
                                        onChange={handleImportFilePicked}
                                    />
                                </li>
                                <li className="db-submenu-menu-wrap" ref={downloadAsMenuRef}>
                                    <button
                                        type="button"
                                        disabled={fileActionsDisabled}
                                        className={`db-submenu-main-btn ${isDownloadAsMenuOpen ? 'submenu-open' : ''}`.trim()}
                                        onClick={() => {
                                            setIsMoveMenuOpen(false)
                                            setIsLabelMenuOpen(false)
                                            setIsDownloadAsMenuOpen((prev) => !prev)
                                        }}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/save.svg" className="svg-icon-inline" />, t('Download as'))}
                                    </button>
                                    {isDownloadAsMenuOpen && (
                                        <div
                                            className="db-submenu-popover"
                                            style={downloadAsPopoverStyle || undefined}
                                            onWheel={(e) => e.stopPropagation()}
                                        >
                                            <button
                                                type="button"
                                                disabled={fileActionsDisabled}
                                                className="db-submenu-popover__item"
                                                onClick={handleDownloadHtml}
                                            >
                                                <img src="/img/icons/save.svg" className="svg-icon-inline" /> {fileActionLoading === 'html' ? 'Saving HTML...' : 'HTML'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={fileActionsDisabled}
                                                className="db-submenu-popover__item"
                                                onClick={handleDownloadMsg}
                                            >
                                                <img src="/img/icons/mail.svg" className="svg-icon-inline" /> {fileActionLoading === 'msg' ? 'Saving MSG...' : 'MSG'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={fileActionsDisabled}
                                                className="db-submenu-popover__item"
                                                onClick={handleDownloadEml}
                                            >
                                                <img src="/img/icons/mail.svg" className="svg-icon-inline" /> {fileActionLoading === 'eml' ? 'Saving EML...' : 'EML'}
                                            </button>
                                            <button
                                                type="button"
                                                disabled={fileActionsDisabled}
                                                className="db-submenu-popover__item"
                                                onClick={handleDownloadPdf}
                                            >
                                                <img src="/img/icons/all-mails.svg" className="svg-icon-inline" /> {fileActionLoading === 'pdf' ? 'Saving PDF...' : 'PDF'}
                                            </button>
                                        </div>
                                    )}
                                </li>
                                <li>
                                    <button className="db-submenu-main-btn" disabled={fileActionsDisabled} onClick={handlePrintMail}>
                                        {toolbarMainButtonContent(<img src="/img/icons/print.svg" className="svg-icon-inline" />, fileActionLoading === 'print' ? 'Preparing print...' : 'Print')}
                                    </button>
                                </li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'help' && (
                            <ul>
                                <li><button className="db-submenu-main-btn" onClick={() => alert('Help clicked')}>{toolbarMainButtonContent(<img src="/img/icons/settings.svg" className="svg-icon-inline" />, t('Help'))}</button></li>
                                <li><button className="db-submenu-main-btn" onClick={() => alert('Contact Us clicked')}>{toolbarMainButtonContent(<img src="/img/icons/mail.svg" className="svg-icon-inline" />, t('Contact Us'))}</button></li>
                                <li><button className="db-submenu-main-btn" onClick={() => alert('Feedback clicked')}>{toolbarMainButtonContent(<img src="/img/icons/new-mail.svg" className="svg-icon-inline" />, t('Feedback'))}</button></li>
                                <li><button className="db-submenu-main-btn" onClick={() => alert('Report Bug clicked')}>{toolbarMainButtonContent(<img src="/img/icons/notification.svg" className="svg-icon-inline" />, t('Report Bug'))}</button></li>
                            </ul>
                        )}
                        {!activeTabId && activeRibbonTab === 'view' && (
                            <ul>
                                <li>
                                    <button
                                        type="button"
                                        className={`db-submenu-main-btn db-view-toggle ${appMenuVisible ? 'active' : ''}`}
                                        onClick={() => setAppMenuVisible((v) => !v)}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/more-choice.svg" className="svg-icon-inline" />, t('App menu'))}
                                    </button>
                                </li>
                                <li>
                                    <button
                                        type="button"
                                        className={`db-submenu-main-btn db-view-toggle ${!foldersHidden ? 'active' : ''}`}
                                        onClick={() => {
                                            if (foldersHidden) {
                                                userClosedFolders.current = false
                                                setFoldersHidden(false)
                                            } else {
                                                userClosedFolders.current = true
                                                setFoldersHidden(true)
                                                setOverlayPanel((p) => (p === 'folders' ? null : p))
                                            }
                                        }}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/folder.svg" className="svg-icon-inline" />, t('Mailboxes'))}
                                    </button>
                                </li>
                                <li>
                                    <button
                                        type="button"
                                        className={`db-submenu-main-btn db-view-toggle ${!mailsHidden ? 'active' : ''}`}
                                        onClick={() => {
                                            if (mailsHidden) {
                                                userClosedMails.current = false
                                                setMailsHidden(false)
                                                setOverlayPanel((p) => (p === 'mails' ? null : p))
                                            } else {
                                                userClosedMails.current = true
                                                setMailsHidden(true)
                                                if (layoutMode === 'narrow') {
                                                    setOverlayPanel((p) => (p === 'mails' ? null : p))
                                                }
                                            }
                                        }}
                                    >
                                        {toolbarMainButtonContent(<img src="/img/icons/mail.svg" className="svg-icon-inline" />, t('Mail list'))}
                                    </button>
                                </li>
                            </ul>
                        )}
                </SubmenuBar>
            </div>
        </div>
    )

    const centerPlaneTabNode = activeTabId ? (
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
                            showTopDiscard={false}
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
                                        sandbox="allow-same-origin allow-scripts"
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
                                                {at.data_base64 || activeTabMail?.isImported ? (
                                                    <button
                                                        type="button"
                                                        className="db-attachments__link"
                                                        onClick={() => downloadAttachmentFromBase64(at)}
                                                    >
                                                        Download
                                                    </button>
                                                ) : (
                                                    <a
                                                        className="db-attachments__link"
                                                        href={attachmentUrl(accountId, activeTabContent.id, at.id, activeTab.mailbox, canUseRemoteMail)}
                                                        download={at.filename}
                                                    >Download</a>
                                                )}
                                            </li>
                                        ))}
                                    </ul>
                                </div>
                            )}
                        </div>
                    ) : null}
                </div>
    ) : null;

    const backdropNode = overlayPanel ? (
                        <div
                            className="db-panel-backdrop"
                            onClick={() => setOverlayPanel(null)}
                        />
    ) : null;

	    const foldedTabsNode = (
	                    <div className={`db-dock-tabs ${isMailboxesRight ? 'db-dock-tabs--right' : 'db-dock-tabs--left'}`}>
	                        {foldersHidden && (
	                            <CollapsedTab
	                                label={t('Mailboxes')}
	                                title={t('Show mailboxes')}
	                                onClick={() => {
	                                    // Medium/narrow: use overlay so mail content isn't compressed. Full: restore docked panel.
	                                    if (layoutMode === 'full') {
	                                        userClosedFolders.current = false
	                                        setOverlayPanel(null)
	                                        setFoldersHidden(false)
	                                    } else {
	                                        setOverlayPanel(prev => prev === 'folders' ? null : 'folders')
	                                    }
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
    )

    const mailboxesBarNode = (
        <React.Fragment>
                    {!foldersHidden && (
                        <>
                            {isMailboxesRight && layoutMode !== 'narrow' && (
                                <div
                                    className="db-resizer"
                                    onMouseDown={() => { isResizingFolder.current = true; document.body.classList.add('resizing') }}
                                    title="Resize mailboxes"
                                />
                            )}
                            <div className={`db-folder-panel${isMailboxesRight ? ' db-folder-panel--right' : ''}`} style={{ width: folderWidth }}>
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
                            {!isMailboxesRight && layoutMode !== 'narrow' && (
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
                        <div className={`db-folder-panel db-folder-panel--overlay${isMailboxesRight ? ' db-folder-panel--right' : ''}`} style={{ width: folderWidth }}>
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
        </React.Fragment>
    )

    const maillistBarNode = (
        <React.Fragment>
                        {(!mailsHidden || (layoutMode === 'narrow' && overlayPanel === 'mails')) && (
                            <>
                                {isMaillistRight && !isMailFullscreen && !mailsHidden && layoutMode !== 'narrow' && (
                                    <div
                                        className="db-resizer"
                                        onMouseDown={() => { isResizingList.current = true; document.body.classList.add('resizing') }}
                                        title="Resize mails"
                                    />
                                )}
                                <div
                                    className={`db-center-panel${layoutMode === 'narrow' && mailsHidden && overlayPanel === 'mails' ? ' db-center-panel--overlay' : ''}${isMaillistRight ? ' db-center-panel--right' : ''}`}
                                    style={
                                        isMailFullscreen
                                            ? { flex: 1, width: 'auto' }
                                            : { width: Math.max(listWidth, minListWidth), '--db-list-min': `${minListWidth}px` }
                                    }
                                >
                                    <div className={`db-mail-toolbar${isMaillistRight ? ' db-mail-toolbar--mirrored' : ''}`} ref={mailToolbarRef}>
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
                                            {threadedEnabled ? (
                                                pagedVisibleThreads.map((thread) => {
                                                    const mailsInThread = Array.isArray(thread?.mails) ? thread.mails : []
                                                    const mailIds = Array.isArray(thread?.mail_ids)
                                                        ? thread.mail_ids
                                                        : mailsInThread.map((m) => String(m?.id ?? '')).filter(Boolean)

                                                    const selectedCount = mailIds.reduce(
                                                        (acc, id) => acc + (selectedMailIds.has(id) ? 1 : 0),
                                                        0,
                                                    )
                                                    const allSelected = mailIds.length > 0 && selectedCount === mailIds.length
                                                    const anySelected = selectedCount > 0
                                                    const isExpanded = expandedThreadIds.has(thread.id)
                                                    const isUnread = (thread?.unread_count || 0) > 0
                                                    const latestMail = mailsInThread.length > 0 ? mailsInThread[mailsInThread.length - 1] : null
                                                    const isThread = mailsInThread.length > 1
                                                    const childMails = isThread ? mailsInThread.slice().reverse() : []
                                                    const isAnchorSelected = !!(latestMail && selectedMail?.id === latestMail.id)
                                                    const threadSender = latestMail?.name || latestMail?.address || thread?.latest_from || 'Unknown'
                                                    const threadTime = getShortTime(latestMail?.date || thread?.latest_date || '')
                                                    const threadSubject = latestMail?.subject || thread?.subject_display || '(No Subject)'
                                                    const mailLabels = latestMail ? getMailLabels(latestMail) : []
                                                    const visibleMailLabels = mailLabels.slice(0, 2)
                                                    const remainingMailLabelCount = Math.max(0, mailLabels.length - visibleMailLabels.length)

                                                    const toggleThreadSelection = (event) => {
                                                        event.stopPropagation()
                                                        setSelectMode(true)
                                                        setSelectedMailIds((prev) => {
                                                            const next = new Set(prev)
                                                            const currentlyAll = mailIds.every((id) => next.has(id))
                                                            if (currentlyAll) mailIds.forEach((id) => next.delete(id))
                                                            else mailIds.forEach((id) => next.add(id))
                                                            return next
                                                        })
                                                        if (latestMail?.id) setLastSelectedMailId(latestMail.id)
                                                    }

                                                    const handleThreadMarkReadToggle = async (event) => {
                                                        event.stopPropagation()
                                                        if (mailIds.length === 0) return
                                                        await setMailsSeenState(mailIds, isUnread)
                                                    }

                                                    const handleThreadArchive = async (event) => {
                                                        event.stopPropagation()
                                                        if (mailIds.length === 0) return
                                                        await moveMailsOptimistic(mailIds, resolveFolderDestination('Archive'))
                                                    }

                                                    const handleThreadTrash = async (event) => {
                                                        event.stopPropagation()
                                                        if (mailIds.length === 0) return
                                                        await moveMailsOptimistic(mailIds, resolveFolderDestination('Trash'))
                                                    }

                                                    const handleThreadDelete = async (event) => {
                                                        event.stopPropagation()
                                                        if (mailIds.length === 0) return
                                                        await deleteMailsOptimistic(mailIds)
                                                    }

                                                    return (
                                                        <React.Fragment key={thread.id}>
                                                            <li
                                                                className={`db-mail-item ${isUnread ? 'unread' : ''} ${isAnchorSelected ? 'selected' : ''} ${selectMode ? 'select-mode' : ''} ${allSelected ? 'checked' : ''} ${anySelected && !allSelected ? 'partial' : ''}`}
                                                                onClick={async () => {
                                                                    if (isDraggingRef.current) return
                                                                    if (isThread) {
                                                                        setExpandedThreadIds((prev) => {
                                                                            const next = new Set(prev)
                                                                            next.add(thread.id)
                                                                            return next
                                                                        })
                                                                    }
                                                                    if (!latestMail) return
                                                                    if (isThread) {
                                                                        setActiveThreadReaderId(thread.id)
                                                                        await attemptSelectMailPreview(latestMail)
                                                                    } else {
                                                                        setActiveThreadReaderId(null)
                                                                        await attemptOpenMail(latestMail)
                                                                    }
                                                                }}
                                                                draggable
                                                                onDragStart={(event) => latestMail && handleMailDragStart(event, latestMail)}
                                                                onDragEnd={handleMailDragEnd}
                                                            >
                                                                {isThread && (
                                                                    <button
                                                                        type="button"
                                                                        className={`db-thread-expander ${isExpanded ? 'expanded' : ''}`}
                                                                        onClick={(event) => {
                                                                            event.stopPropagation()
                                                                            setExpandedThreadIds((prev) => {
                                                                                const next = new Set(prev)
                                                                                if (next.has(thread.id)) next.delete(thread.id)
                                                                                else next.add(thread.id)
                                                                                return next
                                                                            })
                                                                        }}
                                                                        aria-label={isExpanded ? 'Collapse thread' : 'Expand thread'}
                                                                        aria-pressed={isExpanded}
                                                                        title={isExpanded ? 'Collapse thread' : 'Expand thread'}
                                                                    >
                                                                        <img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline" />
                                                                    </button>
                                                                )}
                                                                <div className="db-mail-avatar-wrap">
                                                                    <Avatar
                                                                        email={latestMail?.address || ''}
                                                                        name={latestMail?.name || threadSender}
                                                                        accountId={accountId}
                                                                        size={36}
                                                                        className="db-mail-avatar"
                                                                    />
                                                                    <button
                                                                        type="button"
                                                                        className={`db-mail-avatar-toggle ${selectMode ? 'visible' : ''} ${allSelected ? 'checked' : ''} ${anySelected && !allSelected ? 'partial' : ''}`}
                                                                        onClick={toggleThreadSelection}
                                                                        aria-pressed={allSelected}
                                                                        aria-label={allSelected ? 'Unselect conversation' : 'Select conversation'}
                                                                        title={selectMode ? 'Select conversation' : 'Enter selection mode'}
                                                                    >
                                                                        <img src="/img/icons/choice-choosen.svg" className="svg-icon-inline db-mail-avatar-toggle__icon" />
                                                                    </button>
                                                                </div>
	                                                                <div className="db-mail-item-content">
	                                                                    <div className="db-mail-item-head">
	                                                                        <span className="db-mail-sender">{threadSender}</span>
	                                                                        <span className="db-mail-time">{threadTime}</span>
	                                                                    </div>
	                                                                    <span className="db-mail-subject">{threadSubject}</span>
	                                                                    {mailLabels.length > 0 && (
	                                                                        <div className="db-mail-labels" title={mailLabels.join(', ')}>
	                                                                            {visibleMailLabels.map((label) => (
	                                                                                <span key={`${thread.id}-${label}`} className="db-mail-label-chip">
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
	                                                                {latestMail && (
	                                                                    <div className="db-mail-hover-actions">
	                                                                        <button
	                                                                            type="button"
	                                                                            className="db-mail-hover-action-btn"
	                                                                            title="More actions"
	                                                                            onClick={(event) => openMailItemMenuFromButton(event, latestMail)}
	                                                                        >
	                                                                            <img src="/img/icons/three-point.svg" className="svg-icon-inline" />
	                                                                        </button>
	                                                                    </div>
	                                                                )}
	                                                            </li>
	                                                            {isExpanded && childMails.map((mail) => {
	                                                                const isChecked = selectedMailIds.has(mail.id)
	                                                                return (
                                                                    <li
                                                                        key={`${thread.id}-${mail.id}`}
                                                                        className={`db-mail-item db-mail-item--thread-child ${mail.seen !== true ? 'unread' : ''} ${selectedMail?.id === mail.id ? 'selected' : ''} ${selectMode ? 'select-mode' : ''} ${isChecked ? 'checked' : ''}`}
                                                                        onClick={() => {
                                                                            if (isDraggingRef.current) return
                                                                            setActiveThreadReaderId(null)
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
                                                                                size={28}
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
	                                                                        </div>
	                                                                        <div className="db-mail-hover-actions">
	                                                                            <button
	                                                                                type="button"
	                                                                                className="db-mail-hover-action-btn"
	                                                                                title="More actions"
	                                                                                onClick={(event) => openMailItemMenuFromButton(event, mail)}
	                                                                            >
	                                                                                <img src="/img/icons/three-point.svg" className="svg-icon-inline" />
	                                                                            </button>
	                                                                        </div>
	                                                                    </li>
	                                                                )
	                                                            })}
	                                                        </React.Fragment>
                                                    )
                                                })
                                            ) : (
                                                pagedVisibleMails.map((mail) => {
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
                                                                    size={36}
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
	                                                            <div className="db-mail-hover-actions">
	                                                                <button
	                                                                    type="button"
	                                                                    className="db-mail-hover-action-btn"
	                                                                    title="More actions"
	                                                                    onClick={(event) => openMailItemMenuFromButton(event, mail)}
	                                                                >
	                                                                    <img src="/img/icons/three-point.svg" className="svg-icon-inline" />
	                                                                </button>
	                                                            </div>
	                                                        </li>
	                                                    )
	                                                })
	                                            )}
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
	                                                        className="db-submenu-popover__item"
	                                                        onClick={async () => {
	                                                            if (!mailItemMenuMail) return
	                                                            closeMailItemMenu()
	                                                            await openMailInTab(mailItemMenuMail)
	                                                        }}
	                                                    >
	                                                        <img src="/img/icons/open-in-new-tab.svg" className="svg-icon-inline" /> Open in new tab
	                                                    </button>
	                                                    <button
	                                                        type="button"
	                                                        className="db-submenu-popover__item"
	                                                        onClick={async () => {
	                                                            if (!mailItemMenuMail) return
	                                                            closeMailItemMenu()
	                                                            await detachMailToWindowFromList({ stopPropagation: () => {} }, mailItemMenuMail)
	                                                        }}
	                                                    >
	                                                        <img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" /> Open in new window
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
                                                    <button 
                                                        type="button" 
                                                        className="db-submenu-popover__item" 
                                                        onClick={() => {
                                                            setBlockSenderModal([mailItemMenuMail])
                                                            closeMailItemMenu()
                                                        }}
                                                    >
                                                        <img src="/img/icons/close.svg" className="svg-icon-inline" /> Block Sender
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

                                {!isMaillistRight && !isMailFullscreen && !mailsHidden && (
                                    <div
                                        className="db-resizer"
                                        onMouseDown={() => { isResizingList.current = true; document.body.classList.add('resizing') }}
                                        title="Resize mails"
                                    />
                                )}
                            </>
                        )}
        </React.Fragment>
    )

    const centerPlanePanelNode = (
        <React.Fragment>
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
                                        showTopDiscard={false}
                                    />
                                ) : importPreview ? (
                                    <div className="db-mail-content">
                                        <div className="db-mail-content-header">
                                            <div className="db-mail-content-subject">
                                                {importPreview?.content?.subject || importPreview?.mail?.subject || importPreview?.fileName || '(Imported mail)'}
                                            </div>
                                            <div className="db-mail-content-actions">
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => openImportedMailInTab(importPreview.mail, importPreview.content)}
                                                    title={t('Move to tab')}
                                                >
                                                    <img src="/img/icons/open-in-new-tab.svg" className="svg-icon-inline" />
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => detachImportedMailToWindow(importPreview.mail, importPreview.content)}
                                                    title={t('Move to window')}
                                                >
                                                    <img src="/img/icons/open-in-new-window.svg" className="svg-icon-inline" />
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => {
                                                        openImportedMailInCompose(importPreview.content)
                                                        setImportPreview(null)
                                                    }}
                                                    title={t('Edit')}
                                                >
                                                    <img src="/img/icons/new-mail.svg" className="svg-icon-inline" />
                                                </button>
                                                <button
                                                    className="db-mail-action-btn"
                                                    onClick={() => setImportPreview(null)}
                                                    title={t('Close')}
                                                >
                                                    <img src="/img/icons/close.svg" className="svg-icon-inline" />
                                                </button>
                                            </div>
                                        </div>
                                        <div className="db-mail-meta">
                                            <strong>From:</strong>{' '}
                                            {importPreview?.content?.from_name
                                                ? `${importPreview.content.from_name} <${importPreview.content.from_address}>`
                                                : (importPreview?.mail?.address || '')}
                                        </div>
                                        {!!(importPreview?.content?.cc || '').trim() && <div className="db-mail-meta"><strong>CC:</strong> {importPreview.content.cc}</div>}
                                        {!!(importPreview?.content?.bcc || '').trim() && <div className="db-mail-meta"><strong>BCC:</strong> {importPreview.content.bcc}</div>}
                                        <div className="db-mail-meta"><strong>Date:</strong> {formatMailDateLong(importPreview?.content?.date || importPreview?.mail?.date)}</div>
                                        {!!importError && (
                                            <div className="db-mail-meta" style={{ color: '#c0392b' }}>
                                                {importError}
                                            </div>
                                        )}
                                        <hr className="db-mail-divider" />
	                                        {importPreview?.content?.html_body ? (
	                                            <div className="db-mail-body-html">
	                                                <ResizableHtmlIframe title="imported-mail-content" html={importPreview.content.html_body} onLinkClick={onExternalLink} />
	                                            </div>
	                                        ) : (
	                                            <div className="db-mail-body">{importPreview?.content?.plain_body || '(No content)'}</div>
	                                        )}
                                        {importPreview?.content?.attachments?.length > 0 && (
                                            <div className="db-attachments">
                                                <div className="db-attachments__header">Attachments ({importPreview.content.attachments.length})</div>
                                                <ul className="db-attachments__list">
                                                    {importPreview.content.attachments.map((at) => (
                                                        <li key={at.id} className="db-attachments__item">
                                                            <div className="db-attachments__info">
                                                                <span className="db-attachments__name">{at.filename}</span>
                                                                <span className="db-attachments__meta">{at.content_type} · {formatBytes(at.size)}</span>
                                                            </div>
                                                            {at.data_base64 ? (
                                                                <button
                                                                    type="button"
                                                                    className="db-attachments__link"
                                                                    onClick={() => downloadAttachmentFromBase64(at)}
                                                                >
                                                                    Download
                                                                </button>
                                                            ) : null}
                                                        </li>
                                                    ))}
                                                </ul>
                                            </div>
                                        )}
                                    </div>
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
	                                            <div className="db-mail-content-subject">
	                                                {(showThreadReader && selectedThread)
	                                                    ? (selectedThread.subject_display || '(No Subject)')
	                                                    : (mailContent?.subject || selectedMail.subject || '(No Subject)')}
	                                            </div>
	                                        </div>
	                                        {showThreadReader && selectedThread ? (
	                                            <div className="db-thread-reader" aria-label="Conversation">
	                                                {(selectedThread.mails || []).slice().reverse().map((m) => {
	                                                    const id = String(m?.id ?? '')
	                                                    const isOpen = threadReaderOpenIds.has(id)
	                                                    const isLoading = threadReaderLoadingIds.has(id)
	                                                    const content = threadReaderContentByIdSafe?.[id] || null
	                                                    const fromLabel = (content?.from_name || '').trim()
	                                                        ? `${content.from_name} <${content.from_address}>`
	                                                        : (m?.name ? `${m.name} <${m.address || ''}>`.trim() : (m?.address || 'Unknown'))
                                                    const dateLabel = formatMailDateLong(content?.date || m?.date || '')
                                                    const previewTo = (m?.recipient_to || '').trim()
                                                    return (
                                                        <div key={`thread-mail-${selectedThread.id}-${id}`} className={`db-thread-reader-mail ${isOpen ? 'open' : 'collapsed'}`}>
                                                            <button
                                                                type="button"
                                                                className="db-thread-reader-header"
                                                                onClick={() => toggleThreadReaderMail(m)}
                                                                aria-expanded={isOpen}
                                                            >
                                                                <div className="db-thread-reader-head-left">
                                                                    <div className="db-thread-reader-from">{fromLabel || 'Unknown'}</div>
                                                                    {!!previewTo && (
                                                                        <div className="db-thread-reader-to">
                                                                            To: {previewTo}
                                                                        </div>
                                                                    )}
                                                                </div>
                                                                <div className="db-thread-reader-head-right">
                                                                    <div className="db-thread-reader-date">{dateLabel}</div>
                                                                    <img src="/img/icons/arrow-no-tail.svg" className="svg-icon-inline db-thread-reader-caret" />
                                                                </div>
                                                            </button>
                                                            {isOpen && (
                                                                <div className="db-thread-reader-body">
                                                                    {isLoading && !content ? (
                                                                        <div className="db-thread-reader-loading">Loading...</div>
                                                                    ) : content?.html_body ? (
                                                                        <div className="db-mail-body-html">
                                                                            <ResizableHtmlIframe title={`mail-content-${id}`} html={content.html_body} onLinkClick={onExternalLink} />
                                                                        </div>
                                                                    ) : (
                                                                        <div className="db-mail-body">{content?.plain_body || '(No content)'}</div>
                                                                    )}
                                                                </div>
                                                            )}
                                                        </div>
                                                    )
                                                })}
                                            </div>
                                        ) : (
                                            <>
                                                <div className="db-mail-meta"><strong>From:</strong> {mailContent?.from_name ? `${mailContent.from_name} <${mailContent.from_address}>` : selectedMail.address}</div>
                                                {!!(mailContent?.cc || '').trim() && <div className="db-mail-meta"><strong>CC:</strong> {mailContent.cc}</div>}
                                                {!!(mailContent?.bcc || '').trim() && <div className="db-mail-meta"><strong>BCC:</strong> {mailContent.bcc}</div>}
                                                <div className="db-mail-meta"><strong>Date:</strong> {formatMailDateLong(mailContent?.date || selectedMail.date)}</div>
                                                <hr className="db-mail-divider" />
                                                {mailContent?.html_body ? (
                                                    <div className="db-mail-body-html"><iframe ref={iframeRef} title="mail-content" sandbox="allow-same-origin allow-scripts" /></div>
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
                                            </>
                                        )}
                                    </div>
                                )}
                            </div>
                        )}
        </React.Fragment>
    )

    const finalCenterPlane = (
        <React.Fragment>
            {backdropNode}
            {activeTabId ? centerPlaneTabNode : centerPlanePanelNode}
        </React.Fragment>
    );

    return (
        <React.Fragment>
            <LayoutFrame region={mainBarRegion} bar={injectedMainBar}>
                <LayoutFrame region={appsBarRegion} bar={injectedAppsBar}>
                    <MailDynamicLayout
                        layoutMode={layoutMode}
                        layoutData={innerLayoutData}
                        mailboxesBar={activeTabId ? null : (isMailboxesRight ? <>{mailboxesBarNode}{foldedTabsNode}</> : <>{foldedTabsNode}{mailboxesBarNode}</>)}
                        maillistBar={activeTabId ? null : maillistBarNode}
                        tabsBar={tabsBarNode}
                        toolsBar={toolsBarNode}
                        centerPlane={finalCenterPlane}
                        hideCenterPlane={isMailFullscreen && !activeTabId}
                    />
                </LayoutFrame>
            </LayoutFrame>
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
                            <div className="db-compose-exit-panel__title">Unsaved Changes</div>
                        </div>
                        <div className="db-compose-exit-panel__body">
                            This message has unsaved changes. Do you want to save it to drafts or discard?
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
                                className="db-advanced-search-btn db-compose-exit-panel__btn db-compose-exit-panel__btn--save"
                                onClick={() => handleComposeExitAction('save')}
                                disabled={composeActionBusy}
                            >
                                {composeActionBusy ? 'Working...' : 'Save to Drafts'}
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
                                Continue Editing
                            </button>
                        </div>
                    </div>
                </div>
            )}
            {blockSenderModal && (
                <div className="db-advanced-search-modal" onMouseDown={() => setBlockSenderModal(null)}>
                    <div
                        className="db-compose-exit-panel"
                        onMouseDown={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        style={{ minWidth: '400px' }}
                    >
                        <div className="db-compose-exit-panel__header">
                            <div className="db-compose-exit-panel__title">Block Sender</div>
                            <button type="button" className="db-advanced-search-panel__close" onClick={() => setBlockSenderModal(null)}>
                                <img src="/img/icons/close.svg" className="svg-icon-inline" />
                            </button>
                        </div>
                        <div className="db-compose-exit-panel__body" style={{ paddingBottom: '8px' }}>
                            <p style={{ margin: '0 0 12px 0' }}>What would you like to do with emails from this sender?</p>
                            <label style={{ display: 'flex', alignItems: 'center', gap: '8px', cursor: 'pointer', fontSize: '13px', color: 'var(--text-color)' }}>
                                <input 
                                    type="checkbox" 
                                    checked={blockSenderApplyExisting}
                                    onChange={e => setBlockSenderApplyExisting(e.target.checked)}
                                />
                                Apply to all existing emails from this sender
                            </label>
                        </div>
                        <div className="db-compose-exit-panel__actions" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '8px', padding: '16px' }}>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                onClick={() => handleBlockSenderAction(blockSenderModal, 'Spam')}
                            >
                                Move to Spam
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                onClick={() => handleBlockSenderAction(blockSenderModal, 'Trash')}
                            >
                                Move to Trash
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                onClick={() => handleBlockSenderAction(blockSenderModal, 'Delete')}
                            >
                                Delete Completely
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                onClick={() => handleBlockSenderAction(blockSenderModal, 'Archive')}
                            >
                                Archive
                            </button>
                            <div style={{ display: 'flex', gap: '8px' }}>
                                <select 
                                    className="db-advanced-search-input" 
                                    style={{ flex: 1 }}
                                    value={blockSenderSelectedFolder}
                                    onChange={e => setBlockSenderSelectedFolder(e.target.value)}
                                >
                                    <option value="" disabled>Select Folder...</option>
                                    {folders.map(f => (
                                        <option key={f} value={f}>{folderInfo(f).label}</option>
                                    ))}
                                </select>
                                <button
                                    type="button"
                                    className="db-advanced-search-btn db-advanced-search-btn--secondary"
                                    onClick={() => handleBlockSenderAction(blockSenderModal, 'Folder')}
                                >
                                    Move
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </React.Fragment>
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

export function MailDynamicLayout({ layoutMode, layoutData, mailboxesBar, maillistBar, tabsBar, toolsBar, centerPlane, hideCenterPlane = false }) {
    const bars = {
        mailboxes: mailboxesBar,
        maillist: maillistBar,
        tabs: tabsBar,
        tools: toolsBar
    }

    const { top = [], bottom = [], left = [], right = [] } = layoutData || {
        top: ['tabs'],
        bottom: ['tools'],
        left: ['mailboxes', 'maillist'],
        right: []
    }

    const normalizeStack = (items) => {
        if (!Array.isArray(items)) return []
        return items
    }

    const topStack = normalizeStack(top)
    const bottomStack = normalizeStack(bottom)
    const leftStack = normalizeStack(left)
    const rightStack = normalizeStack(right)

    const renderStack = (keys, reverse = false, region) => {
        const arr = reverse ? [...keys].reverse() : keys
        return arr.filter((key) => bars[key]).map(key => (
            <div key={key} className={`db-layout-region db-layout-region--${region}`} style={{ display: 'contents' }}>
                {bars[key]}
            </div>
        ))
    }

	    return (
	        <div style={{ display: 'flex', flexDirection: 'column', height: '100%', width: '100%', overflow: 'hidden', background: 'var(--c-bg)' }}>
	            {renderStack(topStack, false, 'top')}
	            <div style={{ display: 'flex', flex: 1, minHeight: 0, overflow: 'hidden', position: 'relative' }}>
	                {renderStack(leftStack, false, 'left')}
	                <div
	                    style={
	                        hideCenterPlane
	                            ? { display: 'none' }
                            : { flex: 1, display: 'flex', flexDirection: 'column', minWidth: 0, overflow: 'hidden', position: 'relative' }
                    }
                    aria-hidden={hideCenterPlane ? 'true' : undefined}
                >
                    {centerPlane}
                </div>
                {renderStack(rightStack, true, 'right')}
            </div>
            {renderStack(bottomStack, true, 'bottom')}
        </div>
    )
}

export default DashboardPage
