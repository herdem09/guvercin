import { useRef, useCallback } from 'react'
import ComposeEditor from './ComposeEditor.jsx'
import './ComposeView.css'

export default function ComposeView({ draft, onDraftChange, onSend, onDiscard, accountEmail, sending = false }) {
    const editorAreaRef = useRef(null)
    const patchDraft = useCallback((patch) => {
        onDraftChange?.({ ...draft, ...patch })
    }, [draft, onDraftChange])

    const handleEditorChange = useCallback((html) => {
        patchDraft({ htmlBody: html })
    }, [patchDraft])

    const handleSend = useCallback(async () => {
        if (!draft?.to?.trim()) return
        await onSend?.({
            ...draft,
            from: accountEmail || '',
        })
    }, [accountEmail, draft, onSend])

    const handleDiscard = useCallback(() => {
        onDiscard?.()
    }, [onDiscard])

    return (
        <div className="compose-view">
            <div className="cv-header">
                <div className="cv-field">
                    <label className="cv-label">From</label>
                    <div className="cv-from-value">{accountEmail || '—'}</div>
                </div>
                <div className="cv-field">
                    <label className="cv-label">To</label>
                    <input
                        className="cv-input"
                        type="text"
                        placeholder="recipient@example.com"
                        value={draft?.to || ''}
                        onChange={(e) => patchDraft({ to: e.target.value })}
                    />
                    {!draft?.showCc && (
                        <button type="button" className="cv-toggle-btn" onClick={() => patchDraft({ showCc: true })}>CC</button>
                    )}
                    {!draft?.showBcc && (
                        <button type="button" className="cv-toggle-btn" onClick={() => patchDraft({ showBcc: true })}>BCC</button>
                    )}
                </div>
                {draft?.showCc && (
                    <div className="cv-field">
                        <label className="cv-label">CC</label>
                        <input
                            className="cv-input"
                            type="text"
                            placeholder="cc@example.com"
                            value={draft?.cc || ''}
                            onChange={(e) => patchDraft({ cc: e.target.value })}
                        />
                    </div>
                )}
                {draft?.showBcc && (
                    <div className="cv-field">
                        <label className="cv-label">BCC</label>
                        <input
                            className="cv-input"
                            type="text"
                            placeholder="bcc@example.com"
                            value={draft?.bcc || ''}
                            onChange={(e) => patchDraft({ bcc: e.target.value })}
                        />
                    </div>
                )}
                <div className="cv-field">
                    <label className="cv-label">Subject</label>
                    <input
                        className="cv-input"
                        type="text"
                        placeholder="Subject"
                        value={draft?.subject || ''}
                        onChange={(e) => patchDraft({ subject: e.target.value })}
                    />
                </div>
            </div>

            <div className="cv-editor-wrap" ref={editorAreaRef}>
                <ComposeEditor
                    initialContent={draft?.htmlBody || ''}
                    onChange={handleEditorChange}
                />
            </div>

            <div className="cv-actions">
                <button
                    type="button"
                    className="cv-send-btn"
                    onClick={handleSend}
                    disabled={sending || !draft?.to?.trim()}
                >
                    {sending ? '⏳ Sending...' : '📨 Send'}
                </button>
                <button
                    type="button"
                    className="cv-discard-btn"
                    onClick={handleDiscard}
                >
                    ✕ Discard
                </button>
            </div>
        </div>
    )
}
