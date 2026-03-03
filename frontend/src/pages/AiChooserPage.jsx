import { apiUrl } from '../utils/api'
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import './AiChooserPage.css'
import { hydrateAccountSession } from '../utils/accountStorage.js'

function AiChooserPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()
    const [apiForm, setApiForm] = useState({
        apiKey: '',
        modelName: '',
        baseUrl: '',
    })

    const [localForm, setLocalForm] = useState({
        serverUrl: '',
        modelName: '',
        contextWindow: '',
    })

    const submitAiConfig = async (payload) => {
        try {
            const formData = JSON.parse(localStorage.getItem('temp_account_form') || '{}')
            const language = localStorage.getItem('temp_language') || 'en'
            const font = localStorage.getItem('temp_font') || 'Arial'

            const finalPayload = {
                account: formData,
                language,
                font,
                ai: payload
            }

            const response = await fetch(apiUrl('/api/account/finalize'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(finalPayload),
            })

            const result = await response.json()

            if (response.ok) {
            hydrateAccountSession({
                account_id: result.account_id,
                email_address: formData.email,
                display_name: formData.displayName,
                imap_host: formData.imapServer,
                imap_port: formData.imapPort,
                smtp_host: formData.smtpServer,
                smtp_port: formData.smtpPort,
                language,
                font,
            })

            alert(t('All processes completed successfully, account and AI settings saved!'))
            navigate('/dashboard')
        } else {
            alert(t('Error:') + ' ' + result.message)
        }
        } catch (error) {
            console.error('Error saving account and AI config:', error)
            alert(t('An error occurred during saving.'))
        }
    }

    const handleApiSubmit = async (e) => {
        e.preventDefault()
        await submitAiConfig({
            type: false,
            api_key_server_url: apiForm.apiKey,
            model_name: apiForm.modelName,
            base_url_context_window: apiForm.baseUrl,
        })
    }

    const handleLocalSubmit = async (e) => {
        e.preventDefault()
        await submitAiConfig({
            type: true,
            api_key_server_url: localForm.serverUrl,
            model_name: localForm.modelName,
            base_url_context_window: localForm.contextWindow,
        })
    }

    const handleSkip = async () => {
        await submitAiConfig(null)
    }

    return (
        <div className="ai-chooser-page">
            <h2 className="main-title">{t('Choose and Configure Your AI Server')}</h2>

            <div className="form-container split-container">
                <div className="split-column left-column">
                    <h3>{t('AI API')}</h3>
                    <form onSubmit={handleApiSubmit}>
                        <div className="input-group">
                            <label htmlFor="apiKey">{t('API Key')}</label>
                            <input
                                type="text"
                                id="apiKey"
                                name="apiKey"
                                required
                                value={apiForm.apiKey}
                                onChange={(e) => setApiForm({ ...apiForm, apiKey: e.target.value })}
                            />
                        </div>
                        <div className="input-group">
                            <label htmlFor="apiModelName">{t('Model Name')}</label>
                            <input
                                type="text"
                                id="apiModelName"
                                name="modelName"
                                required
                                value={apiForm.modelName}
                                onChange={(e) => setApiForm({ ...apiForm, modelName: e.target.value })}
                            />
                        </div>
                        <div className="input-group">
                            <label htmlFor="apiBaseUrl">{t('Base URL')}</label>
                            <input
                                type="text"
                                id="apiBaseUrl"
                                name="baseUrl"
                                required
                                value={apiForm.baseUrl}
                                onChange={(e) => setApiForm({ ...apiForm, baseUrl: e.target.value })}
                            />
                        </div>

                        <div className="spacer-flex" />

                        <button type="submit" className="submit-button primary-btn">
                            {t('Save and Continue')}
                        </button>
                    </form>
                </div>

                <div className="vertical-divider" />

                <div className="split-column right-column">
                    <h3>{t('Local AI')}</h3>
                    <form onSubmit={handleLocalSubmit}>
                        <div className="input-group">
                            <label htmlFor="serverUrl">{t('Server URL')}</label>
                            <input
                                type="text"
                                id="serverUrl"
                                name="serverUrl"
                                required
                                value={localForm.serverUrl}
                                onChange={(e) => setLocalForm({ ...localForm, serverUrl: e.target.value })}
                            />
                        </div>
                        <div className="input-group">
                            <label htmlFor="localModelName">{t('Model Name')}</label>
                            <input
                                type="text"
                                id="localModelName"
                                name="localModelName"
                                required
                                value={localForm.modelName}
                                onChange={(e) => setLocalForm({ ...localForm, modelName: e.target.value })}
                            />
                        </div>
                        <div className="input-group">
                            <label htmlFor="contextWindow">{t('Context Window')}</label>
                            <input
                                type="text"
                                id="contextWindow"
                                name="contextWindow"
                                required
                                value={localForm.contextWindow}
                                onChange={(e) => setLocalForm({ ...localForm, contextWindow: e.target.value })}
                            />
                        </div>

                        <div className="spacer-flex" />

                        <p className="warning-text">
                            {t('Running large models may slow down your computer')}
                        </p>

                        <div className="button-group">
                            <button type="submit" className="submit-button primary-btn">
                                {t('Save and Continue')}
                            </button>
                            <button
                                type="button"
                                className="skip-button shortcut-button"
                                onClick={handleSkip}
                            >
                                {t('Skip for now')}
                            </button>
                        </div>
                    </form>
                </div>
            </div>
        </div>
    )
}

export default AiChooserPage
