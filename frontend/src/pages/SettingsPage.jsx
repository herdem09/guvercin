import React, { useState, useMemo, useRef, useEffect } from 'react'
import { useTheme } from '../context/ThemeContext.jsx'
import './SettingsPage.css'

/* ─── Static category tree ─────────────────────────────────────── */
const CATEGORIES = [
    {
        id: 'customization',
        label: 'Customization',
        children: [
            { id: 'theme', label: 'Theme', parentId: 'customization' },
        ],
    },
    {
        id: 'email',
        label: 'Email',
        children: [
            { id: 'imap', label: 'IMAP', parentId: 'email' },
            { id: 'smtp', label: 'SMTP', parentId: 'email' },
        ],
    },
]

// Flat list of every node (parent + children) for search
const ALL_NODES = [
    ...CATEGORIES.map((c) => ({ ...c, type: 'parent' })),
    ...CATEGORIES.flatMap((c) => c.children.map((ch) => ({ ...ch, type: 'child' }))),
]

/* ─── Theme settings panel ──────────────────────────────────────── */
const BUILTIN_THEMES = [
    { name: 'light', label: 'Light', swatches: ['#FFF5CA', '#FFCB08', '#343a40'] },
    { name: 'dark', label: 'Dark', swatches: ['#0f1115', '#3b3f46', '#e9eaec'] },
]

function ThemeSettings() {
    const { setThemeMode, setThemeName, themeMode, themeName } = useTheme()

    const chooseManual = async (name) => {
        await setThemeMode('manual')
        await setThemeName(name)
    }

    const chooseSystem = async () => {
        await setThemeMode('system')
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title">Theme</h2>
            <p className="sp-section__desc">Choose the appearance for the application.</p>

            <div className="sp-theme-grid">
                {BUILTIN_THEMES.map((theme) => (
                    <button
                        key={theme.name}
                        type="button"
                        className={`sp-theme-card ${themeMode === 'manual' && themeName === theme.name ? 'active' : ''}`}
                        onClick={() => chooseManual(theme.name)}
                    >
                        <div className="sp-theme-card__swatches">
                            {theme.swatches.map((color) => (
                                <span
                                    key={color}
                                    className="sp-theme-swatch"
                                    style={{ background: color }}
                                    aria-hidden="true"
                                />
                            ))}
                        </div>
                        <div className="sp-theme-card__label">{theme.label}</div>
                        {themeMode === 'manual' && themeName === theme.name && (
                            <span className="sp-theme-card__check">✓</span>
                        )}
                    </button>
                ))}
            </div>

            <button
                type="button"
                className={`sp-system-btn ${themeMode !== 'manual' ? 'active' : ''}`}
                onClick={chooseSystem}
            >
                <span className="sp-system-btn__icon">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <circle cx="12" cy="12" r="4" /><line x1="12" y1="2" x2="12" y2="6" /><line x1="12" y1="18" x2="12" y2="22" />
                        <line x1="4.22" y1="4.22" x2="7.05" y2="7.05" /><line x1="16.95" y1="16.95" x2="19.78" y2="19.78" />
                        <line x1="2" y1="12" x2="6" y2="12" /><line x1="18" y1="12" x2="22" y2="12" />
                        <line x1="4.22" y1="19.78" x2="7.05" y2="16.95" /><line x1="16.95" y1="7.05" x2="19.78" y2="4.22" />
                    </svg>
                </span>
                System (default)
                {themeMode !== 'manual' && <span className="sp-system-btn__badge">Active</span>}
            </button>
        </div>
    )
}

/* ─── IMAP settings panel ───────────────────────────────────────── */
function ImapSettings() {
    return (
        <div className="sp-section">
            <h2 className="sp-section__title">IMAP</h2>
            <p className="sp-section__desc">Incoming mail server settings.</p>
            <div className="sp-placeholder">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z" /><polyline points="22,6 12,13 2,6" />
                </svg>
                <span>IMAP ayarları yakında eklenecek</span>
            </div>
        </div>
    )
}

/* ─── SMTP settings panel ───────────────────────────────────────── */
function SmtpSettings() {
    return (
        <div className="sp-section">
            <h2 className="sp-section__title">SMTP</h2>
            <p className="sp-section__desc">Outgoing mail server settings.</p>
            <div className="sp-placeholder">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                    <line x1="22" y1="2" x2="11" y2="13" /><polygon points="22 2 15 22 11 13 2 9 22 2" />
                </svg>
                <span>SMTP ayarları yakında eklenecek</span>
            </div>
        </div>
    )
}

/* ─── Content renderer ──────────────────────────────────────────── */
function renderContent(selection) {
    if (!selection) return null

    // Top-level category → show all children's panels
    const parentCat = CATEGORIES.find((c) => c.id === selection)
    if (parentCat) {
        return parentCat.children.map((child) => (
            <React.Fragment key={child.id}>
                {renderSinglePanel(child.id)}
                {parentCat.children.indexOf(child) < parentCat.children.length - 1 && (
                    <div className="sp-section-divider" />
                )}
            </React.Fragment>
        ))
    }

    return renderSinglePanel(selection)
}

function renderSinglePanel(id) {
    switch (id) {
        case 'theme': return <ThemeSettings />
        case 'imap': return <ImapSettings />
        case 'smtp': return <SmtpSettings />
        default: return null
    }
}

/* ─── Main component ────────────────────────────────────────────── */
function SettingsPage({ onClose }) {
    const [search, setSearch] = useState('')
    const [expanded, setExpanded] = useState({ customization: true, email: true })
    const [selected, setSelected] = useState('customization')
    const searchRef = useRef(null)

    // Auto-focus search on open
    useEffect(() => {
        searchRef.current?.focus()
    }, [])

    // Close on Escape
    useEffect(() => {
        const handler = (e) => { if (e.key === 'Escape') onClose() }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [onClose])

    const searchQuery = search.trim().toLowerCase()

    const filteredCategories = useMemo(() => {
        if (!searchQuery) return CATEGORIES
        return CATEGORIES
            .map((cat) => {
                const catMatches = cat.label.toLowerCase().includes(searchQuery)
                const filteredChildren = cat.children.filter((ch) =>
                    ch.label.toLowerCase().includes(searchQuery)
                )
                if (catMatches || filteredChildren.length > 0) {
                    return { ...cat, children: catMatches ? cat.children : filteredChildren }
                }
                return null
            })
            .filter(Boolean)
    }, [searchQuery])

    const toggleExpand = (id, e) => {
        e.stopPropagation()
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
    }

    const handleSelectParent = (id) => {
        setSelected(id)
        // Auto-expand when clicking parent
        setExpanded((prev) => ({ ...prev, [id]: true }))
    }

    return (
        <div className="sp-backdrop" onClick={onClose}>
            <div className="sp-modal" onClick={(e) => e.stopPropagation()}>

                {/* ── Sidebar ── */}
                <aside className="sp-sidebar">
                    <div className="sp-sidebar__header">
                        <span className="sp-sidebar__title">Settings</span>
                        <button
                            type="button"
                            className="sp-close-btn"
                            onClick={onClose}
                            aria-label="Close settings"
                        >
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                            </svg>
                        </button>
                    </div>

                    {/* Search */}
                    <div className="sp-search-wrap">
                        <span className="sp-search-icon" aria-hidden="true">
                            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                            </svg>
                        </span>
                        <input
                            ref={searchRef}
                            type="text"
                            className="sp-search-input"
                            placeholder="Search settings…"
                            value={search}
                            onChange={(e) => setSearch(e.target.value)}
                        />
                        {search && (
                            <button type="button" className="sp-search-clear" onClick={() => setSearch('')} aria-label="Clear">
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
                                    <line x1="18" y1="6" x2="6" y2="18" /><line x1="6" y1="6" x2="18" y2="18" />
                                </svg>
                            </button>
                        )}
                    </div>

                    {/* Tree */}
                    <nav className="sp-tree">
                        {filteredCategories.length === 0 && (
                            <div className="sp-tree__empty">No results</div>
                        )}
                        {filteredCategories.map((cat) => (
                            <div key={cat.id} className="sp-tree__group">
                                {/* Parent row */}
                                <div
                                    className={`sp-tree__parent ${selected === cat.id ? 'active' : ''}`}
                                    onClick={() => handleSelectParent(cat.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSelectParent(cat.id)}
                                >
                                    <span className="sp-tree__parent-label">{cat.label}</span>
                                    <button
                                        type="button"
                                        className={`sp-tree__chevron ${expanded[cat.id] ? 'expanded' : ''}`}
                                        onClick={(e) => toggleExpand(cat.id, e)}
                                        aria-label={expanded[cat.id] ? 'Collapse' : 'Expand'}
                                    >
                                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="9 18 15 12 9 6" />
                                        </svg>
                                    </button>
                                </div>

                                {/* Children */}
                                {expanded[cat.id] && (
                                    <div className="sp-tree__children">
                                        {cat.children.map((child) => (
                                            <div
                                                key={child.id}
                                                className={`sp-tree__child ${selected === child.id ? 'active' : ''}`}
                                                onClick={() => setSelected(child.id)}
                                                role="button"
                                                tabIndex={0}
                                                onKeyDown={(e) => e.key === 'Enter' && setSelected(child.id)}
                                            >
                                                <span className="sp-tree__child-dot" aria-hidden="true" />
                                                {child.label}
                                            </div>
                                        ))}
                                    </div>
                                )}
                            </div>
                        ))}
                    </nav>
                </aside>

                {/* ── Content ── */}
                <main className="sp-content">
                    <div className="sp-content__inner">
                        {renderContent(selected)}
                    </div>
                </main>
            </div>
        </div>
    )
}

export default SettingsPage
