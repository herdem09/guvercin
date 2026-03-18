import { useCallback, useEffect, useState } from 'react'
import { apiUrl } from '../utils/api'
import ComposeMailContent from '../components/ComposeMailContent.jsx'
import { normalizeComposeDraft, parseComposeRecipients } from '../utils/compose.js'
import './DashboardPage.css'

function safeParse(json) {
    try {
        return JSON.parse(json)
    } catch {
        return null
    }
}

export default function DetachedComposeWindow() {
    const [windowLabel, setWindowLabel] = useState('')
    const [data, setData] = useState(null)
    const [draft, setDraft] = useState(() => normalizeComposeDraft())
    const [sending, setSending] = useState(false)
    const [sent, setSent] = useState(false)

    const accountId = data?.accountId
    const accountEmail = data?.accountEmail || ''

    useEffect(() => {
        document.body.style.padding = '0'
        document.body.style.margin = '0'
        document.body.style.overflow = 'hidden'

        let active = true
        const detect = async () => {
            try {
                const { getCurrentWebviewWindow } = await import('@tauri-apps/api/webviewWindow')
                const label = getCurrentWebviewWindow().label
                if (active) setWindowLabel(label)
            } catch {
                /* browser fallback */
            }
        }
        detect()
        return () => {
            active = false
            document.body.style.padding = ''
            document.body.style.margin = ''
            document.body.style.overflow = ''
        }
    }, [])

    useEffect(() => {
        if (!windowLabel) return
        let active = true
        const load = async () => {
            try {
                const { invoke } = await import('@tauri-apps/api/core')
                const json = await invoke('get_compose_window_data', { label: windowLabel })
                if (active && json) {
                    setData(safeParse(json))
                }
            } catch {
                /* fallback: try localStorage */
                const stored = localStorage.getItem(`compose_data_${windowLabel}`)
                if (active && stored) {
                    setData(safeParse(stored))
                }
            }
        }
        load()
        return () => { active = false }
    }, [windowLabel])

    useEffect(() => {
        setDraft(normalizeComposeDraft(data?.draft))
    }, [data])

    const closeWindow = useCallback(async () => {
        try {
            const { invoke } = await import('@tauri-apps/api/core')
            if (windowLabel) {
                await invoke('close_compose_window', { label: windowLabel })
                return
            }
        } catch {
            /* fallback */
        }
        window.close()
    }, [windowLabel])

    const handleSend = useCallback(async (composed) => {
        if (!accountId) return
        try {
            setSending(true)
            const htmlBody = composed?.htmlBody || ''
            const plainBody = (() => {
                if (!htmlBody) return composed?.body?.trim() || ''
                const tmp = document.createElement('div')
                tmp.innerHTML = htmlBody
                const normalized = (tmp.textContent || tmp.innerText || '').trim()
                return normalized || composed?.body?.trim() || ''
            })()
            await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action_type: 'send',
                    target_uid: `compose-${Date.now()}`,
                    target_folder: 'Sent',
                    payload: {
                        from: composed.from || accountEmail,
                        to: parseComposeRecipients(composed.to),
                        cc: parseComposeRecipients(composed.cc),
                        bcc: parseComposeRecipients(composed.bcc),
                        subject: composed.subject,
                        html_body: htmlBody,
                        body: plainBody,
                    },
                }),
            })
            setSent(true)
            setTimeout(() => closeWindow(), 1500)
        } catch (error) {
            console.error('Failed to queue send action:', error)
            window.alert('Failed to send email: ' + (error?.message || 'Unknown error'))
        } finally {
            setSending(false)
        }
    }, [accountId, accountEmail, closeWindow])

    const handleDiscard = useCallback(() => {
        closeWindow()
    }, [closeWindow])

    if (sent) {
        return (
            <div className="dashboard-page" style={{ height: '100vh' }}>
                <div className="db-section-area" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="db-empty-state">
                        <div className="db-empty-icon">✅</div>
                        <div className="db-empty-text">Mail sent successfully!</div>
                    </div>
                </div>
            </div>
        )
    }

    if (!data) {
        return (
            <div className="dashboard-page" style={{ height: '100vh' }}>
                <div className="db-section-area" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                    <div className="db-loading">
                        <div className="db-spinner" />
                        Loading compose data...
                    </div>
                </div>
            </div>
        )
    }

    return (
        <div className="dashboard-page" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ComposeMailContent
                    draft={draft}
                    onDraftChange={setDraft}
                    onSend={handleSend}
                    onDiscard={handleDiscard}
                    accountEmail={accountEmail}
                    sending={sending}
                />
            </div>
        </div>
    )
}
