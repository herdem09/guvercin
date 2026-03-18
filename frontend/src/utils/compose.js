import {
  htmlToPlainText,
  sanitizeComposeHtml,
  seedHtmlFromPlainText,
} from './composeHtml.js'

const RECIPIENT_SPLIT_RE = /[,\n;]+/
const SIMPLE_EMAIL_RE = /^[^\s@<>(),;]+@[^\s@<>(),;]+\.[^\s@<>(),;]+$/

function normalizeAttachment(attachment = {}) {
  const fileName = typeof attachment?.name === 'string' && attachment.name.trim()
    ? attachment.name.trim()
    : typeof attachment?.filename === 'string'
      ? attachment.filename.trim()
      : ''

  const disposition = attachment?.disposition === 'inline' ? 'inline' : 'attachment'
  const source = attachment?.source === 'html-inline' ? 'html-inline' : 'manual'

  return {
    id: typeof attachment?.id === 'string' && attachment.id.trim()
      ? attachment.id
      : `attachment-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    name: fileName || 'attachment',
    mimeType: typeof attachment?.mimeType === 'string' && attachment.mimeType.trim()
      ? attachment.mimeType.trim()
      : typeof attachment?.content_type === 'string' && attachment.content_type.trim()
        ? attachment.content_type.trim()
        : 'application/octet-stream',
    size: Number.isFinite(attachment?.size) ? Number(attachment.size) : 0,
    base64: typeof attachment?.base64 === 'string'
      ? attachment.base64
      : typeof attachment?.data_base64 === 'string'
        ? attachment.data_base64
        : '',
    disposition,
    contentId: typeof attachment?.contentId === 'string' && attachment.contentId.trim()
      ? attachment.contentId.trim()
      : typeof attachment?.content_id === 'string' && attachment.content_id.trim()
        ? attachment.content_id.trim()
        : undefined,
    source,
  }
}

function normalizeRecipientToken(value) {
  const trimmed = `${value || ''}`
    .trim()
    .replace(/^[,\s;]+|[,\s;]+$/g, '')

  if (!trimmed) return ''

  const angleMatch = trimmed.match(/<([^<>]+)>/)
  if (angleMatch?.[1]) {
    return angleMatch[1].trim()
  }

  return trimmed
}

export function normalizeComposeRecipients(value) {
  const rawList = Array.isArray(value)
    ? value
    : `${value || ''}`.split(RECIPIENT_SPLIT_RE)

  const seen = new Set()
  const normalized = []
  rawList.forEach((entry) => {
    const token = normalizeRecipientToken(entry)
    const key = token.toLowerCase()
    if (!token || seen.has(key)) return
    seen.add(key)
    normalized.push(token)
  })
  return normalized
}

export function composeRecipientsToString(recipients) {
  return normalizeComposeRecipients(recipients).join(', ')
}

export function parseComposeRecipients(value) {
  return normalizeComposeRecipients(value)
}

export function normalizeRecipientForSend(value) {
  const normalized = normalizeRecipientToken(value)
  if (!normalized || !SIMPLE_EMAIL_RE.test(normalized)) {
    throw new Error(`Invalid recipient: ${value || ''}`.trim())
  }
  return normalized
}

function validateComposeRecipientList(value) {
  return normalizeComposeRecipients(value).map((entry) => normalizeRecipientForSend(entry))
}

export function normalizeComposeDraft(draft = {}) {
  const legacyBody = typeof draft?.body === 'string' ? draft.body : ''
  const plainBody = typeof draft?.plainBody === 'string' ? draft.plainBody : legacyBody
  const htmlBody = typeof draft?.htmlBody === 'string' ? draft.htmlBody : ''
  const format = draft?.format === 'html' ? 'html' : 'plain'
  const htmlMode = draft?.htmlMode === 'preview' ? 'preview' : 'edit'
  const toRecipients = normalizeComposeRecipients(draft?.toRecipients ?? draft?.to)
  const ccRecipients = normalizeComposeRecipients(draft?.ccRecipients ?? draft?.cc)
  const bccRecipients = normalizeComposeRecipients(draft?.bccRecipients ?? draft?.bcc)

  return {
    to: composeRecipientsToString(toRecipients),
    cc: composeRecipientsToString(ccRecipients),
    bcc: composeRecipientsToString(bccRecipients),
    toRecipients,
    ccRecipients,
    bccRecipients,
    subject: typeof draft?.subject === 'string' ? draft.subject : '',
    from: typeof draft?.from === 'string' ? draft.from : '',
    plainBody,
    htmlBody,
    format,
    htmlMode,
    attachments: Array.isArray(draft?.attachments) ? draft.attachments.map(normalizeAttachment) : [],
    htmlSeededFromPlain: Boolean(draft?.htmlSeededFromPlain),
    showCc: Boolean(draft?.showCc || ccRecipients.length > 0),
    showBcc: Boolean(draft?.showBcc || bccRecipients.length > 0),
    draftId: typeof draft?.draftId === 'string' && draft.draftId.trim() ? draft.draftId.trim() : undefined,
    source: typeof draft?.source === 'string' && draft.source.trim() ? draft.source.trim() : 'new',
    composeSurface: draft?.composeSurface === 'window' || draft?.composeSurface === 'tab' ? draft.composeSurface : 'inline',
    pendingSendNoticeId: Number.isFinite(draft?.pendingSendNoticeId) ? Number(draft.pendingSendNoticeId) : null,
    restorableSource: draft?.restorableSource || null,
  }
}

export function getComposeTitle(draft) {
  const subject = `${draft?.subject || ''}`.trim()
  return subject || 'New Message'
}

function buildComposePayload(draft = {}, fromAddress = '') {
  const normalized = normalizeComposeDraft(draft)
  const to = validateComposeRecipientList(normalized.toRecipients)
  const cc = validateComposeRecipientList(normalized.ccRecipients)
  const bcc = validateComposeRecipientList(normalized.bccRecipients)

  const bodyHtml = normalized.format === 'html'
    ? sanitizeComposeHtml(normalized.htmlBody)
    : ''
  const plainBody = normalized.format === 'html'
    ? htmlToPlainText(bodyHtml)
    : normalized.plainBody.trim()

  return {
    from: normalized.from || fromAddress || '',
    to,
    cc,
    bcc,
    subject: normalized.subject || '',
    format: normalized.format,
    body_text: plainBody,
    body_html: bodyHtml,
    attachments: normalized.attachments
      .filter((attachment) => attachment.base64 && attachment.name)
      .map((attachment) => ({
        filename: attachment.name,
        content_type: attachment.mimeType,
        data_base64: attachment.base64,
        disposition: attachment.disposition,
        content_id: attachment.contentId || null,
      })),
  }
}

export function parseComposeBody(draft = {}, fromAddress = '') {
  return buildComposePayload(draft, fromAddress)
}

export function buildDraftSavePayload(draft = {}, fromAddress = '') {
  const normalized = normalizeComposeDraft(draft)
  const bodyHtml = normalized.format === 'html'
    ? sanitizeComposeHtml(normalized.htmlBody)
    : ''
  const plainBody = normalized.format === 'html'
    ? htmlToPlainText(bodyHtml)
    : normalized.plainBody.trim()

  return {
    from: normalized.from || fromAddress || '',
    to: normalizeComposeRecipients(normalized.toRecipients),
    cc: normalizeComposeRecipients(normalized.ccRecipients),
    bcc: normalizeComposeRecipients(normalized.bccRecipients),
    subject: normalized.subject || '',
    format: normalized.format,
    body_text: plainBody,
    body_html: bodyHtml,
    attachments: normalized.attachments
      .filter((attachment) => attachment.base64 && attachment.name)
      .map((attachment) => ({
        filename: attachment.name,
        content_type: attachment.mimeType,
        data_base64: attachment.base64,
        disposition: attachment.disposition,
        content_id: attachment.contentId || null,
      })),
    draft_id: normalized.draftId || null,
  }
}

export function isComposeDraftDirty(draft = {}) {
  const normalized = normalizeComposeDraft(draft)
  return (
    normalized.toRecipients.length > 0 ||
    normalized.ccRecipients.length > 0 ||
    normalized.bccRecipients.length > 0 ||
    normalized.subject.trim() !== '' ||
    normalized.plainBody.trim() !== '' ||
    normalized.htmlBody.trim() !== '' ||
    normalized.attachments.length > 0
  )
}

export function ensureHtmlDraftSeed(draft = {}) {
  const normalized = normalizeComposeDraft(draft)
  if (normalized.htmlBody.trim()) {
    return normalized
  }

  return {
    ...normalized,
    htmlBody: seedHtmlFromPlainText(normalized.plainBody),
    htmlSeededFromPlain: true,
  }
}
