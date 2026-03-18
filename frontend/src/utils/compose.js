export function normalizeComposeDraft(draft = {}) {
  return {
    to: typeof draft?.to === 'string' ? draft.to : '',
    cc: typeof draft?.cc === 'string' ? draft.cc : '',
    bcc: typeof draft?.bcc === 'string' ? draft.bcc : '',
    subject: typeof draft?.subject === 'string' ? draft.subject : '',
    body: typeof draft?.body === 'string' ? draft.body : '',
    htmlBody: typeof draft?.htmlBody === 'string' ? draft.htmlBody : '',
    showCc: Boolean(draft?.showCc || draft?.cc),
    showBcc: Boolean(draft?.showBcc || draft?.bcc),
  }
}

export function parseComposeRecipients(value) {
  if (Array.isArray(value)) {
    return value.map((entry) => `${entry || ''}`.trim()).filter(Boolean)
  }
  return `${value || ''}`.split(',').map((entry) => entry.trim()).filter(Boolean)
}

export function getComposeTitle(draft) {
  const subject = `${draft?.subject || ''}`.trim()
  return subject || 'New Message'
}
