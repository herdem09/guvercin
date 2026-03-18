import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import Editor from '@monaco-editor/react'
import { buildComposePreviewDocument, escapeHtml } from '../utils/composeHtml.js'
import { composeRecipientsToString, ensureHtmlDraftSeed } from '../utils/compose.js'
import './ComposeView.css'

function createClientId(prefix) {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
        return `${prefix}-${crypto.randomUUID()}`
    }
    return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

function readFileAsBase64(file) {
    return new Promise((resolve, reject) => {
        const reader = new FileReader()
        reader.onload = () => {
            const result = typeof reader.result === 'string' ? reader.result : ''
            const base64 = result.includes(',') ? result.split(',')[1] : result
            resolve(base64)
        }
        reader.onerror = () => reject(reader.error || new Error('File could not be read'))
        reader.readAsDataURL(file)
    })
}

function splitRecipientDraft(value) {
    return `${value || ''}`.split(/[,\n;]+/).map((part) => part.trim()).filter(Boolean)
}

function SegmentSwitch({ value, options, onChange }) {
    return (
        <div className="cv-segment" role="tablist">
            {options.map((option) => (
                <button
                    key={option.value}
                    type="button"
                    className={`cv-segment__item ${value === option.value ? 'is-active' : ''}`}
                    onClick={() => onChange(option.value)}
                >
                    {option.label}
                </button>
            ))}
        </div>
    )
}

function ComposeAttachmentList({ attachments, onRemove }) {
    if (attachments.length === 0) return null

    return (
        <div className="cv-attachments">
            <div className="cv-attachments__header">Attachments</div>
            <div className="cv-attachments__list">
                {attachments.map((attachment) => (
                    <div key={attachment.id} className="cv-attachments__item">
                        <div className="cv-attachments__meta">
                            <div className="cv-attachments__name">{attachment.name}</div>
                            <div className="cv-attachments__details">
                                {attachment.mimeType} · {attachment.size || 0} B
                            </div>
                        </div>
                        <button
                            type="button"
                            className="cv-attachments__remove"
                            onClick={() => onRemove(attachment.id)}
                        >
                            Remove
                        </button>
                    </div>
                ))}
            </div>
        </div>
    )
}

function RecipientField({ label, recipients, onChange, placeholder, trailingActions = null }) {
    const [draftToken, setDraftToken] = useState('')
    const [editingIndex, setEditingIndex] = useState(null)
    const [hoveredIndex, setHoveredIndex] = useState(null)
    const inputRef = useRef(null)

    useEffect(() => {
        if (editingIndex != null && editingIndex >= recipients.length) {
            setEditingIndex(null)
            setDraftToken('')
        }
    }, [editingIndex, recipients.length])

    const focusInput = useCallback(() => {
        inputRef.current?.focus()
    }, [])

    const commitRecipients = useCallback((nextRecipients) => {
        onChange(nextRecipients)
    }, [onChange])

    const finalizeToken = useCallback((rawValue = draftToken) => {
        const parts = splitRecipientDraft(rawValue)
        if (parts.length === 0) {
            setDraftToken('')
            if (editingIndex != null) setEditingIndex(null)
            return
        }

        const nextRecipients = recipients.slice()
        if (editingIndex != null) {
            nextRecipients.splice(editingIndex, 1, parts[0])
            if (parts.length > 1) {
                nextRecipients.splice(editingIndex + 1, 0, ...parts.slice(1))
            }
        } else {
            nextRecipients.push(...parts)
        }

        commitRecipients(nextRecipients)
        setDraftToken('')
        setEditingIndex(null)
    }, [commitRecipients, draftToken, editingIndex, recipients])

    const handleKeyDown = useCallback((event) => {
        if (event.key === 'Enter' || event.key === 'Tab' || event.key === ',' || event.key === ';') {
            if (draftToken.trim()) {
                event.preventDefault()
                finalizeToken()
            }
            return
        }

        if (event.key === 'Backspace' && !draftToken) {
            event.preventDefault()
            if (editingIndex != null) {
                const previousIndex = editingIndex > 0 ? editingIndex - 1 : null
                if (previousIndex != null) {
                    setDraftToken(recipients[previousIndex] || '')
                    setEditingIndex(previousIndex)
                } else {
                    setEditingIndex(null)
                }
                return
            }

            const previousIndex = recipients.length - 1
            if (previousIndex >= 0) {
                const nextRecipients = recipients.slice(0, -1)
                const previousValue = recipients[previousIndex]
                commitRecipients(nextRecipients)
                setDraftToken(previousValue)
                setEditingIndex(previousIndex)
            }
        }
    }, [commitRecipients, draftToken, editingIndex, finalizeToken, recipients])

    const handleChange = useCallback((event) => {
        const nextValue = event.target.value
        if (/[,\n;]$/.test(nextValue) || /\s$/.test(nextValue)) {
            finalizeToken(nextValue)
            return
        }

        setDraftToken(nextValue)
    }, [finalizeToken])

    const handleBlur = useCallback(() => {
        if (draftToken.trim()) {
            finalizeToken()
        } else if (editingIndex != null) {
            setEditingIndex(null)
        }
    }, [draftToken, editingIndex, finalizeToken])

    const handleChipClick = useCallback((index) => {
        setDraftToken(recipients[index] || '')
        setEditingIndex(index)
        focusInput()
    }, [focusInput, recipients])

    const handleRemove = useCallback((index) => {
        const nextRecipients = recipients.filter((_, recipientIndex) => recipientIndex !== index)
        commitRecipients(nextRecipients)
        if (editingIndex === index) {
            setDraftToken('')
            setEditingIndex(null)
        }
        focusInput()
    }, [commitRecipients, editingIndex, focusInput, recipients])

    return (
        <div className="cv-field cv-field--recipients">
            <label className="cv-label">{label}</label>
            <div className="cv-recipient-wrap" onClick={focusInput}>
                <div className="cv-recipient-list">
                    {recipients.map((recipient, index) => (
                        <button
                            key={`${recipient}-${index}`}
                            type="button"
                            className={`cv-recipient-chip ${editingIndex === index ? 'is-editing' : ''}`}
                            onClick={() => handleChipClick(index)}
                            onMouseEnter={() => setHoveredIndex(index)}
                            onMouseLeave={() => setHoveredIndex((current) => (current === index ? null : current))}
                        >
                            <span className="cv-recipient-chip__label">{recipient}</span>
                            <span
                                className={`cv-recipient-chip__remove ${hoveredIndex === index ? 'is-visible' : ''}`}
                                onMouseDown={(event) => event.preventDefault()}
                                onClick={(event) => {
                                    event.stopPropagation()
                                    handleRemove(index)
                                }}
                            >
                                ×
                            </span>
                        </button>
                    ))}
                    <input
                        ref={inputRef}
                        className="cv-recipient-input"
                        type="text"
                        value={draftToken}
                        placeholder={recipients.length === 0 ? placeholder : ''}
                        onChange={handleChange}
                        onKeyDown={handleKeyDown}
                        onBlur={handleBlur}
                    />
                </div>
            </div>
            {trailingActions}
        </div>
    )
}

export default function ComposeView({ draft, onDraftChange, onSend, onDiscard, accountEmail, sending = false }) {
    const manualAttachments = (draft?.attachments || []).filter((attachment) => attachment.disposition !== 'inline')
    const fileInputRef = useRef(null)
    const inlineImageInputRef = useRef(null)
    const monacoRef = useRef(null)

    const patchDraft = useCallback((patch) => {
        if (!onDraftChange) return
        if (typeof patch === 'function') {
            onDraftChange((currentDraft) => patch(currentDraft || {}))
            return
        }
        onDraftChange((currentDraft) => ({ ...(currentDraft || {}), ...patch }))
    }, [onDraftChange])

    const patchRecipients = useCallback((field, recipients) => {
        const nextRecipients = recipients.map((entry) => `${entry || ''}`.trim()).filter(Boolean)
        const textValue = composeRecipientsToString(nextRecipients)
        const patch = { [`${field}Recipients`]: nextRecipients, [field]: textValue }

        if (field === 'cc') {
            patch.showCc = nextRecipients.length > 0 || draft?.showCc
        }
        if (field === 'bcc') {
            patch.showBcc = nextRecipients.length > 0 || draft?.showBcc
        }

        patchDraft(patch)
    }, [draft?.showBcc, draft?.showCc, patchDraft])

    const handleSend = useCallback(async () => {
        if ((draft?.toRecipients || []).length === 0) return
        await onSend?.({
            ...draft,
            from: accountEmail || '',
        })
    }, [accountEmail, draft, onSend])

    const previewDocument = useMemo(
        () => buildComposePreviewDocument(draft?.htmlBody || ''),
        [draft?.htmlBody],
    )

    const handleFormatChange = useCallback((nextFormat) => {
        if (nextFormat === 'html') {
            const seeded = ensureHtmlDraftSeed(draft)
            onDraftChange?.({
                ...seeded,
                format: 'html',
                htmlMode: seeded.htmlMode || 'edit',
            })
            return
        }

        patchDraft({ format: 'plain' })
    }, [draft, onDraftChange, patchDraft])

    const handleFilesSelected = useCallback(async (fileList, disposition) => {
        const files = Array.from(fileList || [])
        if (files.length === 0) return

        const prepared = await Promise.all(files.map(async (file) => {
            const base64 = await readFileAsBase64(file)
            const contentId = disposition === 'inline' ? createClientId('cid') : undefined
            return {
                id: createClientId('attachment'),
                name: file.name || 'attachment',
                mimeType: file.type || 'application/octet-stream',
                size: file.size || 0,
                base64,
                disposition,
                contentId,
                source: disposition === 'inline' ? 'html-inline' : 'manual',
            }
        }))

        if (disposition !== 'inline') {
            patchDraft((currentDraft) => ({
                ...currentDraft,
                attachments: [...(currentDraft?.attachments || []), ...prepared],
            }))
            return
        }

        const snippets = prepared
            .map((attachment) => `<img src="cid:${attachment.contentId}" alt="${escapeHtml(attachment.name)}">`)
            .join('\n')

        const editor = monacoRef.current
        let nextHtmlBody = ''
        if (editor) {
            const selection = editor.getSelection()
            const range = selection || undefined
            editor.executeEdits('inline-image', [{
                range,
                text: snippets,
                forceMoveMarkers: true,
            }])
            editor.focus()
            nextHtmlBody = editor.getValue()
        }

        patchDraft((currentDraft) => ({
            ...currentDraft,
            attachments: [...(currentDraft?.attachments || []), ...prepared],
            htmlBody: editor
                ? nextHtmlBody
                : `${currentDraft?.htmlBody || ''}${currentDraft?.htmlBody ? '\n' : ''}${snippets}`,
        }))
    }, [patchDraft])

    const handleAttachmentInput = useCallback(async (event, disposition) => {
        const input = event.target
        try {
            await handleFilesSelected(input.files, disposition)
        } finally {
            input.value = ''
        }
    }, [handleFilesSelected])

    const handleRemoveAttachment = useCallback((attachmentId) => {
        patchDraft({
            attachments: (draft?.attachments || []).filter((attachment) => attachment.id !== attachmentId),
        })
    }, [draft?.attachments, patchDraft])

    return (
        <div className="compose-view">
            <input
                ref={fileInputRef}
                type="file"
                multiple
                hidden
                onChange={(event) => handleAttachmentInput(event, 'attachment')}
            />
            <input
                ref={inlineImageInputRef}
                type="file"
                accept="image/*"
                multiple
                hidden
                onChange={(event) => handleAttachmentInput(event, 'inline')}
            />

            <div className="cv-toolbar">
                <div className="cv-toolbar__left">
                    <SegmentSwitch
                        value={draft?.format || 'plain'}
                        onChange={handleFormatChange}
                        options={[
                            { value: 'plain', label: 'Plain Text' },
                            { value: 'html', label: 'HTML' },
                        ]}
                    />
                    {draft?.format === 'html' && (
                        <SegmentSwitch
                            value={draft?.htmlMode || 'edit'}
                            onChange={(value) => patchDraft({ htmlMode: value })}
                            options={[
                                { value: 'edit', label: 'Edit' },
                                { value: 'preview', label: 'Preview' },
                            ]}
                        />
                    )}
                </div>
                <div className="cv-toolbar__right">
                    <button
                        type="button"
                        className="cv-toolbar-btn"
                        onClick={() => fileInputRef.current?.click()}
                    >
                        Add attachment
                    </button>
                    {draft?.format === 'html' && draft?.htmlMode === 'edit' && (
                        <button
                            type="button"
                            className="cv-toolbar-btn"
                            onClick={() => inlineImageInputRef.current?.click()}
                        >
                            Insert image
                        </button>
                    )}
                </div>
            </div>

            <div className="cv-header">
                <div className="cv-field">
                    <label className="cv-label">From</label>
                    <div className="cv-from-value">{accountEmail || '—'}</div>
                </div>
                <RecipientField
                    label="To"
                    recipients={draft?.toRecipients || []}
                    onChange={(recipients) => patchRecipients('to', recipients)}
                    placeholder="recipient@example.com"
                    trailingActions={(
                        <>
                            {!draft?.showCc && (
                                <button type="button" className="cv-toggle-btn" onClick={() => patchDraft({ showCc: true })}>CC</button>
                            )}
                            {!draft?.showBcc && (
                                <button type="button" className="cv-toggle-btn" onClick={() => patchDraft({ showBcc: true })}>BCC</button>
                            )}
                        </>
                    )}
                />
                {draft?.showCc && (
                    <RecipientField
                        label="CC"
                        recipients={draft?.ccRecipients || []}
                        onChange={(recipients) => patchRecipients('cc', recipients)}
                        placeholder="cc@example.com"
                    />
                )}
                {draft?.showBcc && (
                    <RecipientField
                        label="BCC"
                        recipients={draft?.bccRecipients || []}
                        onChange={(recipients) => patchRecipients('bcc', recipients)}
                        placeholder="bcc@example.com"
                    />
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

            <div className="cv-editor-wrap">
                {draft?.format === 'plain' ? (
                    <textarea
                        className="cv-plain-editor"
                        value={draft?.plainBody || ''}
                        onChange={(event) => patchDraft({ plainBody: event.target.value })}
                        placeholder="Write your message..."
                    />
                ) : draft?.htmlMode === 'preview' ? (
                    <iframe
                        title="compose-preview"
                        className="cv-preview-frame"
                        sandbox=""
                        srcDoc={previewDocument}
                    />
                ) : (
                    <Editor
                        height="100%"
                        defaultLanguage="html"
                        value={draft?.htmlBody || ''}
                        onChange={(value) => patchDraft({ htmlBody: value || '' })}
                        onMount={(editor) => {
                            monacoRef.current = editor
                        }}
                        options={{
                            automaticLayout: true,
                            wordWrap: 'on',
                            minimap: { enabled: false },
                            lineNumbers: 'on',
                            scrollBeyondLastLine: false,
                            tabSize: 2,
                        }}
                    />
                )}
            </div>

            <ComposeAttachmentList attachments={manualAttachments} onRemove={handleRemoveAttachment} />

            <div className="cv-actions">
                <button
                    type="button"
                    className="cv-send-btn"
                    onClick={handleSend}
                    disabled={sending || (draft?.toRecipients || []).length === 0}
                >
                    {sending ? '⏳ Sending...' : '📨 Send'}
                </button>
                <button
                    type="button"
                    className="cv-discard-btn"
                    onClick={onDiscard}
                >
                    ✕ Discard
                </button>
            </div>
        </div>
    )
}
