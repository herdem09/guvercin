function sanitizeMailboxList(value) {
    if (!Array.isArray(value)) return []
    return value.filter((entry) => typeof entry === 'string')
}

export function isLabelMailboxPath(value) {
    const mailbox = (value || '').trim()
    return /^Labels\//i.test(mailbox)
        || /^Etiketler\//i.test(mailbox)
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
