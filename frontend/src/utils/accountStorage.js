const DEFAULT_LANGUAGE = 'en'
const DEFAULT_FONT = 'Arial'

const ACTIVE_ACCOUNT_SESSION_KEY = 'guvercin_active_account_id'
const ACCOUNT_SESSION_EVENT = 'guvercin-account-session-changed'

function notifyAccountSessionChanged(accountId) {
  try {
    window.dispatchEvent(
      new CustomEvent(ACCOUNT_SESSION_EVENT, {
        detail: { accountId: accountId ? accountId.toString() : null },
      }),
    )
  } catch {
    // ignore
  }
}

const formatPort = (value) => {
  if (value === null || value === undefined || value === '') {
    return ''
  }
  return value.toString()
}

const pickFirst = (...values) => {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') {
      return value
    }
  }
  return ''
}

export function hydrateAccountSession(account) {
  const accountId = account.account_id ?? account.accountId ?? account.id
  if (!accountId) {
    console.warn('hydrateAccountSession called without account_id')
    return
  }

  const accountForm = {
    email: pickFirst(account.email_address, account.email),
    displayName: pickFirst(account.display_name, account.displayName),
    imapServer: pickFirst(account.imap_host, account.imapHost),
    imapPort: formatPort(pickFirst(account.imap_port, account.imapPort)),
    smtpServer: pickFirst(account.smtp_host, account.smtpHost),
    smtpPort: formatPort(pickFirst(account.smtp_port, account.smtpPort)),
    sslMode: pickFirst(account.ssl_mode, account.sslMode) || 'STARTTLS',
  }

  localStorage.setItem('current_account_id', accountId.toString())
  try {
    sessionStorage.setItem(ACTIVE_ACCOUNT_SESSION_KEY, accountId.toString())
  } catch {
    // ignore
  }
  notifyAccountSessionChanged(accountId)
  localStorage.setItem('saved_email', accountForm.email)
  localStorage.setItem('saved_account_form', JSON.stringify(accountForm))
  localStorage.setItem(
    'language',
    pickFirst(account.language, account.lang) || DEFAULT_LANGUAGE,
  )

  localStorage.setItem('font', pickFirst(account.font) || DEFAULT_FONT)

  const themeRaw = pickFirst(account.theme)
  if (themeRaw) {
    if (themeRaw.toUpperCase() === 'SYSTEM') {
      localStorage.setItem('theme_mode', 'system')
    } else {
      localStorage.setItem('theme_mode', 'manual')
      localStorage.setItem('theme_name', themeRaw)
    }
  }

  window.dispatchEvent(new Event('guvercin-theme-changed'))
  localStorage.removeItem('temp_account_form')
  localStorage.removeItem('temp_account_form_draft')
  localStorage.removeItem('temp_language')
  localStorage.removeItem('temp_font')
  localStorage.removeItem('temp_theme_mode')
  localStorage.removeItem('temp_theme_name')
  localStorage.removeItem('temp_offline_config')
}

export function clearAccountSession() {
  localStorage.removeItem('current_account_id')
  localStorage.removeItem('saved_account_form')
  localStorage.removeItem('saved_email')
  try {
    sessionStorage.removeItem(ACTIVE_ACCOUNT_SESSION_KEY)
  } catch {
    // ignore
  }
  notifyAccountSessionChanged(null)
}

export function getActiveAccountSessionId() {
  try {
    const id = sessionStorage.getItem(ACTIVE_ACCOUNT_SESSION_KEY)
    return id ? id.toString() : null
  } catch {
    return null
  }
}
