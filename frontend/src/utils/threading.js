export function parseMessageIdList(value) {
  if (typeof value !== 'string') return []
  const matches = value.match(/<[^>]+>/g)
  return Array.isArray(matches) ? matches.map((m) => m.trim()).filter(Boolean) : []
}

function isProtonInternalId(messageId) {
  const v = typeof messageId === 'string' ? messageId.toLowerCase() : ''
  return v.includes('@protonmail.internalid')
}

function filterThreadingIds(ids) {
  return (Array.isArray(ids) ? ids : []).filter((id) => id && !isProtonInternalId(id))
}

function extractEmailLike(value) {
  if (typeof value !== 'string') return ''
  const s = value.trim()
  if (!s) return ''
  const m = s.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)
  return m ? m[0].toLowerCase() : ''
}

export function normalizeSubject(subject) {
  if (typeof subject !== 'string') return ''
  let s = subject.replace(/\s+/g, ' ').trim()
  if (!s) return ''

  // Strip common reply/forward prefixes repeatedly (Gmail/Outlook-like display normalization).
  // Examples: "Re:", "Re[2]:", "Fwd:", "Fw:", "Ynt:".
  const prefixRe = /^\s*(?:(re|fwd?|fw|ynt|sv|aw)\s*(?:\[\d+\])?\s*:\s*)+/i
  s = s.replace(prefixRe, '').replace(/\s+/g, ' ').trim()
  return s
}

export function computeThreadKey(mail, { mailbox = '' } = {}) {
  const refs = filterThreadingIds(parseMessageIdList(mail?.references))
  if (refs.length > 0) return refs[0]

  const irt = filterThreadingIds(parseMessageIdList(mail?.in_reply_to))
  if (irt.length > 0) return irt[0]

  const mb = String(mailbox || mail?.mailbox || '').trim().toLowerCase()
  const fromRaw = String(mail?.address || '').trim().toLowerCase()
  const fromEmail = extractEmailLike(fromRaw) || extractEmailLike(String(mail?.name || ''))
  const fromDomain = fromEmail.includes('@') ? fromEmail.split('@').pop() : ''
  const subjectNorm = normalizeSubject(String(mail?.subject || '')).toLowerCase()
  if (mb && subjectNorm) {
    const githubLike = subjectNorm.startsWith('[github]') && fromDomain === 'github.com'
    const fromKey = githubLike ? fromDomain : (fromEmail || fromRaw)
    if (fromKey) return `smart:${mb}::${fromKey}::${subjectNorm}`
  }

  const mid = filterThreadingIds(parseMessageIdList(mail?.message_id))
  if (mid.length > 0) return mid[0]

  const rawMid = typeof mail?.message_id === 'string' ? mail.message_id.trim() : ''
  if (rawMid && !isProtonInternalId(rawMid)) return rawMid

  const uid = String(mail?.id ?? '')
  return `${mb}::${uid}`
}

function dateMs(mail) {
  const t = Date.parse(mail?.date || '')
  return Number.isFinite(t) ? t : 0
}

function uidNum(mail) {
  const n = Number.parseInt(mail?.id ?? '', 10)
  return Number.isFinite(n) ? n : 0
}

function pickLatest(mails) {
  let best = mails[0] || null
  for (const m of mails) {
    if (!best) {
      best = m
      continue
    }
    const dm = dateMs(m)
    const db = dateMs(best)
    if (dm !== db) {
      if (dm > db) best = m
      continue
    }
    const um = uidNum(m)
    const ub = uidNum(best)
    if (um !== ub) {
      if (um > ub) best = m
      continue
    }
    if (String(m?.id ?? '') > String(best?.id ?? '')) best = m
  }
  return best
}

export function buildThreads(mails, { threadOrder = 'asc', mailbox = '' } = {}) {
  const order = threadOrder === 'desc' ? 'desc' : 'asc'
  const threadsById = new Map()
  const scopedMailbox = String(mailbox || '').trim()

  const items = Array.isArray(mails) ? mails : []
  for (const mail of items) {
    if (!mail || typeof mail !== 'object') continue
    const mailboxForKey = scopedMailbox || String(mail.mailbox || '').trim()
    const id = computeThreadKey(mail, { mailbox: mailboxForKey })
    const existing = threadsById.get(id)
    if (existing) {
      existing.mails.push(mail)
    } else {
      threadsById.set(id, { id, mails: [mail] })
    }
  }

  const threads = Array.from(threadsById.values()).map((thread) => {
    const sorted = thread.mails.slice().sort((a, b) => {
      const da = dateMs(a) - dateMs(b)
      if (da !== 0) return da
      const ua = uidNum(a) - uidNum(b)
      if (ua !== 0) return ua
      return String(a?.id ?? '').localeCompare(String(b?.id ?? ''), undefined, { sensitivity: 'base' })
    })
    if (order === 'desc') sorted.reverse()

    const latest = pickLatest(thread.mails) || thread.mails[thread.mails.length - 1] || null
    const latestFrom = latest ? (latest.name || latest.address || '') : ''
    const latestDate = latest ? (latest.date || '') : ''
    const latestDateMs = latest ? dateMs(latest) : 0

    const unreadCount = thread.mails.reduce((acc, m) => acc + (m?.seen === true ? 0 : 1), 0)

    const latestSubjectRaw = latest ? String(latest.subject || '') : ''
    const subjectNormalized = normalizeSubject(latestSubjectRaw) || normalizeSubject(String(sorted[sorted.length - 1]?.subject || ''))
    const subjectDisplay = subjectNormalized || latestSubjectRaw || '(No Subject)'

    return {
      id: thread.id,
      subject_display: subjectDisplay,
      latest_from: String(latestFrom || ''),
      latest_date: String(latestDate || ''),
      latest_date_ms: latestDateMs,
      message_count: sorted.length,
      unread_count: unreadCount,
      mail_ids: sorted.map((m) => String(m?.id ?? '')),
      mails: sorted,
    }
  })

  threads.sort((a, b) => {
    const d = (b.latest_date_ms || 0) - (a.latest_date_ms || 0)
    if (d !== 0) return d
    return String(b.id).localeCompare(String(a.id), undefined, { sensitivity: 'base' })
  })

  return threads
}
