const DEFAULT_LANGUAGE = 'en'
const DEFAULT_FONT = 'Arial'

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
  localStorage.removeItem('temp_language')
  localStorage.removeItem('temp_font')
  localStorage.removeItem('temp_theme_mode')
  localStorage.removeItem('temp_theme_name')
  localStorage.removeItem('temp_offline_config')
}
