import { normalizeComposeDraft, parseComposeBody, parseComposeRecipients } from './compose.js'

function prefixSubject(prefix, subject) {
  const baseSubject = (subject || '(No Subject)').trim()
  const lower = baseSubject.toLowerCase()
  const prefixLower = `${prefix}`.trim().toLowerCase()
  if (!prefixLower) return baseSubject
  if (lower.startsWith(`${prefixLower} `)) return baseSubject
  return `${prefix} ${baseSubject}`.trim()
}

function dedupeEmails(values) {
  const seen = new Set()
  return (values || []).filter((value) => {
    const email = `${value || ''}`.trim()
    const key = email.toLowerCase()
    if (!email || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function stripSelf(recipients, selfEmail) {
  const self = `${selfEmail || ''}`.trim().toLowerCase()
  if (!self) return recipients
  return recipients.filter((addr) => `${addr || ''}`.trim().toLowerCase() !== self)
}

function buildReplyHeaders({ messageId, references }) {
  const msgId = `${messageId || ''}`.trim()
  if (!msgId) return []
  const refs = `${references || ''}`.trim()
  const nextRefs = refs ? `${refs} ${msgId}` : msgId
  return [
    { name: 'In-Reply-To', value: msgId },
    { name: 'References', value: nextRefs },
  ]
}

export async function queueComposeSend({
  draft,
  accountEmail = '',
  queueAction,
  confirm,
}) {
  const normalized = normalizeComposeDraft(draft)

  const forwardCount = Array.isArray(normalized.forwardTargets) ? normalized.forwardTargets.length : 0
  const bulkReplyCount = Array.isArray(normalized.bulkReplyTargets) ? normalized.bulkReplyTargets.length : 0

  if (bulkReplyCount > 0) {
    if (typeof confirm === 'function') {
      const ok = await confirm(normalized)
      if (!ok) return false
    }

    const options = normalized.bulkReplyOptions || { mode: 'reply', includeQuote: true }
    const basePayload = parseComposeBody(normalized, accountEmail)

    for (const target of normalized.bulkReplyTargets) {
      const replyTo = `${target.address || ''}`.trim()
      if (!replyTo) continue

      const mode = options.mode || 'reply'
      let toList = [replyTo]
      let ccList = []

      if (mode === 'reply_all') {
        toList = dedupeEmails([replyTo, ...parseComposeRecipients(target.recipientTo)])
        ccList = dedupeEmails(parseComposeRecipients(target.cc))
        toList = stripSelf(toList, accountEmail)
        ccList = stripSelf(ccList, accountEmail).filter((addr) => !toList.some((t) => t.toLowerCase() === addr.toLowerCase()))
      }

      const subject = prefixSubject('Re:', target.subject || '')
      const headers = buildReplyHeaders({ messageId: target.messageId, references: target.references })

      const messageDraft = {
        ...normalized,
        toRecipients: toList,
        ccRecipients: ccList,
        bccRecipients: [],
        subject,
      }

      const payload = parseComposeBody(messageDraft, accountEmail)
      payload.attachments = basePayload.attachments || payload.attachments

      if (options.includeQuote !== false && target.quote) {
        payload.body_text = `${payload.body_text || ''}\n\n${target.quote}`.trim()
      }

      payload.headers = headers
      payload.post_send = { mark_answered: { uid: target.uid, mailbox: target.mailbox } }

      await queueAction('send', null, payload, null)
    }

    return true
  }

  if (forwardCount > 0) {
    const recipientsPayload = parseComposeBody(normalized, accountEmail)
    const recipientCount = recipientsPayload.to.length + recipientsPayload.cc.length + recipientsPayload.bcc.length
    if (recipientCount === 0) {
      throw new Error('Please add at least one recipient.')
    }

    const forwardOptions = normalized.forwardOptions || { subjectPrefix: 'Fwd:', forwardStyle: 'copy', bundle: false }
    const forwardPayload = {
      to: recipientsPayload.to,
      cc: recipientsPayload.cc,
      bcc: recipientsPayload.bcc,
      subject_prefix: forwardOptions.subjectPrefix || 'Fwd:',
      forward_style: forwardOptions.forwardStyle || 'copy',
      subject: `${normalized.subject || ''}`.trim(),
      format: recipientsPayload.format,
      body_text: recipientsPayload.body_text,
      body_html: recipientsPayload.body_html,
      attachments: recipientsPayload.attachments,
    }

    if (forwardOptions.bundle && forwardCount > 1) {
      forwardPayload.targets = normalized.forwardTargets
      await queueAction('forward_bundle', null, forwardPayload, null)
      return true
    }

    if (!forwardOptions.bundle && forwardCount > 1 && typeof confirm === 'function') {
      const ok = await confirm(normalized, { type: 'forward_many', count: forwardCount })
      if (!ok) return false
    }

    await Promise.all(normalized.forwardTargets.map((target) => (
      queueAction('forward', target.uid, forwardPayload, target.mailbox)
    )))
    return true
  }

  const payload = parseComposeBody(normalized, accountEmail)
  if (payload.to.length === 0) {
    throw new Error('Please add at least one recipient.')
  }

  if (Array.isArray(normalized.extraHeaders) && normalized.extraHeaders.length > 0) {
    payload.headers = normalized.extraHeaders
  }
  if (normalized.replyContext?.uid && normalized.replyContext?.mailbox) {
    payload.post_send = { mark_answered: { uid: normalized.replyContext.uid, mailbox: normalized.replyContext.mailbox } }
  }

  await queueAction('send', null, payload, null)
  return true
}
