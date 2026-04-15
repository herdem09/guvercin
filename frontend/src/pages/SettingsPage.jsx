import React, {
    useState,
    useMemo,
    useRef,
    useEffect,
    useCallback,
    useLayoutEffect,
    createContext,
    useContext,
} from 'react'
import { useTheme } from '../context/ThemeContext.jsx'
import { apiUrl } from '../utils/api'
import {
    normalizeMailboxResponse,
    dedupeStringsCaseInsensitive,
    sortWithSavedOrder,
    compareMailboxesDefaultOrder,
} from '../utils/mailboxes'
import { importThemeFromFile } from '../theme/importThemeFile.js'
import {
    applyThemePreference,
    getStoredThemePreference,
    setStoredThemePreference,
} from '../theme/themeManager.js'

/** GET /api/account/:id/settings uses camelCase (AccountSettingsResponse). */
function parseSavedOrderFromSettings(setData, camelKey, snakeKey) {
    const raw = setData?.[camelKey] ?? setData?.[snakeKey]
    if (raw == null || raw === '') return []
    try {
        const parsed = JSON.parse(raw)
        return Array.isArray(parsed) ? parsed : []
    } catch {
        return []
    }
}

import './SettingsPage.css'

const SettingsDraftContext = createContext(null)

function useSettingsDraft(id, label, { isDirty, save, revert }) {
    const ctx = useContext(SettingsDraftContext)
    const saveRef = useRef(save)
    const revertRef = useRef(revert)
    saveRef.current = save
    revertRef.current = revert

    useEffect(() => {
        if (!ctx) return undefined
        if (!isDirty) {
            ctx.unregister(id)
            return undefined
        }
        ctx.register(id, {
            label,
            save: async () => {
                await saveRef.current()
            },
            revert: () => {
                revertRef.current()
            },
        })
        return () => ctx.unregister(id)
    }, [ctx, id, label, isDirty])
}

function setsEqual(a, b) {
    if (a.size !== b.size) return false
    for (const x of a) {
        if (!b.has(x)) return false
    }
    return true
}

function cloneOfflineBaseline(src) {
    return {
        offlineEnabled: src.offlineEnabled,
        selectedPrefixes: new Set(src.selectedPrefixes),
        excludedExact: new Set(src.excludedExact),
        policyMode: src.policyMode,
        policyValue: src.policyValue,
        cacheRawRfc822: src.cacheRawRfc822,
    }
}

function offlineStateEquals(a, b) {
    return (
        a.offlineEnabled === b.offlineEnabled
        && a.policyMode === b.policyMode
        && String(a.policyValue) === String(b.policyValue)
        && a.cacheRawRfc822 === b.cacheRawRfc822
        && setsEqual(a.selectedPrefixes, b.selectedPrefixes)
        && setsEqual(a.excludedExact, b.excludedExact)
    )
}

/* ─── Static category tree ─────────────────────────────────────── */
const CATEGORIES = [
    {
        id: 'appearance',
        label: 'Appearance',
        children: [
            { id: 'theme', label: 'Theme', parentId: 'appearance' },
            { id: 'font', label: 'Font', parentId: 'appearance' },
            { id: 'layout', label: 'Layout', parentId: 'appearance' },
            { id: 'toolbar', label: 'Toolbar', parentId: 'appearance' },
            { id: 'mailbox_label_list', label: 'Mailbox & Label List', parentId: 'appearance' },
        ],
    },
    {
        id: 'email',
        label: 'Email',
        children: [
            { id: 'offline', label: 'Offline', parentId: 'email' },
            { id: 'imap', label: 'IMAP', parentId: 'email' },
            { id: 'smtp', label: 'SMTP', parentId: 'email' },
            { id: 'blocked', label: 'Blocked Senders', parentId: 'email' },
        ],
    },
    {
        id: 'security',
        label: 'Security',
        children: [
            { id: 'encryption', label: 'Encryption', parentId: 'security' },
        ],
    },
]

/** Searchable content per panel (titles, descriptions, labels, keywords). */
const PANEL_SEARCH_INDEX = {
    theme: 'theme light dark system import appearance manual choose',
    font: 'font typeface typography family inter sans serif system appearance text readability',
    layout: 'layout drag drop sidebar toolbar tabs top bottom left right',
    toolbar: 'toolbar ribbon submenu icon text button style compact large vertical appearance',
    mailbox_label_list: 'sidebar mail counts unread total both none mailbox label list order reorder arrows folders',
    offline: 'offline sync download folders labels cache attachments policy days count enable email caching',
    imap: 'imap incoming mail server port password ssl starttls encryption connection',
    smtp: 'smtp outgoing mail server port password ssl starttls',
    blocked: 'blocked senders block delete spam archive email addresses automatically moved',
    encryption: 'encryption encrypt stored data password login policy keyring account decrypt sqlite',
}

function SearchResultsPage({ filteredCategories, searchQuery, onSelectPanel, onSelectCategory, accountId, onClose, onRefreshAccount, appearance }) {
    const q = searchQuery.trim().toLowerCase()
    if (!q || filteredCategories.length === 0) {
        return (
            <div className="sp-section">
                <h2 className="sp-search-results__main-title">Search Results</h2>
                <p className="sp-section__desc">No results found.</p>
            </div>
        )
    }
    return (
        <div className="sp-section sp-search-results">
            <h2 className="sp-search-results__main-title">Search Results</h2>
            {filteredCategories.map((cat) => (
                <div key={cat.id} className="sp-search-results__category">
                    <button
                        type="button"
                        className="sp-search-results__category-title"
                        onClick={() => onSelectCategory(cat.id)}
                    >
                        <HighlightMatch text={cat.label} query={q} />
                    </button>
                    {cat.children.map((child) => (
                        <div key={child.id} className="sp-search-results__item">
                            <button
                                type="button"
                                className="sp-search-results__item-title"
                                onClick={() => onSelectPanel(child.id)}
                            >
                                <HighlightMatch text={child.label} query={q} />
                            </button>
                            <div className="sp-search-results__item-body">
                                {renderSinglePanel(child.id, accountId, onClose, onRefreshAccount, searchQuery, appearance)}
                            </div>
                        </div>
                    ))}
                </div>
            ))}
        </div>
    )
}

function panelMatchesSearch(panelId, query) {
    if (!query) return false
    const index = PANEL_SEARCH_INDEX[panelId]
    if (!index) return false
    return index.toLowerCase().includes(query)
}

function escapeRegex(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function HighlightMatch({ text, query }) {
    if (!query || !text) return text
    const escaped = escapeRegex(query)
    const parts = String(text).split(new RegExp(`(${escaped})`, 'gi'))
    return parts.map((part, i) =>
        part.toLowerCase() === query.toLowerCase() ? (
            <mark key={i} className="sp-search-highlight">{part}</mark>
        ) : (
            part
        )
    )
}

/* ─── Theme settings panel ──────────────────────────────────────── */
const BUILTIN_THEMES = [
    { name: 'light', label: 'Light', swatches: ['#FFF5CA', '#FFCB08', '#343a40'] },
    { name: 'dark', label: 'Dark', swatches: ['#0f1115', '#3b3f46', '#e9eaec'] },
]

const FONT_FALLBACK_OPTIONS = [
    'Inter', 'Arial', 'Verdana', 'Tahoma', 'Trebuchet MS', 'Times New Roman',
    'Georgia', 'Garamond', 'Courier New', 'Segoe UI', 'system-ui',
]

function applyAppFontFamily(name) {
    const safe = (name || 'Inter').trim() || 'Inter'
    document.body.style.fontFamily = `"${safe}", sans-serif`
}

function FontSettings({
    accountId,
    searchQuery = '',
    fontDraft,
    setFontDraft,
    fontBaselineRef,
    fontReady,
}) {
    const [fonts, setFonts] = useState(FONT_FALLBACK_OPTIONS)
    const [saving, setSaving] = useState(false)
    const [persistError, setPersistError] = useState(null)

    useEffect(() => {
        let active = true
        if ('queryLocalFonts' in window) {
            window.queryLocalFonts()
                .then((localFonts) => {
                    if (!active) return
                    const uniqueFamilies = new Set()
                    localFonts.forEach((f) => uniqueFamilies.add(f.family))
                    if (uniqueFamilies.size > 0) {
                        setFonts(Array.from(uniqueFamilies).sort())
                    }
                })
                .catch(() => {})
        }
        return () => {
            active = false
        }
    }, [])

    useEffect(() => {
        setFonts((prev) => (prev.includes(fontDraft) ? prev : [...prev, fontDraft].sort()))
    }, [fontDraft])

    const persistFont = useCallback(async () => {
        if (!accountId) {
            localStorage.setItem('font', fontDraft)
            fontBaselineRef.current = fontDraft
            return
        }
        setPersistError(null)
        const res = await fetch(apiUrl(`/api/account/${accountId}/font`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ font: fontDraft }),
        })
        if (!res.ok) throw new Error('save_failed')
        localStorage.setItem('font', fontDraft)
        fontBaselineRef.current = fontDraft
    }, [accountId, fontDraft, fontBaselineRef])

    const saveFontDraft = useCallback(async () => {
        setSaving(true)
        setPersistError(null)
        try {
            await persistFont()
        } catch (e) {
            console.error(e)
            setPersistError('Could not save font. Try again.')
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [persistFont])

    const fontDirty = fontDraft !== fontBaselineRef.current

    useSettingsDraft('font-appearance', 'Font', {
        isDirty: fontDirty,
        save: saveFontDraft,
        revert: () => {
            const base = fontBaselineRef.current
            setFontDraft(base)
            applyAppFontFamily(base)
            setPersistError(null)
        },
    })

    const handleFontChange = (e) => {
        const name = e.target.value
        setFontDraft(name)
        applyAppFontFamily(name)
    }

    if (!fontReady) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Font" query={searchQuery} /></h2>
                <div className="sp-loading-row">
                    <div className="sp-spinner" />
                    <span>Loading…</span>
                </div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Font" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Choose the typeface used across the application. Changes apply as a preview until you save." query={searchQuery} />
            </p>

            <div className="sp-form-field sp-font-field">
                <label htmlFor="sp-font-select"><HighlightMatch text="Font family" query={searchQuery} /></label>
                <select
                    id="sp-font-select"
                    className="sp-font-select"
                    value={fontDraft}
                    onChange={handleFontChange}
                >
                    {fonts.map((font) => (
                        <option key={font} value={font} style={{ fontFamily: `"${font}", sans-serif` }}>
                            {font}
                        </option>
                    ))}
                </select>
                <p className="sp-section__hint">
                    <HighlightMatch
                        text="If your browser supports it, local fonts are listed. Allow font access when prompted to see all installed families."
                        query={searchQuery}
                    />
                </p>
            </div>

            <div
                className="sp-font-preview"
                style={{ fontFamily: `"${fontDraft}", sans-serif` }}
            >
                <HighlightMatch text="The quick brown fox jumps over the lazy dog." query={searchQuery} />
            </div>

            {persistError && (
                <div className="sp-form-message sp-form-message--error" style={{ marginTop: 12 }}>
                    {persistError}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: 20 }}
                onClick={() => saveFontDraft().catch(() => {})}
                disabled={saving || !fontDirty}
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    )
}

function LayoutSettings({
    accountId,
    searchQuery = '',
    layoutDraft,
    setLayoutDraft,
    layoutBaselineRef,
    layoutReady,
}) {
    const [saving, setSaving] = useState(false)
    const [persistError, setPersistError] = useState(null)
    const [draggedItem, setDraggedItem] = useState(null)
    const [dragOverZone, setDragOverZone] = useState(null)
    const [dragOverInvalid, setDragOverInvalid] = useState(false)

    const persistLayout = useCallback(async () => {
        const layoutJson = JSON.stringify(layoutDraft)
        if (!accountId) {
            localStorage.setItem('layout', layoutJson)
            layoutBaselineRef.current = JSON.parse(layoutJson)
            window.dispatchEvent(new Event('guvercin-layout-changed'))
            return
        }
        setPersistError(null)
        const res = await fetch(apiUrl(`/api/account/${accountId}/layout`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ layout: layoutJson }),
        })
        if (!res.ok) throw new Error('save_failed')
        localStorage.setItem('layout', layoutJson)
        layoutBaselineRef.current = JSON.parse(layoutJson)
        window.dispatchEvent(new Event('guvercin-layout-changed'))
    }, [accountId, layoutDraft, layoutBaselineRef])

    const saveLayoutDraft = useCallback(async () => {
        setSaving(true)
        setPersistError(null)
        try {
            await persistLayout()
        } catch (e) {
            console.error(e)
            setPersistError('Could not save layout. Try again.')
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [persistLayout])

    const layoutDirty = JSON.stringify(layoutDraft) !== JSON.stringify(layoutBaselineRef.current)

    useSettingsDraft('layout-appearance', 'Layout', {
        isDirty: layoutDirty,
        save: saveLayoutDraft,
        revert: () => {
            const base = layoutBaselineRef.current
            setLayoutDraft(JSON.parse(JSON.stringify(base)))
            setPersistError(null)
        },
    })

    const BAR_LABELS = {
        main: 'Main Bar',
        tabs: 'Tabs Bar',
        tools: 'Toolbar',
        apps: 'Apps Bar',
        mailboxes: 'Mailboxes Bar',
        maillist: 'Mail List Bar'
    }

    const BAR_BADGES = {
        main: 'MAIN',
        tabs: 'TABS',
        tools: 'TOOLS',
        apps: 'APPS',
        mailboxes: 'MBX',
        maillist: 'ML'
    }

    const BAR_ZONES = {
        main: ['top', 'bottom', 'left', 'right'],
        tabs: ['top', 'bottom', 'left', 'right'],
        tools: ['top', 'bottom'],
        apps: ['top', 'bottom', 'left', 'right'],
        mailboxes: ['left', 'right'],
        maillist: ['left', 'right']
    }
    const ZONE_LABELS = {
        top: 'Top',
        bottom: 'Bottom',
        left: 'Left',
        right: 'Right'
    }

    const handleDragStart = (e, item) => {
        e.dataTransfer.setData('text/plain', item)
        setDraggedItem(item)
        setDragOverZone(null)
        setDragOverInvalid(false)
    }

    const handleDrop = (e, zoneId) => {
        e.preventDefault()
        const item = e.dataTransfer.getData('text/plain')
        if (!item) return

        if (!BAR_ZONES[item]?.includes(zoneId)) {
            setDraggedItem(null)
            setDragOverZone(null)
            setDragOverInvalid(false)
            return
        }
        
        const newLayout = { top: [...layoutDraft.top], bottom: [...layoutDraft.bottom], left: [...layoutDraft.left], right: [...layoutDraft.right] }
        Object.keys(newLayout).forEach(k => {
            newLayout[k] = newLayout[k].filter(i => i !== item)
        })
        
        const targetItem = e.target.closest('.ls-item')?.dataset.item;
        if (targetItem && targetItem !== item) {
           const idx = newLayout[zoneId].indexOf(targetItem);
           if (idx >= 0) newLayout[zoneId].splice(idx, 0, item);
           else newLayout[zoneId].push(item);
        } else {
           newLayout[zoneId].push(item)
        }
        
        Object.keys(newLayout).forEach(k => {
            const mainIdx = newLayout[k].indexOf('main')
            if (mainIdx > 0) {
                newLayout[k].splice(mainIdx, 1)
                newLayout[k].unshift('main')
            }
            const appsIdx = newLayout[k].indexOf('apps')
            if (appsIdx > 0) {
                newLayout[k].splice(appsIdx, 1)
                const insertAt = newLayout[k][0] === 'main' ? 1 : 0
                newLayout[k].splice(insertAt, 0, 'apps')
            }
        })
        
        setLayoutDraft(newLayout)
        setDraggedItem(null)
        setDragOverZone(null)
        setDragOverInvalid(false)
    }

    const handleDragOver = (e, zoneId) => {
        e.preventDefault()
        const item = draggedItem
        if (!item) return
        const isAllowed = BAR_ZONES[item]?.includes(zoneId)
        setDragOverZone(zoneId)
        setDragOverInvalid(!isAllowed)
        e.dataTransfer.dropEffect = isAllowed ? 'move' : 'none'
    }

    const handleDragLeave = (zoneId) => {
        if (dragOverZone === zoneId) {
            setDragOverZone(null)
            setDragOverInvalid(false)
        }
    }

    if (!layoutReady || !layoutDraft) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Layout" query={searchQuery} /></h2>
                <div className="sp-loading-row">
                    <div className="sp-spinner" />
                    <span>Loading…</span>
                </div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Layout" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Drag and drop bars to configure your layout. Changes apply visually; save to keep them." query={searchQuery} />
            </p>

            <div className="ls-container">
                <div className="ls-preview-board">
                    <div className="ls-screen">
                        {['top', 'left', 'center', 'right', 'bottom'].map(zone => (
                            zone === 'center' ? (
                                <div key={zone} className="ls-center">
                                    <div className="ls-center-label">Reading Pane</div>
                                </div>
                            ) : (
                                <div 
                                    key={zone}
                                    className={`ls-zone ls-zone--${zone}${dragOverZone === zone ? ' is-dragover' : ''}${dragOverZone === zone && dragOverInvalid ? ' is-invalid' : ''}`}
                                    onDrop={(e) => handleDrop(e, zone)}
                                    onDragOver={(e) => handleDragOver(e, zone)}
                                    onDragLeave={() => handleDragLeave(zone)}
                                >
                                    <div className="ls-zone-label">{ZONE_LABELS[zone]}</div>
                                    <div className="ls-zone-items">
                                        {layoutDraft[zone].map(item => (
                                            <div
                                                key={item}
                                                className="ls-item"
                                                draggable
                                                onDragStart={(e) => handleDragStart(e, item)}
                                                onDragEnd={() => {
                                                    setDraggedItem(null)
                                                    setDragOverZone(null)
                                                    setDragOverInvalid(false)
                                                }}
                                                data-item={item}
                                            >
                                                <span className="ls-item__badge">{BAR_BADGES[item]}</span>
                                                <span className="ls-item__label">{BAR_LABELS[item]}</span>
                                            </div>
                                        ))}
                                    </div>
                                </div>
                            )
                        ))}
                    </div>
                </div>
                <div className="ls-info">
                    Kurallar: Main Bar dış katman, Apps Bar ikinci katman; diğer bar'lar içeride. Apps Bar solda/sağda iken üst/alt bar'lar ondan sonra başlar. Tools Bar sadece Top/Bottom. Mailboxes & Mail List sadece Left/Right. Sıralama: dıştan içe.
                </div>
            </div>

            {persistError && (
                <div className="sp-form-message sp-form-message--error" style={{ marginTop: 12 }}>
                    {persistError}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: 20 }}
                onClick={() => saveLayoutDraft().catch(() => {})}
                disabled={saving || !layoutDirty}
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    )
}

const TOOLBAR_STYLE_OPTIONS = [
    { value: 'icon_small', label: 'Icon only (Small)', icon: true, text: false },
    { value: 'icon_large', label: 'Icon only (Large)', icon: true, text: false },
    { value: 'text_small', label: 'Text only (Small)', icon: false, text: true },
    { value: 'icon_text_small', label: 'Icon + Text (Small)', icon: true, text: true },
    { value: 'icon_text_large_vertical', label: 'Icon + Text (Large Vertical)', icon: true, text: true },
]

function normalizeToolbarStyle(value) {
    const normalized = (value || '').toString().trim().toLowerCase()
    if (TOOLBAR_STYLE_OPTIONS.some((option) => option.value === normalized)) {
        return normalized
    }
    return 'icon_text_small'
}

function ToolbarPreviewButton({ styleValue, icon, label }) {
    const showIcon = styleValue !== 'text_small'
    const showLabel = styleValue !== 'icon_small' && styleValue !== 'icon_large'
    return (
        <button type="button" className={`sp-toolbar-preview__btn sp-toolbar-preview__btn--${styleValue}`} tabIndex={-1}>
            {showIcon && <span className="sp-toolbar-preview__icon">{icon}</span>}
            {showLabel && <span className="sp-toolbar-preview__label">{label}</span>}
        </button>
    )
}

function ToolbarSettings({
    accountId,
    searchQuery = '',
    toolbarStyleDraft,
    setToolbarStyleDraft,
    toolbarStyleBaselineRef,
    toolbarStyleReady,
}) {
    const [saving, setSaving] = useState(false)
    const [persistError, setPersistError] = useState(null)
    const normalizedDraft = normalizeToolbarStyle(toolbarStyleDraft)
    const toolbarStyleDirty = normalizedDraft !== normalizeToolbarStyle(toolbarStyleBaselineRef.current)

    const persistToolbarStyle = useCallback(async () => {
        const safeStyle = normalizeToolbarStyle(toolbarStyleDraft)
        if (!accountId) {
            localStorage.setItem('toolbar_style', safeStyle)
            toolbarStyleBaselineRef.current = safeStyle
            window.dispatchEvent(new Event('guvercin-toolbar-style-changed'))
            return
        }
        setPersistError(null)
        const res = await fetch(apiUrl(`/api/account/${accountId}/toolbar-style`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ style: safeStyle }),
        })
        if (!res.ok) throw new Error('save_failed')
        localStorage.setItem('toolbar_style', safeStyle)
        toolbarStyleBaselineRef.current = safeStyle
        window.dispatchEvent(new Event('guvercin-toolbar-style-changed'))
    }, [accountId, toolbarStyleBaselineRef, toolbarStyleDraft])

    const saveToolbarDraft = useCallback(async () => {
        setSaving(true)
        setPersistError(null)
        try {
            await persistToolbarStyle()
        } catch (e) {
            console.error(e)
            setPersistError('Could not save toolbar style. Try again.')
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [persistToolbarStyle])

    useSettingsDraft('toolbar-appearance', 'Toolbar', {
        isDirty: toolbarStyleDirty,
        save: saveToolbarDraft,
        revert: () => {
            const base = normalizeToolbarStyle(toolbarStyleBaselineRef.current)
            setToolbarStyleDraft(base)
            setPersistError(null)
        },
    })

    if (!toolbarStyleReady) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Toolbar" query={searchQuery} /></h2>
                <div className="sp-loading-row">
                    <div className="sp-spinner" />
                    <span>Loading…</span>
                </div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Toolbar" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Choose how ribbon toolbar buttons look in Dashboard." query={searchQuery} />
            </p>

            <div className="sp-toolbar-style-grid">
                {TOOLBAR_STYLE_OPTIONS.map((option) => (
                    <label key={option.value} className={`sp-toolbar-style-card ${normalizedDraft === option.value ? 'active' : ''}`}>
                        <input
                            type="radio"
                            name="toolbar-style"
                            value={option.value}
                            checked={normalizedDraft === option.value}
                            onChange={(e) => setToolbarStyleDraft(e.target.value)}
                        />
                        <div className="sp-toolbar-style-card__label">{option.label}</div>
                        <div className="sp-toolbar-preview">
                            <ToolbarPreviewButton styleValue={option.value} icon="✉" label="New" />
                            <ToolbarPreviewButton styleValue={option.value} icon="🗂" label="Move" />
                            <ToolbarPreviewButton styleValue={option.value} icon="🏷" label="Label" />
                        </div>
                    </label>
                ))}
            </div>

            {persistError && (
                <div className="sp-form-message sp-form-message--error" style={{ marginTop: 12 }}>
                    {persistError}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: 20 }}
                onClick={() => saveToolbarDraft().catch(() => {})}
                disabled={saving || !toolbarStyleDirty}
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    )
}

function ThemeSettings({
    accountId,
    searchQuery = '',
    themeDraft,
    setThemeDraft,
    themeBaselineRef,
}) {
    const { availableThemes, refreshThemes } = useTheme()
    const themeImportInputRef = useRef(null)
    const [importThemeBusy, setImportThemeBusy] = useState(false)
    const [importThemeMessage, setImportThemeMessage] = useState(null)
    const [saving, setSaving] = useState(false)

    const persistThemeToBackend = useCallback(async (themeValue) => {
        if (!accountId) return
        const res = await fetch(apiUrl(`/api/account/${accountId}/theme`), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ theme: themeValue }),
        })
        if (!res.ok) throw new Error('save_failed')
    }, [accountId])

    const applyPreview = async (next) => {
        setThemeDraft(next)
        await applyThemePreference(next)
    }

    const chooseManual = async (name) => {
        await applyPreview({ mode: 'manual', name })
    }

    const chooseSystem = async () => {
        await applyPreview({ mode: 'system', name: themeDraft.name })
    }

    const handleImportThemeClick = () => {
        setImportThemeMessage(null)
        themeImportInputRef.current?.click()
    }

    const handleImportThemeFile = async (e) => {
        const file = e.target.files?.[0]
        e.target.value = ''
        if (!file) return
        setImportThemeBusy(true)
        setImportThemeMessage(null)
        try {
            const result = await importThemeFromFile(file, { skipTempKeys: true })
            if (!result.ok) {
                setImportThemeMessage({ type: 'error', text: '❌ Theme file is invalid.' })
                return
            }
            await refreshThemes()
            await applyPreview({ mode: 'manual', name: result.themeName })
            setImportThemeMessage({ type: 'success', text: '✅ Theme imported — click Save to keep it.' })
        } catch (err) {
            console.error(err)
            setImportThemeMessage({ type: 'error', text: '❌ Theme file is invalid.' })
        } finally {
            setImportThemeBusy(false)
        }
    }

    const persistTheme = useCallback(async () => {
        const p = themeDraft
        const backendVal = p.mode === 'manual' ? p.name : 'SYSTEM'
        if (accountId) {
            await persistThemeToBackend(backendVal)
        }
        setStoredThemePreference(p.mode, p.name)
        themeBaselineRef.current = { mode: p.mode, name: p.name }
        window.dispatchEvent(new Event('guvercin-theme-changed'))
    }, [accountId, persistThemeToBackend, themeDraft, themeBaselineRef])

    const saveThemeDraft = useCallback(async () => {
        setSaving(true)
        try {
            await persistTheme()
        } catch (e) {
            console.error(e)
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [persistTheme])

    const b = themeBaselineRef.current
    const themeDirty = b != null && (
        themeDraft.mode !== b.mode || themeDraft.name !== b.name
    )

    useSettingsDraft('theme-appearance', 'Theme', {
        isDirty: themeDirty,
        save: saveThemeDraft,
        revert: () => {
            const base = themeBaselineRef.current
            if (!base) return
            setThemeDraft({ mode: base.mode, name: base.name })
            void applyThemePreference({ mode: base.mode, name: base.name })
        },
    })

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Theme" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Choose the appearance for the application. Preview updates immediately; save to keep your choice." query={searchQuery} />
            </p>

            <div className="sp-theme-grid">
                {BUILTIN_THEMES.map((theme) => (
                    <button
                        key={theme.name}
                        type="button"
                        className={`sp-theme-card ${themeDraft.mode === 'manual' && themeDraft.name === theme.name ? 'active' : ''}`}
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
                        <div className="sp-theme-card__label"><HighlightMatch text={theme.label} query={searchQuery} /></div>
                        {themeDraft.mode === 'manual' && themeDraft.name === theme.name && (
                            <span className="sp-theme-card__check">✓</span>
                        )}
                    </button>
                ))}
            </div>

            {availableThemes.filter((n) => n !== 'light' && n !== 'dark').length > 0 && (
                <div className="sp-theme-extra-list">
                    <h4 className="sp-theme-extra-title">Other Themes</h4>
                    <div className="sp-theme-grid">
                        {availableThemes.filter((n) => n !== 'light' && n !== 'dark').map((name) => (
                            <button
                                key={name}
                                type="button"
                                className={`sp-theme-card ${themeDraft.mode === 'manual' && themeDraft.name === name ? 'active' : ''}`}
                                onClick={() => chooseManual(name)}
                            >
                                <div className="sp-theme-card__swatches">
                                    <span className="sp-theme-swatch" style={{ background: 'var(--bg-primary)' }} />
                                    <span className="sp-theme-swatch" style={{ background: 'var(--brand-accent)' }} />
                                </div>
                                <div className="sp-theme-card__label"><HighlightMatch text={name} query={searchQuery} /></div>
                                {themeDraft.mode === 'manual' && themeDraft.name === name && (
                                    <span className="sp-theme-card__check">✓</span>
                                )}
                            </button>
                        ))}
                    </div>
                </div>
            )}

            <div className="sp-theme-actions">
                <button
                    type="button"
                    className={`sp-system-btn ${themeDraft.mode !== 'manual' ? 'active' : ''}`}
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
                    <HighlightMatch text="System" query={searchQuery} />
                    {themeDraft.mode !== 'manual' && <span className="sp-system-btn__badge">Active</span>}
                </button>

                <input
                    ref={themeImportInputRef}
                    type="file"
                    accept="application/json,.json"
                    className="sp-hidden-file-input"
                    aria-hidden
                    tabIndex={-1}
                    onChange={handleImportThemeFile}
                />
                <button
                    type="button"
                    className="sp-ghost-btn"
                    onClick={handleImportThemeClick}
                    disabled={importThemeBusy}
                >
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" y1="3" x2="12" y2="15" />
                    </svg>
                    <HighlightMatch text="Import Theme" query={searchQuery} />
                </button>
            </div>
            {importThemeMessage && (
                <div className={`sp-form-message sp-form-message--${importThemeMessage.type}`} style={{ marginTop: 14 }}>
                    {importThemeMessage.text}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: 34 }}
                onClick={() => saveThemeDraft().catch(() => {})}
                disabled={saving || !themeDirty}
            >
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    )
}

/* ─── Server settings (shared by IMAP and SMTP) ─────────────────── */
function ServerSettings({ accountId, type, searchQuery = '' }) {
    const isImap = type === 'imap'
    const draftId = isImap ? 'imap-server' : 'smtp-server'
    const draftLabel = isImap ? 'IMAP server' : 'SMTP server'
    const [form, setForm] = useState({
        server: '',
        port: '',
        password: '',
        sslMode: 'STARTTLS',
    })
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState(null)
    const baselineRef = useRef(null)
    const formRef = useRef(form)
    useLayoutEffect(() => {
        formRef.current = form
    }, [form])

    // Load current settings
    useEffect(() => {
        if (!accountId) {
            setLoading(false)
            return
        }
        let active = true
        fetch(apiUrl(`/api/account/${accountId}/settings`), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(r)))
            .then((data) => {
                if (!active) return
                const next = {
                    server: isImap ? (data.imapServer || '') : (data.smtpServer || ''),
                    port: isImap ? (data.imapPort != null ? String(data.imapPort) : '') : (data.smtpPort != null ? String(data.smtpPort) : ''),
                    password: '',
                    sslMode: data.sslMode || 'STARTTLS',
                }
                baselineRef.current = { server: next.server, port: next.port, sslMode: next.sslMode }
                setForm(next)
                setLoading(false)
            })
            .catch(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [accountId, isImap])

    const handleChange = (e) => {
        const { name, value } = e.target
        setForm((prev) => ({ ...prev, [name]: value }))
    }

    const persistServerSettings = useCallback(async () => {
        if (!accountId) return
        const f = formRef.current
        setSaving(true)
        setMessage(null)
        try {
            const body = isImap
                ? {
                    imapServer: f.server,
                    imapPort: f.port,
                    sslMode: f.sslMode,
                    ...(f.password ? { password: f.password } : {}),
                }
                : {
                    smtpServer: f.server,
                    smtpPort: f.port,
                    sslMode: f.sslMode,
                    ...(f.password ? { password: f.password } : {}),
                }

            const res = await fetch(apiUrl(`/api/account/${accountId}/settings`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body),
            })
            if (!res.ok) throw new Error('Save failed')
            baselineRef.current = { server: f.server, port: f.port, sslMode: f.sslMode }
            setMessage({ type: 'success', text: '✅ Settings saved successfully.' })
            setForm((prev) => ({ ...prev, password: '' }))
        } catch {
            setMessage({ type: 'error', text: '❌ Failed to save settings.' })
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [accountId, isImap])

    const handleSave = (e) => {
        e.preventDefault()
        void persistServerSettings().catch(() => {})
    }

    const b = baselineRef.current
    const serverDirty = !loading && b != null && (
        form.server !== b.server
        || form.port !== b.port
        || form.sslMode !== b.sslMode
        || form.password.length > 0
    )
    useSettingsDraft(draftId, draftLabel, {
        isDirty: serverDirty,
        save: persistServerSettings,
        revert: () => {
            const base = baselineRef.current
            if (!base) return
            setForm({ server: base.server, port: base.port, password: '', sslMode: base.sslMode })
        },
    })

    if (loading) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text={isImap ? 'IMAP' : 'SMTP'} query={searchQuery} /></h2>
                <div className="sp-loading-row">
                    <div className="sp-spinner" />
                    <span>Loading settings…</span>
                </div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text={isImap ? 'IMAP' : 'SMTP'} query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text={isImap ? 'Incoming mail server settings.' : 'Outgoing mail server settings.'} query={searchQuery} />
            </p>

            <form className="sp-server-form" onSubmit={handleSave}>
                <div className="sp-form-row sp-form-row--2col">
                    <div className="sp-form-field">
                        <label htmlFor={`${type}-server`}>
                            <HighlightMatch text={isImap ? 'IMAP Server' : 'SMTP Server'} query={searchQuery} />
                        </label>
                        <input
                            id={`${type}-server`}
                            type="text"
                            name="server"
                            placeholder="127.0.0.1"
                            value={form.server}
                            onChange={handleChange}
                            required
                        />
                    </div>
                    <div className="sp-form-field">
                        <label htmlFor={`${type}-port`}>
                            <HighlightMatch text={isImap ? 'IMAP Port' : 'SMTP Port'} query={searchQuery} />
                        </label>
                        <input
                            id={`${type}-port`}
                            type="number"
                            name="port"
                            placeholder={isImap ? '1143' : '1025'}
                            step="1"
                            value={form.port}
                            onChange={handleChange}
                            required
                        />
                    </div>
                </div>

                <div className="sp-form-field">
                    <label htmlFor={`${type}-password`}><HighlightMatch text="Password" query={searchQuery} /></label>
                    <input
                        id={`${type}-password`}
                        type="password"
                        name="password"
                        placeholder="Leave blank to keep current password"
                        value={form.password}
                        onChange={handleChange}
                    />
                </div>

                <div className="sp-form-field">
                    <label><HighlightMatch text="Connection Encryption Mode" query={searchQuery} /></label>
                    <div className="sp-radio-group">
                        {['STARTTLS', 'SSL', 'NONE'].map((mode) => (
                            <label key={mode} className="sp-radio-label">
                                <input
                                    type="radio"
                                    name="sslMode"
                                    value={mode}
                                    checked={form.sslMode === mode}
                                    onChange={handleChange}
                                />
                                <HighlightMatch text={mode === 'SSL' ? 'SSL/TLS' : mode} query={searchQuery} />
                            </label>
                        ))}
                    </div>
                </div>

                {message && (
                    <div className={`sp-form-message sp-form-message--${message.type}`}>
                        {message.text}
                    </div>
                )}

                <button
                    type="submit"
                    className="sp-save-btn"
                    disabled={saving || !serverDirty}
                >
                    {saving ? 'Saving…' : 'Save Settings'}
                </button>
            </form>
        </div>
    )
}

/* ─── Offline settings panel ────────────────────────────────────── */
function normalizeFolderPath(path) {
    if (path.startsWith('Folders/')) return path.slice('Folders/'.length)
    return path
}
function normalizeLabelPath(path) {
    if (path.startsWith('Labels/')) return path.slice('Labels/'.length)
    return path
}
function buildTreeNodes(paths, nodeType) {
    const root = []
    const insert = (parts) => {
        let level = root
        for (let i = 0; i < parts.length; i += 1) {
            const part = parts[i]
            const nodePath = parts.slice(0, i + 1).join('/')
            const key = `${nodeType}:${nodePath}`
            let node = level.find((n) => n.key === key)
            if (!node) {
                node = { key, name: part, nodeType, valuePath: nodePath, children: [], real: true }
                level.push(node)
            }
            level = node.children
        }
    }
    paths
        .filter(Boolean)
        .map((p) => p.trim())
        .filter(Boolean)
        .forEach((path) => {
            const normalized = nodeType === 'folder' ? normalizeFolderPath(path) : normalizeLabelPath(path)
            const parts = normalized.split('/').filter(Boolean)
            if (parts.length) insert(parts)
        })
    const sortNodes = (nodes) => {
        nodes.sort((a, b) => a.name.localeCompare(b.name))
        nodes.forEach((n) => sortNodes(n.children))
    }
    sortNodes(root)
    return root
}

function OfflineSettings({ accountId, searchQuery = '' }) {
    const [offlineEnabled, setOfflineEnabled] = useState(false)
    const [loading, setLoading] = useState(true)
    const [mailboxLoading, setMailboxLoading] = useState(false)
    const [mailboxError, setMailboxError] = useState('')
    const [folders, setFolders] = useState([])
    const [labels, setLabels] = useState([])
    const [selectedPrefixes, setSelectedPrefixes] = useState(() => new Set(['all']))
    const [excludedExact, setExcludedExact] = useState(() => new Set())
    const [expanded, setExpanded] = useState(() => new Set(['all', 'group:folders', 'group:labels']))
    const [policyMode, setPolicyMode] = useState('all')
    const [policyValue, setPolicyValue] = useState('')
    const [cacheRawRfc822, setCacheRawRfc822] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState(null)
    const offlineBaselineRef = useRef(null)

    const folderTree = useMemo(() => buildTreeNodes(folders, 'folder'), [folders])
    const labelTree = useMemo(() => buildTreeNodes(labels, 'label'), [labels])

    // Load offline config
    useEffect(() => {
        if (!accountId) { setLoading(false); return }
        let active = true
        fetch(apiUrl(`/api/offline/${accountId}/config`))
            .then((r) => r.ok ? r.json() : Promise.reject(r))
            .then((data) => {
                if (!active) return
                const enabled = !!data.enabled
                const polMode = data.initial_sync_policy?.mode || 'all'
                const polVal = data.initial_sync_policy?.value != null ? String(data.initial_sync_policy.value) : ''
                const cacheRaw = data.cache_raw_rfc822 !== false
                setOfflineEnabled(enabled)
                setPolicyMode(polMode)
                setPolicyValue(polVal)
                setCacheRawRfc822(cacheRaw)
                // Reconstruct selected prefixes from download rules
                const rules = Array.isArray(data.download_rules) ? data.download_rules : []
                const prefixes = new Set()
                const excluded = new Set()
                for (const rule of rules) {
                    if (!rule.is_active) continue
                    if (rule.rule_type === 'include_prefix') {
                        if (rule.node_path === '*' && rule.node_type === 'folder') prefixes.add('group:folders')
                        else if (rule.node_path === '*' && rule.node_type === 'label') prefixes.add('group:labels')
                        else prefixes.add(`${rule.node_type}:${rule.node_path}`)
                    } else if (rule.rule_type === 'exclude_exact') {
                        excluded.add(`${rule.node_type}:${rule.node_path}`)
                    }
                }
                if (prefixes.has('group:folders') && prefixes.has('group:labels')) {
                    prefixes.clear()
                    prefixes.add('all')
                }
                if (prefixes.size === 0) prefixes.add('all')
                setSelectedPrefixes(prefixes)
                setExcludedExact(excluded)
                offlineBaselineRef.current = cloneOfflineBaseline({
                    offlineEnabled: enabled,
                    selectedPrefixes: new Set(prefixes),
                    excludedExact: new Set(excluded),
                    policyMode: polMode,
                    policyValue: polVal,
                    cacheRawRfc822: cacheRaw,
                })
                setLoading(false)
            })
            .catch(() => { if (active) setLoading(false) })
        return () => { active = false }
    }, [accountId])

    // Load mailboxes from local cache (no password needed)
    const fetchMailboxes = useCallback(async () => {
        if (!accountId) return
        setMailboxLoading(true)
        setMailboxError('')
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`))
            if (!res.ok) throw new Error('Unable to load mailboxes')
            const data = await res.json()
            setFolders(Array.isArray(data.folders) ? data.folders : [])
            setLabels(Array.isArray(data.labels) ? data.labels : [])
        } catch (err) {
            setMailboxError(err?.message || 'Unable to load mailboxes.')
        } finally {
            setMailboxLoading(false)
        }
    }, [accountId])


    useEffect(() => {
        if (offlineEnabled && folders.length === 0 && !mailboxLoading && accountId) {
            fetchMailboxes()
        }
    }, [offlineEnabled, accountId]) // eslint-disable-line react-hooks/exhaustive-deps


    const hasInheritedSelection = (node) => {
        if (selectedPrefixes.has('all')) return true
        if (node.nodeType === 'folder' && selectedPrefixes.has('group:folders')) return true
        if (node.nodeType === 'label' && selectedPrefixes.has('group:labels')) return true
        for (const prefix of selectedPrefixes) {
            if (!prefix.includes(':')) continue
            if (!prefix.startsWith(`${node.nodeType}:`)) continue
            const p = prefix.split(':')[1]
            if (node.valuePath === p || node.valuePath.startsWith(`${p}/`)) return true
        }
        return false
    }

    const isIncluded = (node) => {
        if (!node.real) {
            if (node.key === 'all') return selectedPrefixes.has('all')
            if (node.key === 'group:folders') return selectedPrefixes.has('group:folders')
            if (node.key === 'group:labels') return selectedPrefixes.has('group:labels')
            return false
        }
        return hasInheritedSelection(node) && !excludedExact.has(node.key)
    }

    const toggleNode = (node) => {
        const selected = isIncluded(node)
        if (selected) {
            if (selectedPrefixes.has(node.key)) {
                const next = new Set(selectedPrefixes); next.delete(node.key); setSelectedPrefixes(next); return
            }
            if (node.real && hasInheritedSelection(node)) {
                const nextEx = new Set(excludedExact); nextEx.add(node.key); setExcludedExact(nextEx)
            } else if (!node.real) {
                const next = new Set(selectedPrefixes); next.delete(node.key); setSelectedPrefixes(next)
            }
            return
        }
        if (node.real && hasInheritedSelection(node)) {
            const nextEx = new Set(excludedExact); nextEx.delete(node.key); setExcludedExact(nextEx); return
        }
        const next = new Set(selectedPrefixes); next.add(node.key); setSelectedPrefixes(next)
    }

    const toggleExpand = (key) => {
        const next = new Set(expanded)
        if (next.has(key)) next.delete(key); else next.add(key)
        setExpanded(next)
    }

    const offlineSnapshot = useMemo(
        () => ({
            offlineEnabled,
            selectedPrefixes,
            excludedExact,
            policyMode,
            policyValue,
            cacheRawRfc822,
        }),
        [offlineEnabled, selectedPrefixes, excludedExact, policyMode, policyValue, cacheRawRfc822],
    )

    const offlineDirty = !loading
        && offlineBaselineRef.current != null
        && !offlineStateEquals(offlineSnapshot, offlineBaselineRef.current)

    const persistOfflineSettings = useCallback(async () => {
        if (!accountId) return
        setSaving(true)
        setMessage(null)
        try {
            const includeRules = []
            const addInclude = (nodePath, nodeType, source = 'user') => {
                includeRules.push({ node_path: nodePath, node_type: nodeType, rule_type: 'include_prefix', source })
            }
            if (selectedPrefixes.has('all')) {
                addInclude('*', 'folder', 'inherited')
                addInclude('*', 'label', 'inherited')
            } else {
                if (selectedPrefixes.has('group:folders')) addInclude('*', 'folder', 'inherited')
                if (selectedPrefixes.has('group:labels')) addInclude('*', 'label', 'inherited')
            }
            for (const key of selectedPrefixes) {
                if (!key.includes(':') || key === 'group:folders' || key === 'group:labels') continue
                const [nodeType, nodePath] = key.split(':')
                addInclude(nodePath, nodeType, 'user')
            }
            const excludeRules = Array.from(excludedExact).map((key) => {
                const [nodeType, nodePath] = key.split(':')
                return { node_path: nodePath, node_type: nodeType, rule_type: 'exclude_exact', source: 'user' }
            })
            const dedupe = new Map()
            for (const rule of [...includeRules, ...excludeRules]) {
                dedupe.set(`${rule.node_type}|${rule.rule_type}|${rule.node_path}`, rule)
            }
            const downloadRules = Array.from(dedupe.values())
            const normalizedValue = policyMode === 'all' ? null : Number(policyValue || 0)

            const res = await fetch(apiUrl(`/api/offline/${accountId}/config`), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    enabled: offlineEnabled,
                    download_rules: downloadRules,
                    initial_sync_policy: {
                        mode: policyMode,
                        value: normalizedValue && normalizedValue > 0 ? normalizedValue : null,
                    },
                    cache_raw_rfc822: cacheRawRfc822,
                }),
            })
            if (!res.ok) throw new Error('Save failed')
            offlineBaselineRef.current = cloneOfflineBaseline({
                offlineEnabled,
                selectedPrefixes,
                excludedExact,
                policyMode,
                policyValue,
                cacheRawRfc822,
            })
            setMessage({ type: 'success', text: '✅ Offline settings saved.' })
        } catch {
            setMessage({ type: 'error', text: '❌ Failed to save offline settings.' })
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [accountId, offlineEnabled, selectedPrefixes, excludedExact, policyMode, policyValue, cacheRawRfc822])

    const handleSave = () => {
        void persistOfflineSettings().catch(() => {})
    }

    useSettingsDraft('offline', 'Offline', {
        isDirty: offlineDirty,
        save: persistOfflineSettings,
        revert: () => {
            const base = offlineBaselineRef.current
            if (!base) return
            setOfflineEnabled(base.offlineEnabled)
            setSelectedPrefixes(new Set(base.selectedPrefixes))
            setExcludedExact(new Set(base.excludedExact))
            setPolicyMode(base.policyMode)
            setPolicyValue(base.policyValue)
            setCacheRawRfc822(base.cacheRawRfc822)
        },
    })

    const renderNode = (node, depth = 0) => {
        const hasChildren = Array.isArray(node.children) && node.children.length > 0
        const open = expanded.has(node.key)
        return (
            <div key={node.key} className="sp-off-node">
                <div className="sp-off-node__row" style={{ paddingLeft: `${depth * 14}px` }}>
                    {hasChildren ? (
                        <button type="button" className={`sp-off-chevron ${open ? 'open' : ''}`} onClick={() => toggleExpand(node.key)}>❯</button>
                    ) : (
                        <span className="sp-off-chevron-placeholder" />
                    )}
                    <label className="sp-off-node__label">
                        <input type="checkbox" checked={isIncluded(node)} onChange={() => toggleNode(node)} />
                        <span><HighlightMatch text={node.name} query={searchQuery} /></span>
                    </label>
                </div>
                {hasChildren && open && (
                    <div className="sp-off-node__children">{node.children.map((child) => renderNode(child, depth + 1))}</div>
                )}
            </div>
        )
    }

    const tree = [{
        key: 'all', name: 'all', real: false,
        children: [
            { key: 'group:folders', name: 'Folders', real: false, children: folderTree },
            { key: 'group:labels', name: 'Labels', real: false, children: labelTree },
        ],
    }]

    if (loading) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Offline" query={searchQuery} /></h2>
                <div className="sp-loading-row"><div className="sp-spinner" /><span>Loading…</span></div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Offline" query={searchQuery} /></h2>
            <p className="sp-section__desc"><HighlightMatch text="Configure offline sync and email caching." query={searchQuery} /></p>

            {/* Toggle */}
            <div className="sp-toggle-row">
                <div className="sp-toggle-row__info">
                    <span className="sp-toggle-row__label"><HighlightMatch text="Enable Offline Mode" query={searchQuery} /></span>
                    <span className="sp-toggle-row__sub"><HighlightMatch text="Download emails locally for offline access" query={searchQuery} /></span>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={offlineEnabled}
                    className={`sp-toggle ${offlineEnabled ? 'on' : ''}`}
                    onClick={() => setOfflineEnabled((v) => !v)}
                >
                    <span className="sp-toggle__knob" />
                </button>
            </div>

            {offlineEnabled && (
                <>
                    <div className="sp-section-divider" style={{ margin: '20px 0' }} />

                    {/* Mailbox selector */}
                    <div className="sp-off-section">
                        <h3 className="sp-off-section__title"><HighlightMatch text="Folders & Labels to Sync" query={searchQuery} /></h3>
                        {mailboxLoading ? (
                            <div className="sp-loading-row"><div className="sp-spinner" /><span>Loading mailboxes…</span></div>
                        ) : mailboxError ? (
                            <div className="sp-off-error">
                                <p>{mailboxError}</p>
                                <button type="button" className="sp-ghost-btn" onClick={fetchMailboxes}>Try again</button>
                            </div>
                        ) : (
                            <div className="sp-off-tree">{tree.map((node) => renderNode(node))}</div>
                        )}
                    </div>

                    <div className="sp-section-divider" style={{ margin: '20px 0' }} />

                    {/* Download policy */}
                    <div className="sp-off-section">
                        <h3 className="sp-off-section__title"><HighlightMatch text="Initial Download Policy" query={searchQuery} /></h3>
                        <div className="sp-radio-group">
                            {[
                                { value: 'all', label: 'All Emails' },
                                { value: 'by_days', label: 'By Days' },
                                { value: 'by_count', label: 'By Mail Count' },
                            ].map(({ value, label }) => (
                                <label key={value} className="sp-radio-label">
                                    <input
                                        type="radio"
                                        name="offlinePolicyMode"
                                        value={value}
                                        checked={policyMode === value}
                                        onChange={() => setPolicyMode(value)}
                                    />
                                    <HighlightMatch text={label} query={searchQuery} />
                                </label>
                            ))}
                        </div>
                        {policyMode !== 'all' && (
                            <input
                                className="sp-number-input"
                                type="number"
                                min="1"
                                value={policyValue}
                                placeholder={policyMode === 'by_days' ? '30' : '1000'}
                                onChange={(e) => setPolicyValue(e.target.value)}
                            />
                        )}
                        <label className="sp-checkbox-label" style={{ marginTop: '14px' }}>
                            <input
                                type="checkbox"
                                checked={cacheRawRfc822}
                                onChange={(e) => setCacheRawRfc822(e.target.checked)}
                            />
                            <span><HighlightMatch text="Cache attachments for offline use" query={searchQuery} /></span>
                        </label>
                    </div>
                </>
            )}

            {message && (
                <div className={`sp-form-message sp-form-message--${message.type}`} style={{ marginTop: '16px' }}>
                    {message.text}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: '20px' }}
                disabled={saving || !offlineDirty}
                onClick={handleSave}
            >
                {saving ? 'Saving…' : 'Save Offline Settings'}
            </button>
        </div>
    )
}

/* ─── Encryption settings panel ─────────────────────────────────── */
function EncryptionSettings({ searchQuery = '' }) {
    const [dataEncrypted, setDataEncrypted] = useState(true)
    const [loginPolicy, setLoginPolicy] = useState('pc_only')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [saveMsg, setSaveMsg] = useState(null)
    const [confirmDisable, setConfirmDisable] = useState(false) // show confirmation dialog
    const baselineEncRef = useRef(null)
    const encStateRef = useRef({ dataEncrypted: true, loginPolicy: 'pc_only' })
    useLayoutEffect(() => {
        encStateRef.current = { dataEncrypted, loginPolicy }
    }, [dataEncrypted, loginPolicy])

    // Load from backend on mount
    useEffect(() => {
        let active = true
        fetch(apiUrl('/api/security/settings'))
            .then((r) => r.ok ? r.json() : Promise.reject(r))
            .then((data) => {
                if (!active) return
                const enc = data.data_encrypted !== false
                const pol = data.login_policy || 'pc_only'
                baselineEncRef.current = { dataEncrypted: enc, loginPolicy: pol }
                setDataEncrypted(enc)
                setLoginPolicy(pol)
                setLoading(false)
            })
            .catch(() => { if (active) setLoading(false) })
        return () => { active = false }
    }, [])

    const handleToggleEncryption = () => {
        if (dataEncrypted) {
            // About to disable — show confirmation first
            setConfirmDisable(true)
        } else {
            // Re-enabling is safe — no confirmation needed
            setDataEncrypted(true)
            setSaveMsg(null)
        }
    }

    const confirmDisableEncryption = () => {
        setDataEncrypted(false)
        setConfirmDisable(false)
        setSaveMsg(null)
    }

    const persistEncryptionSettings = useCallback(async () => {
        setSaving(true)
        setSaveMsg(null)
        try {
            const { dataEncrypted: enc, loginPolicy: pol } = encStateRef.current
            const res = await fetch(apiUrl('/api/security/settings'), {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ data_encrypted: enc, login_policy: pol }),
            })
            if (!res.ok) throw new Error('Save failed')
            baselineEncRef.current = { dataEncrypted: enc, loginPolicy: pol }
            setSaveMsg({
                type: 'success',
                text: enc
                    ? '✅ Settings saved.'
                    : '✅ Settings saved. Restart the app — data will be decrypted on next launch.',
            })
        } catch {
            setSaveMsg({ type: 'error', text: '❌ Failed to save settings.' })
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [])

    const handleSave = () => {
        void persistEncryptionSettings().catch(() => {})
    }

    const bEnc = baselineEncRef.current
    const encDirty = !loading && bEnc != null && (
        dataEncrypted !== bEnc.dataEncrypted
        || loginPolicy !== bEnc.loginPolicy
    )
    useSettingsDraft('encryption', 'Encryption', {
        isDirty: encDirty,
        save: persistEncryptionSettings,
        revert: () => {
            const base = baselineEncRef.current
            if (!base) return
            setDataEncrypted(base.dataEncrypted)
            setLoginPolicy(base.loginPolicy)
        },
    })

    const LOGIN_POLICIES = [
        {
            value: 'none',
            label: 'Do not ask for a password',
            sub: 'The app opens without any password prompt',
        },
        {
            value: 'pc_only',
            label: 'PC password only',
            sub: 'Your system keyring protects the encryption key — no extra prompt',
            recommended: true,
        },
        {
            value: 'both',
            label: 'PC password + account password',
            sub: 'Two-step: system keyring unlock + your email account password',
        },
        {
            value: 'account_only',
            label: 'Account password only',
            sub: 'Only your email account password is required on launch',
            unrecommended: true,
        },
    ]

    if (loading) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Encryption" query={searchQuery} /></h2>
                <div className="sp-loading-row"><div className="sp-spinner" /><span>Loading…</span></div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Encryption" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Control how your data is protected at rest and which credential is required on launch." query={searchQuery} />
            </p>

            {/* Disable-encryption confirmation dialog */}
            {confirmDisable && (
                <div className="sp-confirm-box sp-confirm-box--warn">
                    <div className="sp-confirm-box__icon" aria-hidden="true">⚠️</div>
                    <div className="sp-confirm-box__body">
                        <p className="sp-confirm-box__title">Disable encryption?</p>
                        <p className="sp-confirm-box__desc">
                            This will decrypt all locally stored emails and credentials on the next app
                            restart. Your data will be stored as plain SQLite — anyone with file access
                            can read it. <strong>Not recommended.</strong>
                        </p>
                        <div className="sp-confirm-box__actions">
                            <button
                                type="button"
                                className="sp-confirm-btn sp-confirm-btn--danger"
                                onClick={confirmDisableEncryption}
                            >
                                Disable encryption (not recommended)
                            </button>
                            <button
                                type="button"
                                className="sp-ghost-btn"
                                onClick={() => setConfirmDisable(false)}
                            >
                                Cancel
                            </button>
                        </div>
                    </div>
                </div>
            )}

            {/* Data encryption toggle */}
            <div className="sp-toggle-row" style={{ marginBottom: '20px' }}>
                <div className="sp-toggle-row__info">
                    <span className="sp-toggle-row__label">
                        <HighlightMatch text="Encrypt stored data" query={searchQuery} />
                        {dataEncrypted
                            ? <span className="sp-badge sp-badge--recommended">Recommended</span>
                            : <span className="sp-badge sp-badge--warn">Not recommended</span>}
                    </span>
                    <span className="sp-toggle-row__sub">
                        <HighlightMatch
                            text={dataEncrypted
                                ? 'AES-256 (SQLCipher + XChaCha20) — all local data is encrypted'
                                : 'Encryption disabled — data stored as plaintext SQLite'}
                            query={searchQuery}
                        />
                    </span>
                </div>
                <button
                    type="button"
                    role="switch"
                    aria-checked={dataEncrypted}
                    className={`sp-toggle ${dataEncrypted ? 'on' : ''}`}
                    onClick={handleToggleEncryption}
                >
                    <span className="sp-toggle__knob" />
                </button>
            </div>

            <div className="sp-section-divider" style={{ margin: '0 0 20px' }} />

            {/* Login password policy */}
            <div className="sp-enc-policy">
                <h3 className="sp-off-section__title"><HighlightMatch text="Password prompt on launch" query={searchQuery} /></h3>
                <div className="sp-enc-policy-list">
                    {LOGIN_POLICIES.map(({ value, label, sub, recommended, unrecommended }) => (
                        <label
                            key={value}
                            className={`sp-policy-card ${loginPolicy === value ? 'active' : ''} ${unrecommended ? 'unrecommended' : ''}`}
                        >
                            <input
                                type="radio"
                                name="loginPolicy"
                                value={value}
                                checked={loginPolicy === value}
                                onChange={() => setLoginPolicy(value)}
                            />
                            <div className="sp-policy-card__body">
                                <span className="sp-policy-card__label">
                                    <HighlightMatch text={label} query={searchQuery} />
                                    {recommended && <span className="sp-badge sp-badge--recommended">Recommended</span>}
                                    {unrecommended && <span className="sp-badge sp-badge--warn">Not recommended</span>}
                                </span>
                                <span className="sp-policy-card__sub"><HighlightMatch text={sub} query={searchQuery} /></span>
                            </div>
                        </label>
                    ))}
                </div>
            </div>

            {saveMsg && (
                <div className={`sp-form-message sp-form-message--${saveMsg.type}`} style={{ marginTop: '16px' }}>
                    {saveMsg.text}
                </div>
            )}

            <button
                type="button"
                className="sp-save-btn"
                style={{ marginTop: '20px' }}
                onClick={handleSave}
                disabled={saving || !encDirty}
            >
                {saving ? 'Saving…' : 'Save Settings'}
            </button>
        </div>
    )
}

/* ─── Blocked Senders setting panel ─────────────────────────────────── */
function blockedRuleToActionKey(rule) {
    if (rule.action_type === 'delete') return 'Delete'
    const f = (rule.target_folder || '').trim()
    const tail = f.split('/').pop() || f
    if (tail === 'Trash' || f === 'Trash') return 'Trash'
    if (tail === 'Spam' || f === 'Spam') return 'Spam'
    if (tail === 'Archive' || f === 'Archive') return 'Archive'
    return 'Folder'
}

/** @returns {{ action_type: string, target_folder: string | null } | null} */
function buildBlockedSenderActionPayload(actionKey, folderWhenFolderOption) {
    let targetFolder = null
    let actionEnum = 'move'
    if (actionKey === 'Delete') actionEnum = 'delete'
    else if (actionKey === 'Archive') targetFolder = 'Archive'
    else if (actionKey === 'Spam') targetFolder = 'Spam'
    else if (actionKey === 'Folder') {
        if (!folderWhenFolderOption) return null
        targetFolder = folderWhenFolderOption
    } else {
        targetFolder = 'Trash'
    }
    return { action_type: actionEnum, target_folder: targetFolder }
}

function BlockedSendersSettings({ accountId, searchQuery = '' }) {
    const [rules, setRules] = useState([])
    const [loading, setLoading] = useState(true)
    const [actioning, setActioning] = useState(false)
    const [updatingRuleId, setUpdatingRuleId] = useState(null)
    const [message, setMessage] = useState(null)
    const [newSender, setNewSender] = useState('')
    const [newAction, setNewAction] = useState('Trash')
    const [folders, setFolders] = useState([])
    const [newTargetFolder, setNewTargetFolder] = useState('')
    // Pending action changes for existing rules (key: rule.id, value: actionKey)
    const [pendingActions, setPendingActions] = useState({})

    const fetchRules = useCallback(async () => {
        if (!accountId) return
        setLoading(true)
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/blocked-senders`))
            if (res.ok) setRules(await res.json())
        } catch (e) {
            setMessage({ type: 'error', text: 'Failed to load blocked senders' })
        } finally {
            setLoading(false)
        }
    }, [accountId])

    const fetchFolders = useCallback(async () => {
        if (!accountId) return
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`))
            if (res.ok) {
                const data = await res.json()
                const f = Array.isArray(data.folders) ? data.folders : []
                setFolders(f)
                if (f.length > 0) setNewTargetFolder((prev) => prev || f[0])
            }
        } catch (e) {}
    }, [accountId])

    useEffect(() => {
        fetchRules()
        fetchFolders()
    }, [fetchRules, fetchFolders])

    const unblock = async (id) => {
        if (!accountId) return
        setActioning(true)
        setMessage(null)
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/blocked-senders/${id}`), { method: 'DELETE' })
            if (!res.ok) throw new Error()
            setRules((prev) => prev.filter((r) => r.id !== id))
            setMessage({ type: 'success', text: 'Unblocked successfully.' })
        } catch {
            setMessage({ type: 'error', text: 'Failed to unblock sender.' })
        } finally {
            setActioning(false)
        }
    }

    const patchRuleAction = async (rule, actionKey, folderPath) => {
        if (!accountId) return
        let folderForMove = folderPath
        if (actionKey === 'Folder') {
            folderForMove = folderForMove || rule.target_folder || folders[0] || ''
            if (!folderForMove) {
                setMessage({ type: 'error', text: 'Please select a specific folder.' })
                return
            }
        }
        const payload = buildBlockedSenderActionPayload(actionKey, actionKey === 'Folder' ? folderForMove : undefined)
        if (!payload) {
            setMessage({ type: 'error', text: 'Please select a specific folder.' })
            return
        }
        setUpdatingRuleId(rule.id)
        setMessage(null)
        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/blocked-senders/${rule.id}`), {
                method: 'PATCH',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    action_type: payload.action_type,
                    target_folder: payload.target_folder,
                }),
            })
            if (!res.ok) throw new Error()
            const updated = await res.json()
            setRules((prev) => prev.map((r) => (r.id === rule.id ? updated : r)))
            setMessage({ type: 'success', text: 'Rule updated.' })
        } catch {
            setMessage({ type: 'error', text: 'Failed to update rule.' })
            await fetchRules()
        } finally {
            setUpdatingRuleId(null)
        }
    }

    const addRule = async (e) => {
        e.preventDefault()
        if (!accountId || !newSender) return
        setActioning(true)
        setMessage(null)
        const payload = buildBlockedSenderActionPayload(newAction, newAction === 'Folder' ? newTargetFolder : undefined)
        if (!payload) {
            setMessage({ type: 'error', text: 'Please select a specific folder.' })
            setActioning(false)
            return
        }

        try {
            const res = await fetch(apiUrl(`/api/offline/${accountId}/blocked-senders`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    sender: newSender.trim(),
                    action_type: payload.action_type,
                    target_folder: payload.target_folder,
                    apply_to_existing: false,
                }),
            })
            if (!res.ok) throw new Error()
            const created = await res.json()
            setRules((prev) => [created, ...prev])
            setNewSender('')
            setMessage({ type: 'success', text: 'Added to blocked list.' })
        } catch {
            setMessage({ type: 'error', text: 'Failed to add block rule.' })
        } finally {
            setActioning(false)
        }
    }

    const rowBusy = (id) => actioning || updatingRuleId === id

    if (loading) {
        return (
            <div className="sp-section">
                <h2 className="sp-section__title"><HighlightMatch text="Blocked Senders" query={searchQuery} /></h2>
                <div className="sp-loading-row"><div className="sp-spinner" /><span>Loading…</span></div>
            </div>
        )
    }

    const selectStyle = {
        minWidth: '140px',
        width: 'auto',
        border: '1px solid var(--border-color)',
        padding: '0 12px',
        borderRadius: '6px',
        backgroundColor: 'var(--bg-secondary)',
        color: 'var(--text-color)',
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Blocked Senders" query={searchQuery} /></h2>
            <p className="sp-section__desc"><HighlightMatch text="Manage email addresses that are automatically deleted, moved to spam, or archived." query={searchQuery} /></p>

            <form onSubmit={addRule} className="sp-add-block-form" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px', marginBottom: '20px' }}>
                <input
                    type="text"
                    className="sp-search-input"
                    placeholder="example@spam.com"
                    value={newSender}
                    onChange={(e) => setNewSender(e.target.value)}
                    style={{ flex: '1 1 180px', border: '1px solid var(--border-color)', padding: '0 12px', borderRadius: '6px', backgroundColor: 'var(--bg-secondary)', color: 'var(--text-color)' }}
                    required
                />
                <select
                    className="sp-search-input"
                    value={newAction}
                    onChange={(e) => setNewAction(e.target.value)}
                    style={selectStyle}
                >
                    <option value="Trash">Move to Trash</option>
                    <option value="Spam">Move to Spam</option>
                    <option value="Delete">Delete</option>
                    <option value="Archive">Archive</option>
                    <option value="Folder">Move to Folder...</option>
                </select>

                {newAction === 'Folder' && (
                    <select
                        className="sp-search-input"
                        value={newTargetFolder}
                        onChange={(e) => setNewTargetFolder(e.target.value)}
                        style={selectStyle}
                    >
                        <option value="" disabled>Select Folder...</option>
                        {folders.map((f) => (
                            <option key={f} value={f}>{f.split('/').pop() || f}</option>
                        ))}
                    </select>
                )}

                <button type="submit" className="sp-save-btn" disabled={actioning} style={{ padding: '0 16px', margin: 0, height: '36px' }}>Add</button>
            </form>

            <div className="sp-block-list" style={{ border: '1px solid var(--border-color)', borderRadius: '6px', overflow: 'hidden' }}>
                {rules.length === 0 ? (
                    <div style={{ padding: '16px', textAlign: 'center', color: 'var(--text-muted)', fontSize: '13px' }}>
                        No blocked senders.
                    </div>
                ) : (
                    rules.map((r) => {
                        const currentActionKey = pendingActions[r.id] || blockedRuleToActionKey(r)
                        const busy = rowBusy(r.id)
                        return (
                            <div
                                key={r.id}
                                style={{
                                    display: 'flex',
                                    flexWrap: 'wrap',
                                    justifyContent: 'space-between',
                                    alignItems: 'center',
                                    gap: '10px',
                                    padding: '10px 16px',
                                    borderBottom: '1px solid var(--border-color)',
                                    fontSize: '13px',
                                }}
                            >
                                <div style={{ flex: '1 1 160px', minWidth: 0 }}>
                                    <div style={{ fontWeight: 500, color: 'var(--text-color)' }}>{r.sender}</div>
                                    <div style={{ color: 'var(--text-muted)', fontSize: '12px', marginTop: '2px' }}>
                                        {r.action_type === 'delete' ? 'Delete immediately' : `Move to ${r.target_folder || '—'}`}
                                    </div>
                                </div>
                                <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '8px' }}>
                                    <select
                                        className="sp-search-input"
                                        value={currentActionKey}
                                        disabled={busy}
                                        onChange={(e) => {
                                            const next = e.target.value
                                            if (next === 'Folder') {
                                                // Show folder dropdown, don't call API yet
                                                setPendingActions(prev => ({ ...prev, [r.id]: 'Folder' }))
                                                return
                                            }
                                            // For other actions, update immediately and clear pending
                                            setPendingActions(prev => { const p = { ...prev }; delete p[r.id]; return p })
                                            void patchRuleAction(r, next, undefined)
                                        }}
                                        style={selectStyle}
                                        aria-label="Action for blocked sender"
                                    >
                                        <option value="Trash">Move to Trash</option>
                                        <option value="Spam">Move to Spam</option>
                                        <option value="Delete">Delete</option>
                                        <option value="Archive">Archive</option>
                                        <option value="Folder">Move to Folder...</option>
                                    </select>
                                    {currentActionKey === 'Folder' && (() => {
                                        const tf = r.target_folder || ''
                                        const rowFolderOpts = tf && !folders.includes(tf) ? [tf, ...folders] : folders
                                        const folderValue = rowFolderOpts.includes(tf) ? tf : (rowFolderOpts[0] || '')
                                        return (
                                            <select
                                                className="sp-search-input"
                                                value={folderValue}
                                                disabled={busy || rowFolderOpts.length === 0}
                                                onChange={(e) => {
                                                    // Clear pending action and call API
                                                    setPendingActions(prev => { const p = { ...prev }; delete p[r.id]; return p })
                                                    void patchRuleAction(r, 'Folder', e.target.value)
                                                }}
                                                style={selectStyle}
                                                aria-label="Target folder"
                                            >
                                                {rowFolderOpts.length === 0 ? (
                                                    <option value="">No folders</option>
                                                ) : (
                                                    rowFolderOpts.map((f) => (
                                                        <option key={f} value={f}>{f.split('/').pop() || f}</option>
                                                    ))
                                                )}
                                            </select>
                                        )
                                    })()}
                                    <button
                                        type="button"
                                        onClick={() => unblock(r.id)}
                                        disabled={busy}
                                        className="sp-save-btn"
                                        style={{ padding: '0 16px', margin: 0, height: '36px', backgroundColor: '#ffdd6e', borderColor: '#ffc107' }}
                                    >
                                        Unblock
                                    </button>
                                </div>
                            </div>
                        )
                    })
                )}
            </div>

            {message && (
                <div className={`sp-form-message sp-form-message--${message.type}`} style={{ marginTop: '16px' }}>
                    {message.text}
                </div>
            )}
        </div>
    )
}

function isLabelMailbox(value) {
    return /^(Labels|Labels|\[Labels\])(\/|$)/i.test((value || '').trim())
}
function isMailboxSectionRoot(value) {
    return ['Folders', 'Labels', 'Labels'].includes((value || '').trim())
}
const MAILBOX_COUNT_DISPLAY_OPTIONS = [
    { value: 'unread_only', label: 'Unread count only' },
    { value: 'total_only', label: 'Total count only' },
    { value: 'both', label: 'Both counts' },
    { value: 'none', label: 'Hide counts' },
]

function MailboxListCountDisplaySettings({ accountId, onRefreshAccount, searchQuery = '' }) {
    const [mode, setMode] = useState('both')
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState(null)
    const baselineModeRef = useRef(null)

    useEffect(() => {
        if (!accountId) {
            setLoading(false)
            return
        }
        let active = true
        fetch(apiUrl(`/api/account/${accountId}/settings`), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(r)))
            .then((data) => {
                if (!active) return
                const m = ((data.mailboxCountDisplay ?? data.mailbox_count_display) || 'both').toString().toLowerCase()
                const next = ['unread_only', 'total_only', 'both', 'none'].includes(m) ? m : 'both'
                baselineModeRef.current = next
                setMode(next)
                setLoading(false)
            })
            .catch(() => {
                if (active) setLoading(false)
            })
        return () => {
            active = false
        }
    }, [accountId])

    const modeRef = useRef(mode)
    useLayoutEffect(() => {
        modeRef.current = mode
    }, [mode])

    const persistMailboxCountMode = useCallback(async () => {
        if (!accountId) return
        setSaving(true)
        setMessage(null)
        try {
            const current = modeRef.current
            const resp = await fetch(apiUrl(`/api/account/${accountId}/mailbox-count-display`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ mode: current }),
            })
            if (!resp.ok) throw new Error('Save failed')
            baselineModeRef.current = current
            setMessage({ type: 'success', text: '✅ Sidebar counts preference saved.' })
            if (onRefreshAccount) onRefreshAccount()
        } catch {
            setMessage({ type: 'error', text: '❌ Failed to save.' })
            throw new Error('save_failed')
        } finally {
            setSaving(false)
        }
    }, [accountId, onRefreshAccount])

    const handleSave = () => {
        void persistMailboxCountMode().catch(() => {})
    }

    const countDirty = !loading && baselineModeRef.current != null && mode !== baselineModeRef.current
    useSettingsDraft('mailbox-count-display', 'Sidebar counts', {
        isDirty: countDirty,
        save: persistMailboxCountMode,
        revert: () => {
            if (baselineModeRef.current != null) setMode(baselineModeRef.current)
        },
    })

    if (loading) {
        return (
            <div className="sp-section">
                <div className="sp-loading-row">
                    <div className="sp-spinner" />
                    <span>Loading…</span>
                </div>
            </div>
        )
    }

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Sidebar mail counts" query={searchQuery} /></h2>
            <p className="sp-section__desc">
                <HighlightMatch text="Choose how unread and total message counts appear next to each mailbox and label in the sidebar." query={searchQuery} />
            </p>
            <div className="sp-radio-group sp-radio-group--stacked">
                {MAILBOX_COUNT_DISPLAY_OPTIONS.map((opt) => (
                    <label key={opt.value} className="sp-radio-label">
                        <input
                            type="radio"
                            name="mailboxCountDisplay"
                            value={opt.value}
                            checked={mode === opt.value}
                            onChange={() => setMode(opt.value)}
                        />
                        <HighlightMatch text={opt.label} query={searchQuery} />
                    </label>
                ))}
            </div>
            {message && (
                <div className={`sp-form-message sp-form-message--${message.type}`} style={{ marginTop: 16 }}>
                    {message.text}
                </div>
            )}
            <button type="button" className="sp-save-btn" style={{ marginTop: 20 }} onClick={handleSave} disabled={saving || !countDirty}>
                {saving ? 'Saving…' : 'Save'}
            </button>
        </div>
    )
}

/* ─── Mailbox and Label list (order) settings ────────────────────────── */
function MailboxOrderSettings({ accountId, onRefreshAccount, searchQuery = '' }) {
    const [mailboxes, setMailboxes] = useState([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState(null)
    const baselineMailboxJsonRef = useRef(null)
    const mailboxesRef = useRef(mailboxes)
    useLayoutEffect(() => {
        mailboxesRef.current = mailboxes
    }, [mailboxes])

    const loadSettings = useCallback(async () => {
        if (!accountId) return
        setLoading(true)
        try {
            const [boxRes, setRes] = await Promise.all([
                fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' }),
                fetch(apiUrl(`/api/account/${accountId}/settings`), { cache: 'no-store' }),
            ])
            const boxData = await boxRes.json()
            const setData = await setRes.json()

            const normalized = normalizeMailboxResponse(boxData)
            let list = dedupeStringsCaseInsensitive(normalized.allMailboxes).filter(
                (m) => !isLabelMailbox(m) && !isMailboxSectionRoot(m),
            )

            const savedOrder = parseSavedOrderFromSettings(setData, 'mailboxOrder', 'mailbox_order')
            list = sortWithSavedOrder(list, savedOrder, compareMailboxesDefaultOrder)
            baselineMailboxJsonRef.current = JSON.stringify(list)
            setMailboxes(list)
        } catch (err) {
            console.error(err)
        } finally {
            setLoading(false)
        }
    }, [accountId])

    useEffect(() => {
        loadSettings()
    }, [loadSettings])

    const move = (index, direction) => {
        const next = [...mailboxes]
        const target = index + direction
        if (target < 0 || target >= next.length) return
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        setMailboxes(next)
    }

    const persistMailboxOrder = useCallback(async () => {
        if (!accountId) return
        setSaving(true)
        setMessage(null)
        try {
            const order = mailboxesRef.current
            const resp = await fetch(apiUrl(`/api/account/${accountId}/mailbox-order`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order }),
            })
            if (!resp.ok) throw new Error('Save failed')
            baselineMailboxJsonRef.current = JSON.stringify(order)
            setMessage({ type: 'success', text: '✅ Mailbox order saved.' })
            if (onRefreshAccount) onRefreshAccount()
        } catch (err) {
            setMessage({ type: 'error', text: `❌ Error: ${err.message}` })
            throw err
        } finally {
            setSaving(false)
        }
    }, [accountId, onRefreshAccount])

    const handleSave = () => {
        void persistMailboxOrder().catch(() => {})
    }

    const orderDirty = !loading
        && baselineMailboxJsonRef.current != null
        && JSON.stringify(mailboxes) !== baselineMailboxJsonRef.current
    useSettingsDraft('mailbox-order', 'Mailbox order', {
        isDirty: orderDirty,
        save: persistMailboxOrder,
        revert: () => {
            const raw = baselineMailboxJsonRef.current
            if (raw != null) setMailboxes(JSON.parse(raw))
        },
    })

    const handleReset = () => {
        setMailboxes((prev) => sortWithSavedOrder([...prev], [], compareMailboxesDefaultOrder))
    }

    if (loading) return <div className="sp-section"><div className="sp-loading-row"><div className="sp-spinner" /><span>Loading…</span></div></div>

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Mailbox list" query={searchQuery} /></h2>
            <p className="sp-section__desc"><HighlightMatch text="Use the arrows to reorder mailboxes in the sidebar." query={searchQuery} /></p>
            <div className="sp-order-list">
                {mailboxes.map((m, i) => (
                    <div key={m} className="sp-order-item">
                        <span className="sp-order-item__label"><HighlightMatch text={m.split('/').pop() || m} query={searchQuery} /></span>
                        <div className="sp-order-item__actions">
                            <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                            <button onClick={() => move(i, 1)} disabled={i === mailboxes.length - 1}>↓</button>
                        </div>
                    </div>
                ))}
            </div>
            {message && <div className={`sp-form-message sp-form-message--${message.type}`} style={{marginTop: 16}}>{message.text}</div>}
            <div style={{display: 'flex', gap: 12, marginTop: 20}}>
                <button className="sp-save-btn" onClick={handleSave} disabled={saving || !orderDirty}>Save Order</button>
                <button className="sp-save-btn" style={{background: 'var(--c-surface-3)', color: 'var(--c-text-1)'}} onClick={handleReset} disabled={saving}>Reset to Default</button>
            </div>
        </div>
    )
}

function LabelOrderSettings({ accountId, onRefreshAccount, searchQuery = '' }) {
    const [labels, setLabels] = useState([])
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [message, setMessage] = useState(null)
    const baselineLabelsJsonRef = useRef(null)
    const labelsRef = useRef(labels)
    useLayoutEffect(() => {
        labelsRef.current = labels
    }, [labels])

    const loadSettings = useCallback(async () => {
        if (!accountId) return
        setLoading(true)
        try {
            const [boxRes, setRes] = await Promise.all([
                fetch(apiUrl(`/api/offline/${accountId}/local-mailboxes`), { cache: 'no-store' }),
                fetch(apiUrl(`/api/account/${accountId}/settings`), { cache: 'no-store' }),
            ])
            const boxData = await boxRes.json()
            const setData = await setRes.json()

            const normalized = normalizeMailboxResponse(boxData)
            let list = dedupeStringsCaseInsensitive(normalized.labels)

            const savedOrder = parseSavedOrderFromSettings(setData, 'labelOrder', 'label_order')
            list = sortWithSavedOrder(list, savedOrder, (a, b) => a.localeCompare(b))
            baselineLabelsJsonRef.current = JSON.stringify(list)
            setLabels(list)
        } catch (err) {
            console.error(err)
        } finally {
            setLoading(false)
        }
    }, [accountId])

    useEffect(() => {
        loadSettings()
    }, [loadSettings])

    const move = (index, direction) => {
        const next = [...labels]
        const target = index + direction
        if (target < 0 || target >= next.length) return
        const [moved] = next.splice(index, 1)
        next.splice(target, 0, moved)
        setLabels(next)
    }

    const persistLabelOrder = useCallback(async () => {
        if (!accountId) return
        setSaving(true)
        setMessage(null)
        try {
            const order = labelsRef.current
            const resp = await fetch(apiUrl(`/api/account/${accountId}/label-order`), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ order }),
            })
            if (!resp.ok) throw new Error('Save failed')
            baselineLabelsJsonRef.current = JSON.stringify(order)
            setMessage({ type: 'success', text: '✅ Label order saved.' })
            if (onRefreshAccount) onRefreshAccount()
        } catch (err) {
            setMessage({ type: 'error', text: `❌ Error: ${err.message}` })
            throw err
        } finally {
            setSaving(false)
        }
    }, [accountId, onRefreshAccount])

    const handleSave = () => {
        void persistLabelOrder().catch(() => {})
    }

    const labelOrderDirty = !loading
        && baselineLabelsJsonRef.current != null
        && JSON.stringify(labels) !== baselineLabelsJsonRef.current
    useSettingsDraft('label-order', 'Label order', {
        isDirty: labelOrderDirty,
        save: persistLabelOrder,
        revert: () => {
            const raw = baselineLabelsJsonRef.current
            if (raw != null) setLabels(JSON.parse(raw))
        },
    })

    const handleReset = () => {
        setLabels((prev) => sortWithSavedOrder([...prev], [], (a, b) => a.localeCompare(b)))
    }

    if (loading) return <div className="sp-section"><div className="sp-loading-row"><div className="sp-spinner" /><span>Loading…</span></div></div>

    return (
        <div className="sp-section">
            <h2 className="sp-section__title"><HighlightMatch text="Label list" query={searchQuery} /></h2>
            <p className="sp-section__desc"><HighlightMatch text="Reorder labels in the sidebar using the arrows below." query={searchQuery} /></p>
            <div className="sp-order-list">
                {labels.length === 0 && <div className="sp-empty-row">No labels found.</div>}
                {labels.map((m, i) => (
                    <div key={m} className="sp-order-item">
                        <span className="sp-order-item__label"><HighlightMatch text={m.split('/').pop() || m} query={searchQuery} /></span>
                        <div className="sp-order-item__actions">
                            <button onClick={() => move(i, -1)} disabled={i === 0}>↑</button>
                            <button onClick={() => move(i, 1)} disabled={i === labels.length - 1}>↓</button>
                        </div>
                    </div>
                ))}
            </div>
            {message && <div className={`sp-form-message sp-form-message--${message.type}`} style={{marginTop: 16}}>{message.text}</div>}
            <div style={{display: 'flex', gap: 12, marginTop: 20}}>
                <button className="sp-save-btn" onClick={handleSave} disabled={saving || !labelOrderDirty}>Save Order</button>
                <button className="sp-save-btn" style={{background: 'var(--c-surface-3)', color: 'var(--c-text-1)'}} onClick={handleReset} disabled={saving}>Reset to Default</button>
            </div>
        </div>
    )
}
/* ─── Content renderer ──────────────────────────────────────────── */
function renderContent(selection, accountId, onClose, onRefreshAccount, searchQuery = '', appearance) {
    if (!selection) return null

    const parentCat = CATEGORIES.find((c) => c.id === selection)
    if (parentCat) {
        return parentCat.children.map((child, idx) => (
            <React.Fragment key={child.id}>
                {renderSinglePanel(child.id, accountId, onClose, onRefreshAccount, searchQuery, appearance)}
                {idx < parentCat.children.length - 1 && <div className="sp-section-divider" />}
            </React.Fragment>
        ))
    }

    return renderSinglePanel(selection, accountId, onClose, onRefreshAccount, searchQuery, appearance)
}

function renderSinglePanel(id, accountId, onClose, onRefreshAccount, searchQuery = '', appearance) {
    const q = searchQuery.trim().toLowerCase()
    const {
        themeDraft,
        setThemeDraft,
        themeBaselineRef,
        fontDraft,
        setFontDraft,
        fontBaselineRef,
        fontReady,
        toolbarStyleDraft,
        setToolbarStyleDraft,
        toolbarStyleBaselineRef,
        toolbarStyleReady,
    } = appearance
    switch (id) {
        case 'theme': return (
            <ThemeSettings
                accountId={accountId}
                searchQuery={q}
                themeDraft={themeDraft}
                setThemeDraft={setThemeDraft}
                themeBaselineRef={themeBaselineRef}
            />
        )
        case 'font': return (
            <FontSettings
                accountId={accountId}
                searchQuery={q}
                fontDraft={fontDraft}
                setFontDraft={setFontDraft}
                fontBaselineRef={fontBaselineRef}
                fontReady={fontReady}
            />
        )
        case 'layout': return (
            <LayoutSettings
                accountId={accountId}
                searchQuery={q}
                layoutDraft={appearance.layoutDraft}
                setLayoutDraft={appearance.setLayoutDraft}
                layoutBaselineRef={appearance.layoutBaselineRef}
                layoutReady={appearance.layoutReady}
            />
        )
        case 'toolbar': return (
            <ToolbarSettings
                accountId={accountId}
                searchQuery={q}
                toolbarStyleDraft={toolbarStyleDraft}
                setToolbarStyleDraft={setToolbarStyleDraft}
                toolbarStyleBaselineRef={toolbarStyleBaselineRef}
                toolbarStyleReady={toolbarStyleReady}
            />
        )
        case 'mailbox_label_list': return (
            <>
                <MailboxListCountDisplaySettings accountId={accountId} onRefreshAccount={onRefreshAccount} searchQuery={q} />
                <div className="sp-section-divider" style={{ margin: '32px 0' }} />
                <MailboxOrderSettings accountId={accountId} onRefreshAccount={onRefreshAccount} searchQuery={q} />
                <div className="sp-section-divider" style={{ margin: '40px 0' }} />
                <LabelOrderSettings accountId={accountId} onRefreshAccount={onRefreshAccount} searchQuery={q} />
            </>
        )
        case 'imap': return <ServerSettings accountId={accountId} type="imap" key={`imap-${accountId}`} searchQuery={q} />
        case 'smtp': return <ServerSettings accountId={accountId} type="smtp" key={`smtp-${accountId}`} searchQuery={q} />
        case 'offline': return <OfflineSettings accountId={accountId} key={`offline-${accountId}`} searchQuery={q} />
        case 'blocked': return <BlockedSendersSettings accountId={accountId} key={`blocked-${accountId}`} searchQuery={q} />
        case 'encryption': return <EncryptionSettings searchQuery={q} />
        default: return null
    }
}

/* ─── Main component ────────────────────────────────────────────── */
function SettingsPage(props) {
    const { onClose, onRefreshAccount } = props
    const [search, setSearch] = useState('')
    const searchQuery = search.trim().toLowerCase()
    const filteredCategories = useMemo(() => {
        if (!searchQuery) return CATEGORIES
        return CATEGORIES
            .map((cat) => {
                const catMatches = cat.label.toLowerCase().includes(searchQuery)
                const filteredChildren = cat.children.filter((ch) => {
                    const labelMatches = ch.label.toLowerCase().includes(searchQuery)
                    const contentMatches = panelMatchesSearch(ch.id, searchQuery)
                    return labelMatches || contentMatches
                })
                if (catMatches || filteredChildren.length > 0) {
                    return { ...cat, children: catMatches ? cat.children : filteredChildren }
                }
                return null
            })
            .filter(Boolean)
    }, [searchQuery])
    const [expanded, setExpanded] = useState({ appearance: true, email: true, security: true })
    const [selected, setSelected] = useState('appearance')
    const searchRef = useRef(null)

    const draftsRef = useRef(new Map())
    const [draftTick, setDraftTick] = useState(0)
    const bumpDrafts = useCallback(() => setDraftTick((t) => t + 1), [])
    const registerDraft = useCallback(
        (id, entry) => {
            draftsRef.current.set(id, entry)
            bumpDrafts()
        },
        [bumpDrafts],
    )
    const unregisterDraft = useCallback(
        (id) => {
            if (draftsRef.current.delete(id)) bumpDrafts()
        },
        [bumpDrafts],
    )
    const draftContextValue = useMemo(
        () => ({ register: registerDraft, unregister: unregisterDraft }),
        [registerDraft, unregisterDraft],
    )

    const dirtyDraftEntries = useMemo(
        () => Array.from(draftsRef.current.entries()).map(([id, data]) => ({ id, ...data })),
        [draftTick],
    )
    const dirtyCount = dirtyDraftEntries.length

    const [dockExpanded, setDockExpanded] = useState(false)
    const [dockSaving, setDockSaving] = useState(false)
    const [rowSavingId, setRowSavingId] = useState(null)
    const [quitOpen, setQuitOpen] = useState(false)

    const themeBaselineRef = useRef(getStoredThemePreference())
    const [themeDraft, setThemeDraft] = useState(() => ({ ...getStoredThemePreference() }))
    const fontBaselineRef = useRef((localStorage.getItem('font') || 'Inter').trim() || 'Inter')
    const [fontDraft, setFontDraft] = useState(() => fontBaselineRef.current)
    const [fontReady, setFontReady] = useState(false)

    const layoutBaselineRef = useRef(null)
    const [layoutDraft, setLayoutDraft] = useState(null)
    const [layoutReady, setLayoutReady] = useState(false)
    const toolbarStyleBaselineRef = useRef('icon_text_small')
    const [toolbarStyleDraft, setToolbarStyleDraft] = useState('icon_text_small')
    const [toolbarStyleReady, setToolbarStyleReady] = useState(false)

    const finalizeClose = useCallback(() => {
        setQuitOpen(false)
        onClose()
    }, [onClose])

    const requestClose = useCallback(() => {
        if (quitOpen) {
            setQuitOpen(false)
            return
        }
        if (draftsRef.current.size > 0) {
            setQuitOpen(true)
            return
        }
        onClose()
    }, [onClose, quitOpen])

    const runSaveAll = useCallback(async () => {
        const entries = Array.from(draftsRef.current.values())
        for (const e of entries) {
            await e.save()
        }
        if (onRefreshAccount) await onRefreshAccount()
    }, [onRefreshAccount])

    const handleDockSaveAll = useCallback(async () => {
        setDockSaving(true)
        try {
            await runSaveAll()
        } catch (err) {
            console.error(err)
        } finally {
            setDockSaving(false)
        }
    }, [runSaveAll])

    const handleDockRevertAll = useCallback(() => {
        Array.from(draftsRef.current.values()).forEach((e) => e.revert())
    }, [])

    const handleQuitSaveAll = useCallback(async () => {
        setDockSaving(true)
        try {
            await runSaveAll()
            finalizeClose()
        } catch (err) {
            console.error(err)
        } finally {
            setDockSaving(false)
        }
    }, [runSaveAll, finalizeClose])

    const handleQuitDiscard = useCallback(() => {
        Array.from(draftsRef.current.values()).forEach((e) => e.revert())
        finalizeClose()
    }, [finalizeClose])

    const handleRowSave = useCallback(
        async (rowId) => {
            const e = draftsRef.current.get(rowId)
            if (!e) return
            setRowSavingId(rowId)
            try {
                await e.save()
                if (onRefreshAccount) await onRefreshAccount()
            } catch (err) {
                console.error(err)
            } finally {
                setRowSavingId(null)
            }
        },
        [onRefreshAccount],
    )

    const handleRowRevert = useCallback((rowId) => {
        const e = draftsRef.current.get(rowId)
        if (e) e.revert()
    }, [])

    // Get current account id from localStorage
    const accountId = useMemo(() => {
        const id = localStorage.getItem('current_account_id')
        return id ? Number(id) : null
    }, [])

    useEffect(() => {
        if (!accountId) {
            const f = (localStorage.getItem('font') || 'Inter').trim() || 'Inter'
            fontBaselineRef.current = f
            setFontDraft(f)
            applyAppFontFamily(f)
            setFontReady(true)

            const l = localStorage.getItem('layout')
            let nextL = { top: ['main', 'tabs'], bottom: ['tools'], left: ['apps', 'mailboxes', 'maillist'], right: [] }
            if (l) { try { nextL = JSON.parse(l) } catch (e) {} }
            layoutBaselineRef.current = nextL
            setLayoutDraft(nextL)
            setLayoutReady(true)

            const localToolbar = normalizeToolbarStyle(localStorage.getItem('toolbar_style') || 'icon_text_small')
            toolbarStyleBaselineRef.current = localToolbar
            setToolbarStyleDraft(localToolbar)
            setToolbarStyleReady(true)
            return
        }
        let active = true
        setFontReady(false)
        setToolbarStyleReady(false)
        fetch(apiUrl(`/api/account/${accountId}/settings`), { cache: 'no-store' })
            .then((r) => (r.ok ? r.json() : Promise.reject(r)))
            .then((data) => {
                if (!active) return
                const raw = (data.font ?? '').toString().trim()
                const next = raw || 'Inter'
                fontBaselineRef.current = next
                setFontDraft(next)
                applyAppFontFamily(next)
                setFontReady(true)

                const rawLayout = data.layout
                let nextLayout = { top: ['main', 'tabs'], bottom: ['tools'], left: ['apps', 'mailboxes', 'maillist'], right: [] }
                if (rawLayout) { try { nextLayout = JSON.parse(rawLayout) } catch (e) {} }
                layoutBaselineRef.current = nextLayout
                setLayoutDraft(nextLayout)
                setLayoutReady(true)

                const nextToolbarStyle = normalizeToolbarStyle(data.toolbar_style || data.toolbarStyle || localStorage.getItem('toolbar_style'))
                toolbarStyleBaselineRef.current = nextToolbarStyle
                setToolbarStyleDraft(nextToolbarStyle)
                setToolbarStyleReady(true)
                localStorage.setItem('toolbar_style', nextToolbarStyle)
            })
            .catch(() => {
                if (!active) return
                const f = (localStorage.getItem('font') || 'Inter').trim() || 'Inter'
                fontBaselineRef.current = f
                setFontDraft(f)
                applyAppFontFamily(f)
                setFontReady(true)

                const l = localStorage.getItem('layout')
                let nextL = { top: ['main', 'tabs'], bottom: ['tools'], left: ['apps', 'mailboxes', 'maillist'], right: [] }
                if (l) { try { nextL = JSON.parse(l) } catch (e) {} }
                layoutBaselineRef.current = nextL
                setLayoutDraft(nextL)
                setLayoutReady(true)

                const localToolbar = normalizeToolbarStyle(localStorage.getItem('toolbar_style') || 'icon_text_small')
                toolbarStyleBaselineRef.current = localToolbar
                setToolbarStyleDraft(localToolbar)
                setToolbarStyleReady(true)
            })
        return () => {
            active = false
        }
    }, [accountId])

    const appearance = useMemo(
        () => ({
            themeDraft,
            setThemeDraft,
            themeBaselineRef,
            fontDraft,
            setFontDraft,
            fontBaselineRef,
            fontReady,
            layoutDraft,
            setLayoutDraft,
            layoutBaselineRef,
            layoutReady,
            toolbarStyleDraft,
            setToolbarStyleDraft,
            toolbarStyleBaselineRef,
            toolbarStyleReady,
        }),
        [themeDraft, fontDraft, fontReady, layoutDraft, layoutReady, toolbarStyleDraft, toolbarStyleReady],
    )

    useEffect(() => {
        searchRef.current?.focus()
    }, [])

    useEffect(() => {
        if (dirtyCount === 0) setDockExpanded(false)
    }, [dirtyCount])

    useEffect(() => {
        if (searchQuery.trim()) {
            setSelected('search_results')
        } else {
            setSelected((prev) => (prev === 'search_results' ? 'appearance' : prev))
        }
    }, [searchQuery])

    const handleSelectSearchResults = useCallback(() => {
        setSelected('search_results')
    }, [])

    const handleSelectPanelFromSearch = useCallback((panelId) => {
        const parent = CATEGORIES.find((c) => c.children.some((ch) => ch.id === panelId))
        if (parent) {
            setExpanded((prev) => ({ ...prev, [parent.id]: true }))
        }
        setSelected(panelId)
    }, [])

    useEffect(() => {
        const handler = (e) => {
            if (e.key !== 'Escape') return
            e.preventDefault()
            requestClose()
        }
        document.addEventListener('keydown', handler)
        return () => document.removeEventListener('keydown', handler)
    }, [requestClose])

    const toggleExpand = (id, e) => {
        e.stopPropagation()
        setExpanded((prev) => ({ ...prev, [id]: !prev[id] }))
    }

    const handleSelectParent = (id) => {
        setSelected(id)
        setExpanded((prev) => ({ ...prev, [id]: true }))
    }

    return (
        <div className="sp-backdrop" onClick={requestClose}>
            <div className="sp-settings-wrap">
            <SettingsDraftContext.Provider value={draftContextValue}>
                <div className="sp-modal" onClick={(e) => e.stopPropagation()}>
                    <div className="sp-modal__body">
                {/* ── Sidebar ── */}
                <aside className="sp-sidebar">
                    <div className="sp-sidebar__header">
                        <span className="sp-sidebar__title">Settings</span>
                        <button
                            type="button"
                            className="sp-close-btn"
                            onClick={requestClose}
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
                        {searchQuery.trim() && (
                            <div className="sp-tree__group">
                                <div
                                    className={`sp-tree__parent ${selected === 'search_results' ? 'active' : ''}`}
                                    onClick={handleSelectSearchResults}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSelectSearchResults()}
                                >
                                    <span className="sp-tree__parent-label">Search Results</span>
                                </div>
                            </div>
                        )}
                        {filteredCategories.length === 0 && !searchQuery.trim() && (
                            <div className="sp-tree__empty">No results</div>
                        )}
                        {filteredCategories.map((cat) => (
                            <div key={cat.id} className="sp-tree__group">
                                <div
                                    className={`sp-tree__parent ${selected === cat.id ? 'active' : ''}`}
                                    onClick={() => handleSelectParent(cat.id)}
                                    role="button"
                                    tabIndex={0}
                                    onKeyDown={(e) => e.key === 'Enter' && handleSelectParent(cat.id)}
                                >
                                    <span className="sp-tree__parent-label">
                                        <HighlightMatch text={cat.label} query={searchQuery} />
                                    </span>
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
                                                <HighlightMatch text={child.label} query={searchQuery} />
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
                        {selected === 'search_results' ? (
                            <SearchResultsPage
                                filteredCategories={filteredCategories}
                                searchQuery={searchQuery}
                                onSelectPanel={handleSelectPanelFromSearch}
                                onSelectCategory={handleSelectParent}
                                accountId={accountId}
                                onClose={requestClose}
                                onRefreshAccount={onRefreshAccount}
                                appearance={appearance}
                            />
                        ) : (
                            renderContent(selected, accountId, requestClose, onRefreshAccount, searchQuery, appearance)
                        )}
                    </div>
                </main>
                    </div>
                </div>
            </SettingsDraftContext.Provider>

            {dirtyCount > 0 && (
                <div className="sp-dock" role="region" aria-label="Unsaved settings" onClick={(e) => e.stopPropagation()}>
                    <div className="sp-dock__main">
                        <button
                            type="button"
                            className="sp-dock__toggle"
                            onClick={() => setDockExpanded((v) => !v)}
                            aria-expanded={dockExpanded}
                            aria-label={dockExpanded ? 'Collapse' : 'Expand'}
                        >
                            {dockExpanded ? '▼' : '▶'}
                        </button>
                        <span className="sp-dock__summary">
                            Settings changed ({dirtyCount})
                        </span>
                        <div className="sp-dock__actions">
                            <button
                                type="button"
                                className="sp-dock__btn sp-dock__btn--primary"
                                onClick={handleDockSaveAll}
                                disabled={dockSaving || rowSavingId != null}
                            >
                                {dockSaving ? 'Saving…' : 'Save all'}
                            </button>
                            <button
                                type="button"
                                className="sp-dock__btn"
                                onClick={handleDockRevertAll}
                                disabled={dockSaving || rowSavingId != null}
                            >
                                Discard all
                            </button>
                        </div>
                    </div>
                    {dockExpanded && (
                        <ul className="sp-dock__list">
                            {dirtyDraftEntries.map((row) => (
                                <li key={row.id} className="sp-dock__row">
                                    <span className="sp-dock__row-label">{row.label}</span>
                                    <div className="sp-dock__row-actions">
                                        <button
                                            type="button"
                                            className="sp-dock__btn sp-dock__btn--small"
                                            onClick={() => handleRowSave(row.id)}
                                            disabled={dockSaving || rowSavingId != null}
                                        >
                                            {rowSavingId === row.id ? '…' : 'Save'}
                                        </button>
                                        <button
                                            type="button"
                                            className="sp-dock__btn sp-dock__btn--small sp-dock__btn--ghost"
                                            onClick={() => handleRowRevert(row.id)}
                                            disabled={dockSaving || rowSavingId != null}
                                        >
                                            Cancel
                                        </button>
                                    </div>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
            </div>

            {quitOpen && (
                <div
                    className="sp-quit-layer"
                    role="dialog"
                    aria-modal="true"
                    aria-labelledby="sp-quit-title"
                    onClick={() => setQuitOpen(false)}
                >
                    <div className="sp-quit-card" onClick={(e) => e.stopPropagation()}>
                        <p id="sp-quit-title" className="sp-quit-card__title">
                            Unsaved changes
                        </p>
                        <p className="sp-quit-card__desc">
                            Your changes will be lost if you leave without saving.
                        </p>
                        <div className="sp-quit-card__actions">
                            <button
                                type="button"
                                className="sp-dock__btn sp-dock__btn--primary sp-quit-card__btn-wide"
                                onClick={handleQuitSaveAll}
                                disabled={dockSaving}
                            >
                                {dockSaving ? 'Saving…' : 'Save all'}
                            </button>
                            <button
                                type="button"
                                className="sp-dock__btn"
                                onClick={handleQuitDiscard}
                                disabled={dockSaving}
                            >
                                Discard all
                            </button>
                            <button
                                type="button"
                                className="sp-dock__btn sp-dock__btn--ghost"
                                onClick={() => setQuitOpen(false)}
                                disabled={dockSaving}
                            >
                                Stay
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    )
}

export default SettingsPage
