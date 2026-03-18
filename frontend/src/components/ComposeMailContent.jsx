import ComposeView from './ComposeView.jsx'
import { getComposeTitle } from '../utils/compose.js'

export default function ComposeMailContent({
    draft,
    onDraftChange,
    onSend,
    onDiscard,
    onOpenInTab,
    onOpenInWindow,
    accountEmail,
    sending = false,
}) {
    return (
        <div
            className="db-mail-content"
            style={{ overflow: 'hidden' }}
        >
            <div className="db-mail-content-header">
                <div className="db-mail-content-subject">{getComposeTitle(draft)}</div>
                <div className="db-mail-content-actions">
                    {onOpenInTab && (
                        <button
                            className="db-mail-action-btn"
                            onClick={onOpenInTab}
                            title="Open in new tab"
                        >
                            🗂️
                        </button>
                    )}
                    {onOpenInWindow && (
                        <button
                            className="db-mail-action-btn"
                            onClick={onOpenInWindow}
                            title="Open in new window"
                        >
                            🪟
                        </button>
                    )}
                    <button
                        className="db-mail-action-btn"
                        onClick={onDiscard}
                        title="Close"
                    >
                        ✕
                    </button>
                </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
                <ComposeView
                    draft={draft}
                    onDraftChange={onDraftChange}
                    onSend={onSend}
                    onDiscard={onDiscard}
                    accountEmail={accountEmail}
                    sending={sending}
                />
            </div>
        </div>
    )
}
