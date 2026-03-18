import { useState, useRef, useCallback } from 'react'
import ComposeEditor from './ComposeEditor.jsx'
import './ComposeView.css'

export default function ComposeView({ initialDraft, onSend, onDiscard, accountEmail }) {
    const [to, setTo] = useState(initialDraft?.to || '')
    const [cc, setCc] = useState(initialDraft?.cc || '')
    const [bcc, setBcc] = useState(initialDraft?.bcc || '')
    const [subject, setSubject] = useState(initialDraft?.subject || '')
    const [showCc, setShowCc] = useState(!!(initialDraft?.cc))
    const [showBcc, setShowBcc] = useState(!!(initialDraft?.bcc))
    const [sending, setSending] = useState(false)
    const editorAreaRef = useRef(null)
    const htmlBodyRef = useRef(initialDraft?.htmlBody || '')

    const handleEditorChange = useCallback((html) => {
        htmlBodyRef.current = html
    }, [])

    const handleSend = useCallback(async () => {
        if (!to.trim()) return
        setSending(true)
        try {
            await onSend?.({
                to: to.split(',').map((s) => s.trim()).filter(Boolean),
                cc: cc.split(',').map((s) => s.trim()).filter(Boolean),
                bcc: bcc.split(',').map((s) => s.trim()).filter(Boolean),
                subject,
                htmlBody: htmlBodyRef.current,
                from: accountEmail || '',
            })
        } finally {
            setSending(false)
        }
    }, [to, cc, bcc, subject, onSend, accountEmail])

    const handleDiscard = useCallback(() => {
        onDiscard?.()
    }, [onDiscard])

    return (
        <div className="compose-view">
            {/* Header fields */}
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
                        value={to}
                        onChange={(e) => setTo(e.target.value)}
                    />
                    {!showCc && (
                        <button type="button" className="cv-toggle-btn" onClick={() => setShowCc(true)}>CC</button>
                    )}
                    {!showBcc && (
                        <button type="button" className="cv-toggle-btn" onClick={() => setShowBcc(true)}>BCC</button>
                    )}
                </div>
                {showCc && (
                    <div className="cv-field">
                        <label className="cv-label">CC</label>
                        <input
                            className="cv-input"
                            type="text"
                            placeholder="cc@example.com"
                            value={cc}
                            onChange={(e) => setCc(e.target.value)}
                        />
                    </div>
                )}
                {showBcc && (
                    <div className="cv-field">
                        <label className="cv-label">BCC</label>
                        <input
                            className="cv-input"
                            type="text"
                            placeholder="bcc@example.com"
                            value={bcc}
                            onChange={(e) => setBcc(e.target.value)}
                        />
                    </div>
                )}
                <div className="cv-field">
                    <label className="cv-label">Subject</label>
                    <input
                        className="cv-input"
                        type="text"
                        placeholder="Subject"
                        value={subject}
                        onChange={(e) => setSubject(e.target.value)}
                    />
                </div>
            </div>

            {/* Editor */}
            <div className="cv-editor-wrap" ref={editorAreaRef}>
                <ComposeEditor
                    initialContent={initialDraft?.htmlBody || ''}
                    onChange={handleEditorChange}
                />
            </div>

            {/* Actions */}
            <div className="cv-actions">
                <button
                    type="button"
                    className="cv-send-btn"
                    onClick={handleSend}
                    disabled={sending || !to.trim()}
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
