import createDOMPurify from 'dompurify'

const FORBID_TAGS = [
  'script',
  'iframe',
  'object',
  'embed',
  'form',
  'input',
  'button',
  'textarea',
  'select',
  'base',
  'meta',
  'link',
]

const ALLOWED_URI_REGEXP = /^(?:(?:https?|mailto|cid):|data:image\/(?:png|gif|jpeg|jpg|webp|svg\+xml);base64,)/i

function getWindow(providedWindow) {
  if (providedWindow?.document) return providedWindow
  if (typeof window !== 'undefined' && window?.document) return window
  return null
}

function createPurifier(providedWindow) {
  const activeWindow = getWindow(providedWindow)
  if (!activeWindow) return null

  const purifier = createDOMPurify(activeWindow)
  purifier.addHook('uponSanitizeAttribute', (_node, data) => {
    if (/^on/i.test(data.attrName)) {
      data.keepAttr = false
      return
    }

    if ((data.attrName === 'href' || data.attrName === 'src') && data.attrValue) {
      const value = String(data.attrValue).trim()
      if (!ALLOWED_URI_REGEXP.test(value)) {
        data.keepAttr = false
      }
    }
  })
  return purifier
}

export function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;')
}

export function seedHtmlFromPlainText(plainText) {
  const normalized = String(plainText || '').replace(/\r/g, '').trim()
  if (!normalized) {
    return '<p></p>'
  }

  const paragraphs = normalized
    .split(/\n{2,}/)
    .map((part) => part.split('\n').map(escapeHtml).join('<br>'))
    .filter(Boolean)

  if (paragraphs.length === 0) {
    return '<p></p>'
  }

  return paragraphs.map((paragraph) => `<p>${paragraph}</p>`).join('\n')
}

export function htmlToPlainText(html, providedWindow) {
  if (!html) return ''
  const activeWindow = getWindow(providedWindow)

  try {
    if (activeWindow?.DOMParser) {
      const doc = new activeWindow.DOMParser().parseFromString(html, 'text/html')
      return (doc.body?.textContent || '')
        .replace(/\u00a0/g, ' ')
        .replace(/\r/g, '')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
    }

    return String(html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/p>/gi, '\n\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()
  } catch {
    return String(html || '').trim()
  }
}

export function sanitizeComposeHtml(html, providedWindow) {
  const purifier = createPurifier(providedWindow)
  if (!purifier) return String(html || '')

  return purifier.sanitize(String(html || ''), {
    FORBID_TAGS,
    FORBID_ATTR: ['srcset'],
    ALLOW_DATA_ATTR: false,
    KEEP_CONTENT: false,
    ALLOWED_URI_REGEXP,
  })
}

export function buildComposePreviewDocument(html, providedWindow) {
  const sanitized = sanitizeComposeHtml(html, providedWindow)
  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    :root { color-scheme: light; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 20px;
      font: 14px/1.6 system-ui, sans-serif;
      color: #111827;
      background: #ffffff;
      overflow-wrap: anywhere;
    }
    img { max-width: 100%; height: auto; }
    table { border-collapse: collapse; max-width: 100%; }
    a { color: #0f62fe; }
  </style>
</head>
<body>${sanitized || '<p></p>'}</body>
</html>`
}
