function sanitizeMailboxList(value) {
    if (!Array.isArray(value)) return []
    return value.filter((entry) => typeof entry === 'string')
}

export function isLabelMailboxPath(value) {
    const mailbox = (value || '').trim()
    return /^Labels\//i.test(mailbox)
        || /^Labels\//i.test(mailbox)
        || /^\[Labels\]\//i.test(mailbox)
}

export function normalizeMailboxResponse(payload) {
    const rawFolders = sanitizeMailboxList(payload?.folders)
    const rawLabels = sanitizeMailboxList(payload?.labels)
    const allMailboxes = sanitizeMailboxList(payload?.mailboxes)

    const normalizedMailboxes = allMailboxes.length > 0
        ? allMailboxes
        : Array.from(new Set([...rawFolders, ...rawLabels]))

    if (rawFolders.length > 0 || rawLabels.length > 0) {
        return {
            allMailboxes: normalizedMailboxes,
            folders: rawFolders,
            labels: rawLabels,
        }
    }

    const folders = []
    const labels = []

    normalizedMailboxes.forEach((mailbox) => {
        if (isLabelMailboxPath(mailbox)) {
            labels.push(mailbox)
        } else {
            folders.push(mailbox)
        }
    })

    return {
        allMailboxes: normalizedMailboxes,
        folders,
        labels,
    }
}

/** Deduplicate mailbox paths; keep first occurrence (case-insensitive key). */
export function dedupeStringsCaseInsensitive(values) {
    const next = []
    const seen = new Set()
    for (const value of values || []) {
        const trimmed = (value || '').toString().trim()
        if (!trimmed) continue
        const key = trimmed.toLowerCase()
        if (seen.has(key)) continue
        seen.add(key)
        next.push(trimmed)
    }
    return next
}

/** Default sidebar order by last path segment: Inbox → All Mail → Archive → Drafts → Starred → Sent → user → Spam → Trash. */
const DEFAULT_SIDEBAR_PRIORITY = {
    INBOX: 10,
    'ALL MAIL': 20,
    ARCHIVE: 30,
    DRAFTS: 40,
    STARRED: 50,
    SENT: 60,
    'SENT ITEMS': 60,
    SNOOZED: 65,
}

const PRI_USER = 400
const PRI_SPAM = 800
const PRI_TRASH = 810

export function defaultMailboxSidebarPriority(displayName) {
    const key = (displayName || '').trim().toUpperCase()
    if (!key) return PRI_USER
    if (DEFAULT_SIDEBAR_PRIORITY[key] !== undefined) return DEFAULT_SIDEBAR_PRIORITY[key]
    if (key === 'SPAM' || key === 'JUNK' || key === 'JUNK E-MAIL' || key === 'BULK MAIL') return PRI_SPAM
    if (key === 'TRASH' || key === 'DELETED' || key === 'BIN') return PRI_TRASH
    return PRI_USER
}

export function compareMailboxesDefaultOrder(pathA, pathB) {
    const na = (pathA || '').split('/').filter(Boolean).pop() || pathA || ''
    const nb = (pathB || '').split('/').filter(Boolean).pop() || pathB || ''
    const pa = defaultMailboxSidebarPriority(na)
    const pb = defaultMailboxSidebarPriority(nb)
    if (pa !== pb) return pa - pb
    return (pathA || '').localeCompare(pathB || '')
}

export function indexInOrderIgnoreCase(order, item) {
    if (!Array.isArray(order) || item == null) return -1
    const needle = String(item)
    const lower = needle.toLowerCase()
    for (let i = 0; i < order.length; i++) {
        const o = order[i]
        if (o === needle) return i
        if (typeof o === 'string' && o.toLowerCase() === lower) return i
    }
    return -1
}

export function sortWithSavedOrder(paths, savedOrder, defaultCompare) {
    const order = Array.isArray(savedOrder) ? savedOrder : []
    const list = [...paths]
    const fallback = defaultCompare || ((a, b) => String(a).localeCompare(String(b)))
    if (order.length === 0) {
        list.sort(fallback)
        return list
    }
    list.sort((a, b) => {
        const ia = indexInOrderIgnoreCase(order, a)
        const ib = indexInOrderIgnoreCase(order, b)
        if (ia !== -1 && ib !== -1) return ia - ib
        if (ia !== -1) return -1
        if (ib !== -1) return 1
        return fallback(a, b)
    })
    return list
}
