const WEB_FALLBACK_KEY = 'guv_link_click_behavior'

function isProbablyTauri() {
  return typeof window !== 'undefined' && !!(window.__TAURI_INTERNALS__ || window.__TAURI__)
}

async function tryInvoke(command, args) {
  try {
    const { invoke } = await import('@tauri-apps/api/core')
    return await invoke(command, args)
  } catch {
    return null
  }
}

export function isAllowedExternalUrl(url) {
  const u = String(url || '').trim()
  return (
    u.startsWith('http://')
    || u.startsWith('https://')
    || u.startsWith('mailto:')
    || u.startsWith('tel:')
  )
}

export function getUrlDomain(url) {
  try {
    const u = new URL(url)
    return u.hostname.toLowerCase()
  } catch {
    return null
  }
}

/**
 * Sanitize email HTML to neutralize all external links.
 *
 * Every <a> with an external href gets its href moved to
 * `data-external-href` and replaced with "#", so the browser never
 * attempts to navigate the sandboxed iframe to an external URL.
 * <base> tags and target attributes on links are also stripped.
 *
 * The link interceptor (installIframeLinkInterceptor) reads from
 * data-external-href to present the open/copy prompt.
 */
export function sanitizeMailHtml(html) {
  if (!html) return html
  try {
    const doc = new DOMParser().parseFromString(html, 'text/html')

    // ── Remove dangerous elements ──────────────────────────────────
    // Scripts, iframes, objects, embeds, applets, and forms can all
    // execute code or trick the user into submitting data.
    doc.querySelectorAll(
      'script, iframe, object, embed, applet, form, link[rel="import"]'
    ).forEach((el) => el.remove())

    // Remove <base> elements — they can redirect relative link resolution
    doc.querySelectorAll('base').forEach((el) => el.remove())

    // Remove CSP meta tags from the email — they serve no purpose in our
    // sandboxed iframe and can trigger browser warnings (e.g. manifest-src)
    doc.querySelectorAll('meta[http-equiv="Content-Security-Policy"]').forEach((el) => el.remove())
    doc.querySelectorAll('meta[http-equiv="content-security-policy"]').forEach((el) => el.remove())

    // ── Strip inline event handlers & javascript: URLs ─────────────
    // This prevents any script execution from email HTML, even with
    // allow-scripts in the sandbox (needed for parent event listeners).
    doc.querySelectorAll('*').forEach((el) => {
      // Remove all on* attributes (onclick, onload, onerror, etc.)
      const attrsToRemove = []
      for (const attr of el.attributes) {
        if (/^on/i.test(attr.name)) {
          attrsToRemove.push(attr.name)
        }
      }
      attrsToRemove.forEach((name) => el.removeAttribute(name))

      // Neutralize javascript: hrefs (but not data-external-href ones)
      const href = el.getAttribute('href')
      if (href && /^\s*javascript\s*:/i.test(href)) {
        el.setAttribute('href', '#')
      }
      const src = el.getAttribute('src')
      if (src && /^\s*javascript\s*:/i.test(src)) {
        el.removeAttribute('src')
      }
    })

    // ── Neutralize external links ──────────────────────────────────
    doc.querySelectorAll('a[href]').forEach((anchor) => {
      const href = anchor.getAttribute('href') || ''
      if (!href || href === '#') return

      // Resolve the href to an absolute URL for checking
      let resolvedHref = href
      try {
        resolvedHref = new URL(href, 'https://placeholder.invalid').href
      } catch {
        // keep original
      }

      if (isAllowedExternalUrl(href) || isAllowedExternalUrl(resolvedHref)) {
        // Store original URL and neutralize the link
        anchor.setAttribute('data-external-href', href)
        anchor.setAttribute('href', '#')
        anchor.removeAttribute('target')
        anchor.style.cursor = 'pointer'
      }
    })

    // Also remove target attributes from any remaining links
    doc.querySelectorAll('a[target]').forEach((anchor) => {
      anchor.removeAttribute('target')
    })

    // Serialize back — use the full document including <html>/<head>/<body>
    // so styles/meta are preserved
    return doc.documentElement.outerHTML
  } catch {
    // If parsing fails, return original HTML as-is (better than nothing)
    return html
  }
}

export async function getLinkClickBehavior(url) {
  const domain = url ? getUrlDomain(url) : null
  
  if (isProbablyTauri()) {
    if (domain) {
      const dv = await tryInvoke('get_domain_link_behavior', { domain })
      if (dv === 'open' || dv === 'copy' || dv === 'ask') return dv
    }
    const v = await tryInvoke('get_link_click_behavior', {})
    if (v === 'ask' || v === 'open' || v === 'copy') return v
    return 'ask'
  }

  // Web fallback (using a prefixed key for domains in localStorage if we want, but let's keep it simple for now)
  if (domain) {
    const dv = window.localStorage?.getItem(`${WEB_FALLBACK_KEY}_domain_${domain}`)
    if (dv === 'open' || dv === 'copy' || dv === 'ask') return dv
  }
  const v = window.localStorage?.getItem(WEB_FALLBACK_KEY)
  return v === 'ask' || v === 'open' || v === 'copy' ? v : 'ask'
}

export async function setLinkClickBehavior(value) {
  const v = value === 'open' || value === 'copy' || value === 'ask' ? value : 'ask'
  if (isProbablyTauri()) {
    await tryInvoke('set_link_click_behavior', { behavior: v })
    return
  }
  window.localStorage?.setItem(WEB_FALLBACK_KEY, v)
}

export async function setDomainLinkBehavior(domain, value) {
  const v = value === 'open' || value === 'copy' || value === 'ask' ? value : 'ask'
  if (!domain) return
  if (isProbablyTauri()) {
    await tryInvoke('set_domain_link_behavior', { domain, behavior: v })
    return
  }
  window.localStorage?.setItem(`${WEB_FALLBACK_KEY}_domain_${domain}`, v)
}

export async function removeDomainLinkBehavior(domain) {
  if (!domain) return
  if (isProbablyTauri()) {
    await tryInvoke('remove_domain_link_behavior', { domain })
    return
  }
  window.localStorage?.removeItem(`${WEB_FALLBACK_KEY}_domain_${domain}`)
}

export async function getAllDomainLinkBehaviors() {
  if (isProbablyTauri()) {
    return (await tryInvoke('get_all_domain_link_behaviors', {})) || {}
  }
  
  // Web fallback
  const results = {}
  const prefix = `${WEB_FALLBACK_KEY}_domain_`
  for (let i = 0; i < localStorage.length; i++) {
    const key = localStorage.key(i)
    if (key.startsWith(prefix)) {
      results[key.slice(prefix.length)] = localStorage.getItem(key)
    }
  }
  return results
}

export async function openExternalUrl(url) {
  const u = String(url || '').trim()
  if (!isAllowedExternalUrl(u)) return

  if (isProbablyTauri()) {
    await tryInvoke('open_external_url', { url: u })
    return
  }

  window.open(u, '_blank', 'noopener,noreferrer')
}

export async function copyTextToClipboard(text) {
  const t = String(text ?? '')
  if (isProbablyTauri()) {
    await tryInvoke('copy_to_clipboard', { text: t })
    return
  }

  if (navigator?.clipboard?.writeText) {
    await navigator.clipboard.writeText(t)
    return
  }

  const el = document.createElement('textarea')
  el.value = t
  el.setAttribute('readonly', 'true')
  el.style.position = 'fixed'
  el.style.left = '-9999px'
  document.body.appendChild(el)
  el.select()
  document.execCommand('copy')
  el.remove()
}

/**
 * Install a link-click interceptor on an iframe's document.
 *
 * This works with sanitizeMailHtml(): links have their original
 * href in data-external-href and their actual href set to "#".
 * When the user clicks a link, the callback receives the original URL.
 *
 * Supports both:
 *   - Sanitized HTML (data-external-href) — preferred, always works
 *   - Unsanitized HTML (regular href) — fallback for legacy callsites
 */
export function installIframeLinkInterceptor(iframe, onUrl) {
  if (!iframe) return () => {}

  let disposed = false
  let attachedDoc = null
  let handler = null
  let keyHandler = null

  const extractHref = (anchor) => {
    // Prefer data-external-href (set by sanitizeMailHtml)
    const externalHref = anchor.getAttribute('data-external-href')
    if (externalHref && isAllowedExternalUrl(externalHref)) return externalHref
    // Fallback: regular href (for unsanitized HTML)
    const raw = anchor.getAttribute('href') || ''
    const href = anchor.href || raw
    if (href && isAllowedExternalUrl(href)) return href
    return null
  }

  const findAnchorFromEvent = (event) => {
    const path = typeof event?.composedPath === 'function' ? event.composedPath() : null
    if (Array.isArray(path)) {
      for (const node of path) {
        if (!node || node === window) continue
        const el = node?.nodeType === Node.TEXT_NODE ? node.parentElement : node
        if (el?.tagName === 'A' && (el.getAttribute?.('data-external-href') || el.getAttribute?.('href'))) return el
        const a = el?.closest?.('a[data-external-href], a[href]')
        if (a) return a
      }
    }
    const target = event?.target
    const elementTarget = target?.nodeType === Node.TEXT_NODE ? target.parentElement : target
    return elementTarget?.closest?.('a[data-external-href], a[href]') || null
  }

  const tryAttach = () => {
    if (disposed) return
    const doc = iframe.contentDocument
    if (!doc || doc === attachedDoc) return

    attachedDoc = doc
    handler = (event) => {
      try {
        const anchor = findAnchorFromEvent(event)
        if (!anchor) return

        const href = extractHref(anchor)
        if (!href) return

        event.preventDefault()
        event.stopImmediatePropagation?.()
        event.stopPropagation()
        onUrl?.(href)
      } catch {
        // ignore
      }
    }

    keyHandler = (event) => {
      try {
        const key = event?.key
        if (key !== 'Enter' && key !== ' ') return
        const active = doc.activeElement
        const anchor = active?.tagName === 'A' ? active : active?.closest?.('a[data-external-href], a[href]')
        if (!anchor) return
        const href = extractHref(anchor)
        if (!href) return
        event.preventDefault()
        event.stopImmediatePropagation?.()
        event.stopPropagation()
        onUrl?.(href)
      } catch {
        // ignore
      }
    }

    doc.addEventListener('click', handler, true)
    doc.addEventListener('auxclick', handler, true)
    doc.addEventListener('mousedown', handler, true)
    doc.addEventListener('pointerdown', handler, true)
    doc.addEventListener('keydown', keyHandler, true)
  }

  tryAttach()

  return () => {
    disposed = true
    try {
      if (attachedDoc && handler) {
        attachedDoc.removeEventListener('click', handler, true)
        attachedDoc.removeEventListener('auxclick', handler, true)
        attachedDoc.removeEventListener('mousedown', handler, true)
        attachedDoc.removeEventListener('pointerdown', handler, true)
      }
      if (attachedDoc && keyHandler) {
        attachedDoc.removeEventListener('keydown', keyHandler, true)
      }
    } catch {
      // ignore
    }
  }
}
