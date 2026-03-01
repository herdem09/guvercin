import { useLocation, useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import './NotAuthPage.css'

function NotAuthPage() {
    const { t } = useTranslation()
    const location = useLocation()
    const navigate = useNavigate()
    const state = location.state || {}

    const {
        formData = {},
        errorMessage = t('Authorization failed.'),
    } = state

    const handleCreateAnyway = async () => {
        const urlParams = new URLSearchParams()
        urlParams.append('EMAIL_ADDRESS', formData.email || '')
        urlParams.append('DISPLAY_NAME', formData.displayName || '')
        urlParams.append('IMAP_SERVER', formData.imapServer || '')
        urlParams.append('IMAP_PORT', formData.imapPort || '')
        urlParams.append('SMTP_SERVER', formData.smtpServer || '')
        urlParams.append('SMTP_PORT', formData.smtpPort || '')
        urlParams.append('PASSWORD', formData.password || '')
        urlParams.append('SKIP_AUTH', 'true')

        try {
            const response = await fetch('/api/auth/setup', {
                method: 'POST',
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
                body: urlParams.toString(),
            })

            const json = await response.json()

            if (response.ok) {
                if (json.account_id) {
                    localStorage.setItem('current_account_id', json.account_id)
                }
                navigate('/language')
            } else {
                alert(t('Error:') + ' ' + (json.message || t('Unknown error')))
            }
        } catch (error) {
            console.error('Error creating account:', error)
            alert(t('An error occurred while creating the account.'))
        }
    }

    return (
        <div className="not-auth-page">
            <div className="not-auth-container">
                <h1>{t("Couldn't authorize your credentials")}</h1>
                <p className="message">{errorMessage}</p>
                <p className="prompt">
                    {t('Would you still like to create the account, or go back to correct the details?')}
                </p>

                <button className="btn create" onClick={handleCreateAnyway}>
                    {t('Create Account Anyway')}
                </button>
                <button className="btn back" onClick={() => navigate('/login')}>
                    {t('Back to Login')}
                </button>
            </div>
        </div>
    )
}

export default NotAuthPage
