import { apiUrl } from '../utils/api'
import { useState, useEffect, useCallback } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { hydrateAccountSession } from '../utils/accountStorage.js'
import './LoginPage.css'

const ACCOUNT_FORM_DRAFT_KEY = 'temp_account_form_draft'

function safeParseJson(raw, fallback) {
    try {
        return JSON.parse(raw)
    } catch {
        return fallback
    }
}

function LoginPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const location = useLocation()
    const [loading, setLoading] = useState(false)
    const [loadingText] = useState(t('Testing Connection and Authentication...'))
    const [responseMessage, setResponseMessage] = useState(null)
    const [accounts, setAccounts] = useState([])
    const [showAccounts, setShowAccounts] = useState(false)

    const [formData, setFormData] = useState(() => {
        const defaults = {
            email: '',
            displayName: '',
            imapServer: '',
            imapPort: '',
            smtpServer: '',
            smtpPort: '',
            password: '',
            sslMode: 'STARTTLS',
        }

        const fromState = location?.state?.formData
        if (fromState && typeof fromState === 'object') {
            return { ...defaults, ...fromState }
        }

        const rawDraft = localStorage.getItem(ACCOUNT_FORM_DRAFT_KEY)
        const draft = rawDraft ? safeParseJson(rawDraft, null) : null
        if (draft && typeof draft === 'object') {
            return { ...defaults, ...draft }
        }

        return defaults
    })

    const persistDraft = useCallback((next) => {
        try {
            localStorage.setItem(ACCOUNT_FORM_DRAFT_KEY, JSON.stringify(next))
        } catch {
            // Ignore storage failures.
        }
    }, [])

    const clearDraft = useCallback(() => {
        try {
            localStorage.removeItem(ACCOUNT_FORM_DRAFT_KEY)
        } catch {
            // Ignore storage failures.
        }
    }, [])

    const loadRegisteredAccounts = useCallback(async () => {
        try {
            const response = await fetch(apiUrl('/api/auth/accounts'))
            const data = await response.json()

            if (data.accounts && data.accounts.length > 0) {
                setAccounts(data.accounts)
                setShowAccounts(true)
            } else {
                setShowAccounts(false)
            }
        } catch (error) {
            console.error('Error loading accounts:', error)
            setShowAccounts(false)
        }
    }, [])

    useEffect(() => {
        loadRegisteredAccounts()
    }, [loadRegisteredAccounts])

    const handleAccountClick = (account) => {
        const next = {
            email: account.email_address || '',
            displayName: account.display_name || '',
            imapServer: account.imap_host || '',
            imapPort: account.imap_port || '',
            smtpServer: account.smtp_host || '',
            smtpPort: account.smtp_port || '',
            password: '',
            sslMode: account.ssl_mode || 'STARTTLS',
        }
        setFormData(next)
        persistDraft(next)
    }

    const handleRegisteredAccountOpen = (account) => {
        hydrateAccountSession(account)
        clearDraft()
        navigate('/dashboard')
    }

    const handleInputChange = (e) => {
        const { name, value } = e.target
        setFormData((prev) => {
            const next = { ...prev, [name]: value }
            persistDraft(next)
            return next
        })
    }

    const handleSubmit = async (e) => {
        e.preventDefault()
        setResponseMessage(null)
        setLoading(true)
        persistDraft(formData)

        const urlParams = new URLSearchParams()
        urlParams.append('EMAIL_ADDRESS', formData.email)
        urlParams.append('DISPLAY_NAME', formData.displayName)
        urlParams.append('IMAP_SERVER', formData.imapServer)
        urlParams.append('IMAP_PORT', formData.imapPort)
        urlParams.append('SMTP_SERVER', formData.smtpServer)
        urlParams.append('SMTP_PORT', formData.smtpPort)
        urlParams.append('PASSWORD', formData.password)
        urlParams.append('SSL_MODE', formData.sslMode)

        try {
            const response = await fetch(apiUrl('/api/auth/setup'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: urlParams.toString(),
            })

            setLoading(false)

            const responseText = await response.text()
            let json = null

            try {
                json = JSON.parse(responseText)
            } catch {
                persistDraft(formData)
                navigate('/not_auth', {
                    state: {
                        formData,
                        errorMessage: t('Authorization failed. The server returned an error page.'),
                    },
                })
                return
            }

            if (!response.ok) {
                if (response.status === 409 && json.status === 'already_exists') {
                    setResponseMessage({ type: 'already-exists', text: json.message })
                    return
                }
                if (response.status === 401 && json.status === 'failure') {
                    persistDraft(json.formData || formData)
                    navigate('/not_auth', {
                        state: {
                            formData: json.formData || formData,
                            errorMessage: json.message,
                        }
                    })
                    return
                }
                throw json
            }

            setResponseMessage({ type: 'success', text: `✅ ${json.message}` })

            localStorage.setItem('temp_account_form', JSON.stringify(formData))
            clearDraft()

            setTimeout(() => {
                navigate('/language')
            }, 2000)
        } catch (error) {
            console.error('Error Details:', error)
            setLoading(false)

            let msg = t('An unknown error occurred. Please check the console logs.')

            if (error instanceof TypeError) {
                msg = t('Server could not be reached. The backend service (Flask) may not be running.')
            } else if (error.message) {
                msg = error.message
                if (msg.includes('record layer failure')) {
                    msg += ' — ' + t('Server Name, Port, or SSL Mode might be incorrect.')
                } else if (msg.includes('no such user')) {
                    msg += ' — ' + t('Your Email Address or Password is incorrect.')
                }
            }

            setResponseMessage({ type: 'error', text: `❌ ${msg}` })
        }
    }

    return (
        <div className="login-page">
            <div className="form-container">
                <h2>{t('Email Account Settings')}</h2>

                {loading && (
                    <div className="loading-overlay">
                        <div className="spinner" />
                        <p>{loadingText}</p>
                    </div>
                )}

                <form id="setupForm" onSubmit={handleSubmit}>
                    <div className="column-group">
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="email">{t('Email Address:')}</label>
                                <input
                                    type="email"
                                    id="email"
                                    name="email"
                                    placeholder="herdem09@proton.me"
                                    required
                                    value={formData.email}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="displayName">{t('Display Name:')}</label>
                                <input
                                    type="text"
                                    id="displayName"
                                    name="displayName"
                                    placeholder="Herdem"
                                    required
                                    value={formData.displayName}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="column-group">
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="imapServer">{t('IMAP Server:')}</label>
                                <input
                                    type="text"
                                    id="imapServer"
                                    name="imapServer"
                                    placeholder="127.0.0.1"
                                    required
                                    value={formData.imapServer}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="imapPort">{t('IMAP Port:')}</label>
                                <input
                                    type="number"
                                    id="imapPort"
                                    name="imapPort"
                                    placeholder="1143"
                                    step="1"
                                    required
                                    value={formData.imapPort}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="column-group">
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="smtpServer">{t('SMTP Server:')}</label>
                                <input
                                    type="text"
                                    id="smtpServer"
                                    name="smtpServer"
                                    placeholder="127.0.0.1"
                                    required
                                    value={formData.smtpServer}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                        <div className="column">
                            <div className="input-group">
                                <label htmlFor="smtpPort">{t('SMTP Port:')}</label>
                                <input
                                    type="number"
                                    id="smtpPort"
                                    name="smtpPort"
                                    placeholder="1025"
                                    step="1"
                                    required
                                    value={formData.smtpPort}
                                    onChange={handleInputChange}
                                />
                            </div>
                        </div>
                    </div>

                    <div className="input-group">
                        <label htmlFor="password">{t('Password:')}</label>
                        <input
                            type="password"
                            id="password"
                            name="password"
                            placeholder="••••••••••"
                            required
                            value={formData.password}
                            onChange={handleInputChange}
                        />
                    </div>

                    <div className="input-group">
                        <label>{t('Connection Encryption Mode:')}</label>
                        <div className="radio-group">
                            {['STARTTLS', 'SSL', 'NONE'].map((mode) => (
                                <label key={mode} className="radio-label">
                                    <input
                                        type="radio"
                                        name="sslMode"
                                        value={mode}
                                        checked={formData.sslMode === mode}
                                        onChange={handleInputChange}
                                    />
                                    {mode === 'SSL' ? 'SSL/TLS' : mode}
                                </label>
                            ))}
                        </div>
                    </div>

                    {responseMessage && (
                        <div className={`response-message ${responseMessage.type}-message`}>
                            {responseMessage.type === 'already-exists' ? (
                                <div className="already-exists-message">{responseMessage.text}</div>
                            ) : (
                                responseMessage.text
                            )}
                        </div>
                    )}

                    <button type="submit" id="submitButton" disabled={loading}>
                        {t('Save Settings and Test')}
                    </button>
                </form>

                <button type="button" className="shortcut-button" id="googleOauthButton">
                    <img src="/icon-google.png" alt="Google Icon" className="button-icon" />
                    {t('Continue with Google')}
                </button>
                <button type="button" className="shortcut-button" id="microsoftOauthButton">
                    <img src="/icon-microsoft.png" alt="Microsoft Icon" className="button-icon" />
                    {t('Continue with Microsoft')}
                </button>
            </div>

            {showAccounts && (
                <div className="registered-accounts-container" id="registeredAccountsContainer">
                    <div className="container-header">
                        <h3>{t('Registered Accounts')}</h3>
                        <button
                            type="button"
                            className="settings-btn"
                            title="Settings"
                            onClick={() => alert(t('Settings module will be added soon.'))}
                        >
                            ⚙️
                        </button>
                    </div>
                    <div className="accounts-list">
                        {accounts.map((account) => (
                            <div
                                key={account.account_id}
                                className="account-item clickable"
                                onClick={() => handleRegisteredAccountOpen(account)}
                            >
                                <strong>{account.display_name}</strong>
                                <span>{account.email_address}</span>
                            </div>
                        ))}
                    </div>
                </div>
            )}
        </div>
    )
}

export default LoginPage
