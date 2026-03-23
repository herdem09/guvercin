import { useCallback, useEffect, useRef, useState } from 'react'
import { apiUrl } from '../utils/api'
import ComposeMailContent from '../components/ComposeMailContent.jsx'
import {
    buildDraftSavePayload,
    isComposeDraftDirty,
    isComposeDraftModified,
    normalizeComposeDraft,
    parseComposeBody,
} from '../utils/compose.js'
import './DashboardPage.css'

function safeParse(json) {
    try {
        return JSON.parse(json)
    } catch {
        return null
    }
}

function getDetachedLabelHint() {
    try {
        const hint = typeof window !== 'undefined' ? window.__GUV_DETACHED__ : null
        return typeof hint?.label === 'string' ? hint.label : ''
    } catch {
        return ''
    }
}

export default function DetachedComposeWindow({ initialLabel = '' } = {}) {
    const [windowLabel, setWindowLabel] = useState(() => initialLabel || getDetachedLabelHint())
    const [data, setData] = useState(null)
    const [baselineDraft, setBaselineDraft] = useState(() => normalizeComposeDraft())
    const [draft, setDraft] = useState(() => normalizeComposeDraft())
    const [sending, setSending] = useState(false)
    const [sent, setSent] = useState(false)
    const [pendingSend, setPendingSend] = useState(null)
    const [noticeNow, setNoticeNow] = useState(Date.now())
    const [exitPromptOpen, setExitPromptOpen] = useState(false)
    const [actionBusy, setActionBusy] = useState(false)
    const sendTimeoutRef = useRef(null)

    const accountId = data?.accountId
    const accountEmail = data?.accountEmail || ''

    useEffect(() => {
        document.body.style.padding = '0'
        document.body.style.margin = '0'
        document.body.style.overflow = 'hidden'

        if (windowLabel) {
            return () => {
                document.body.style.padding = ''
                document.body.style.margin = ''
                document.body.style.overflow = ''
            }
        }

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
    }, [windowLabel])

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
        const nextBaseline = normalizeComposeDraft(data?.baselineDraft ?? data?.draft)
        setBaselineDraft(nextBaseline)
        setDraft(normalizeComposeDraft(data?.draft))
    }, [data])

    useEffect(() => () => {
        if (sendTimeoutRef.current) {
            window.clearTimeout(sendTimeoutRef.current)
        }
    }, [])

    useEffect(() => {
        if (!pendingSend) return undefined
        const intervalId = window.setInterval(() => {
            setNoticeNow(Date.now())
        }, 100)
        return () => window.clearInterval(intervalId)
    }, [pendingSend])

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

    const queueOfflineAction = useCallback(async (actionType, payload, targetUid = null, targetFolder = null) => {
        if (!accountId) return null
        const response = await fetch(apiUrl(`/api/offline/${accountId}/actions`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                action_type: actionType,
                target_uid: targetUid,
                target_folder: targetFolder,
                payload,
            }),
        })

        if (!response.ok) {
            const errorBody = await response.json().catch(() => null)
            throw new Error(errorBody?.error || errorBody?.message || `Failed to queue ${actionType}`)
        }

        return response.json().catch(() => null)
    }, [accountId])

    const handleSendNow = useCallback(async (composed) => {
        if (!accountId) return
        try {
            setSending(true)
            const normalized = normalizeComposeDraft(composed)
            const payload = parseComposeBody(normalized, accountEmail)
            const recipientCount = payload.to.length + payload.cc.length + payload.bcc.length
            if (recipientCount === 0) {
                window.alert('Please add at least one recipient.')
                return false
            }

            const hasForwardTargets = Array.isArray(normalized?.forwardTargets) && normalized.forwardTargets.length > 0
            if (hasForwardTargets) {
                const subjectPrefix = normalized?.forwardOptions?.subjectPrefix || 'Fwd:'
                const forwardPayload = {
                    to: payload.to,
                    cc: payload.cc,
                    bcc: payload.bcc,
                    subject_prefix: subjectPrefix,
                }
                await Promise.all(normalized.forwardTargets.map((target) => (
                    queueOfflineAction('forward', forwardPayload, target.uid, target.mailbox)
                )))
            } else {
                await queueOfflineAction('send', payload, `compose-${Date.now()}`, 'Sent')
            }

            setPendingSend(null)
            setSent(true)
            setTimeout(() => closeWindow(), 1500)
            return true
        } catch (error) {
            console.error('Failed to queue send action:', error)
            window.alert('Failed to send email: ' + (error?.message || 'Unknown error'))
            return false
        } finally {
            setSending(false)
        }
    }, [accountId, accountEmail, closeWindow, queueOfflineAction])

    const handleSaveDraft = useCallback(async (composed) => {
        const payload = buildDraftSavePayload(composed, accountEmail)
        const response = await queueOfflineAction('save_draft', payload, payload.draft_id, 'Drafts')
        return response?.draft_id || payload.draft_id || null
    }, [accountEmail, queueOfflineAction])

    const clearPendingSend = useCallback(() => {
        if (sendTimeoutRef.current) {
            window.clearTimeout(sendTimeoutRef.current)
            sendTimeoutRef.current = null
        }
        setPendingSend(null)
    }, [])

    const startDelayedSend = useCallback((composed) => {
        try {
            const normalized = normalizeComposeDraft(composed)
            const payload = parseComposeBody(normalized, accountEmail)
            if (payload.to.length + payload.cc.length + payload.bcc.length === 0) {
                window.alert('Please add at least one recipient.')
                return false
            }

            clearPendingSend()
            const durationMs = 10_000
            const nextPending = {
                draft: normalized,
                durationMs,
                expiresAt: Date.now() + durationMs,
            }
            setDraft(normalized)
            setNoticeNow(Date.now())
            setPendingSend(nextPending)
            sendTimeoutRef.current = window.setTimeout(() => {
                sendTimeoutRef.current = null
                void handleSendNow(normalized)
            }, durationMs)
            return true
        } catch (error) {
            console.error('Failed to schedule send:', error)
            window.alert(error?.message || 'Failed to schedule send.')
            return false
        }
    }, [accountEmail, clearPendingSend, handleSendNow])

    const handleSend = useCallback((composed) => {
        startDelayedSend(composed)
    }, [startDelayedSend])

    const handleDiscard = useCallback(() => {
        const hasMeaningfulChanges = data?.baselineDraft
            ? isComposeDraftModified(draft, baselineDraft)
            : isComposeDraftDirty(draft)
        if (!hasMeaningfulChanges) {
            closeWindow()
            return
        }
        setExitPromptOpen(true)
    }, [baselineDraft, closeWindow, data?.baselineDraft, draft])

    const handleExitAction = useCallback(async (action) => {
        if (action === 'cancel') {
            setActionBusy(false)
            setExitPromptOpen(false)
            return
        }

        setActionBusy(true)
        try {
            if (action === 'send') {
                const queued = startDelayedSend(draft)
                if (queued) {
                    setExitPromptOpen(false)
                }
                return
            }

            if (action === 'discard') {
                await closeWindow()
                return
            }

            if (action === 'save') {
                await handleSaveDraft(draft)
                await closeWindow()
            }
        } catch (error) {
            console.error('Failed to finish compose exit action:', error)
            window.alert(error?.message || 'Failed to complete compose action.')
        } finally {
            setActionBusy(false)
        }
    }, [closeWindow, draft, handleSaveDraft, startDelayedSend])

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
                {pendingSend ? (
                    <div className="db-section-area" style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                        <div className="db-empty-state">
                            <div className="db-empty-icon">✉️</div>
                            <div className="db-empty-text">Mail will be sent in 10 seconds.</div>
                        </div>
                    </div>
                ) : (
                    <ComposeMailContent
                        draft={draft}
                        onDraftChange={setDraft}
                        onSend={handleSend}
                        onDiscard={handleDiscard}
                        accountEmail={accountEmail}
                        sending={sending}
                    />
                )}
            </div>
            {pendingSend && (
                <div className="db-action-notices" aria-live="polite">
                    <div className="db-action-notice db-action-notice--warning">
                        <div className="db-action-notice__body">
                            <span className="db-action-notice__text">Mail will be sent in 10 seconds</span>
                            <div className="db-action-notice__actions">
                                <button type="button" className="db-action-notice__commit" onClick={() => handleSendNow(pendingSend.draft)}>
                                    Send now
                                </button>
                                <button type="button" className="db-action-notice__undo" onClick={clearPendingSend}>
                                    Undo
                                </button>
                            </div>
                        </div>
                        <div className="db-action-notice__progress">
                            <span
                                className="db-action-notice__progress-bar"
                                style={{
                                    width: `${Math.max(0, ((pendingSend.expiresAt - noticeNow) / pendingSend.durationMs) * 100)}%`,
                                }}
                            />
                        </div>
                    </div>
                </div>
            )}
            {exitPromptOpen && (
                <div className="db-advanced-search-modal" onMouseDown={() => handleExitAction('cancel')}>
                    <div
                        className="db-compose-exit-panel"
                        onMouseDown={(event) => event.stopPropagation()}
                        role="dialog"
                        aria-modal="true"
                        aria-label="Leave message"
                    >
                        <div className="db-compose-exit-panel__header">
                            <div className="db-compose-exit-panel__title">Do you want to leave this message?</div>
                            <button
                                type="button"
                                className="db-advanced-search-panel__close"
                                onClick={() => handleExitAction('cancel')}
                                aria-label="Close"
                                title="Close"
                            >
                                ✕
                            </button>
                        </div>
                        <div className="db-compose-exit-panel__body">This message has unsaved changes.</div>
                        <div className="db-compose-exit-panel__actions">
                            <button
                                type="button"
                                className="db-advanced-search-btn db-compose-exit-panel__btn db-compose-exit-panel__btn--send"
                                onClick={() => handleExitAction('send')}
                                disabled={actionBusy}
                            >
                                {actionBusy ? 'Working...' : 'Send'}
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary db-compose-exit-panel__btn"
                                onClick={() => handleExitAction('discard')}
                                disabled={actionBusy}
                            >
                                Discard
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-advanced-search-btn--secondary db-compose-exit-panel__btn"
                                onClick={() => handleExitAction('cancel')}
                                disabled={actionBusy}
                            >
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="db-advanced-search-btn db-compose-exit-panel__btn db-compose-exit-panel__btn--save"
                                onClick={() => handleExitAction('save')}
                                disabled={actionBusy}
                            >
                                Save to Drafts
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}
