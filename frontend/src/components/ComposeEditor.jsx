import { useEffect, useRef, useState, useCallback, useMemo } from 'react'
import { EditorState, TextSelection } from 'prosemirror-state'
import { EditorView } from 'prosemirror-view'
import { Schema, DOMParser as PmDOMParser, DOMSerializer } from 'prosemirror-model'
import { schema as basicSchema } from 'prosemirror-schema-basic'
import { addListNodes } from 'prosemirror-schema-list'
import { keymap } from 'prosemirror-keymap'
import { baseKeymap, toggleMark, wrapIn } from 'prosemirror-commands'
import { history, undo, redo } from 'prosemirror-history'
import { inputRules, wrappingInputRule, smartQuotes, emDash, ellipsis } from 'prosemirror-inputrules'
import { gapCursor } from 'prosemirror-gapcursor'
import { wrapInList, splitListItem, liftListItem, sinkListItem } from 'prosemirror-schema-list'
import './ComposeEditor.css'

/* ─── Emoji palette ─── */
const EMOJIS = [
    '😀','😃','😄','😁','😆','😅','😂','🤣','😊','😇',
    '🙂','🙃','😉','😌','😍','🥰','😘','😗','😙','😚',
    '😋','😛','😜','🤪','😝','🤑','🤗','🤭','🤫','🤔',
    '🤐','🤨','😐','😑','😶','😏','😒','🙄','😬','🤥',
    '😌','😔','😪','🤤','😴','😷','🤒','🤕','🤢','🤮',
    '🥳','🤠','😎','🤓','🧐','😕','😟','🙁','😮','😯',
    '😲','😳','🥺','😦','😧','😨','😰','😥','😢','😭',
    '👍','👎','👏','🙏','🤝','💪','❤️','🔥','⭐','✨',
    '🎉','🎊','💯','✅','❌','⚡','💡','📎','📌','🔗',
]

/* ─── Build schema ─── */
function buildSchema() {
    const marks = {
        link: {
            attrs: { href: { default: '' }, title: { default: null } },
            inclusive: false,
            parseDOM: [{ tag: 'a[href]', getAttrs: (dom) => ({ href: dom.getAttribute('href'), title: dom.getAttribute('title') }) }],
            toDOM(node) { return ['a', { href: node.attrs.href, title: node.attrs.title, rel: 'noopener noreferrer' }, 0] },
        },
        em: basicSchema.spec.marks.get('em'),
        strong: basicSchema.spec.marks.get('strong'),
        underline: {
            parseDOM: [{ tag: 'u' }, { style: 'text-decoration=underline' }],
            toDOM() { return ['u', 0] },
        },
        strikethrough: {
            parseDOM: [{ tag: 's' }, { tag: 'del' }, { style: 'text-decoration=line-through' }],
            toDOM() { return ['s', 0] },
        },
        textColor: {
            attrs: { color: { default: '#000000' } },
            parseDOM: [{ style: 'color', getAttrs: (value) => value ? { color: value } : false }],
            toDOM(mark) { return ['span', { style: `color: ${mark.attrs.color}` }, 0] },
        },
        highlight: {
            attrs: { color: { default: '#ffff00' } },
            parseDOM: [{ style: 'background-color', getAttrs: (value) => value ? { color: value } : false }],
            toDOM(mark) { return ['span', { style: `background-color: ${mark.attrs.color}` }, 0] },
        },
        subscript: {
            excludes: 'superscript',
            parseDOM: [{ tag: 'sub' }],
            toDOM() { return ['sub', 0] },
        },
        superscript: {
            excludes: 'subscript',
            parseDOM: [{ tag: 'sup' }],
            toDOM() { return ['sup', 0] },
        },
        fontSize: {
            attrs: { size: { default: '14px' } },
            parseDOM: [{ style: 'font-size', getAttrs: (value) => value ? { size: value } : false }],
            toDOM(mark) { return ['span', { style: `font-size: ${mark.attrs.size}` }, 0] },
        },
        fontFamily: {
            attrs: { family: { default: 'sans-serif' } },
            parseDOM: [{ style: 'font-family', getAttrs: (value) => value ? { family: value } : false }],
            toDOM(mark) { return ['span', { style: `font-family: ${mark.attrs.family}` }, 0] },
        },
    }

    const baseNodes = basicSchema.spec.nodes
        .update('paragraph', {
            ...basicSchema.spec.nodes.get('paragraph'),
            attrs: {
                align: { default: null },
                lineHeight: { default: null },
            },
            parseDOM: [{
                tag: 'p',
                getAttrs: (dom) => ({
                    align: dom.style.textAlign || null,
                    lineHeight: dom.style.lineHeight || null,
                }),
            }],
            toDOM(node) {
                const styleParts = []
                if (node.attrs.align) styleParts.push(`text-align: ${node.attrs.align}`)
                if (node.attrs.lineHeight) styleParts.push(`line-height: ${node.attrs.lineHeight}`)
                const style = styleParts.length ? styleParts.join('; ') : undefined
                return ['p', { style }, 0]
            },
        })
        .update('image', {
            inline: true,
            attrs: {
                src: { default: null },
                alt: { default: null },
                title: { default: null },
                width: { default: null },
                height: { default: null },
            },
            group: 'inline',
            draggable: true,
            parseDOM: [{
                tag: 'img[src]',
                getAttrs: (dom) => ({
                    src: dom.getAttribute('src'),
                    alt: dom.getAttribute('alt'),
                    title: dom.getAttribute('title'),
                    width: dom.getAttribute('width'),
                    height: dom.getAttribute('height'),
                }),
            }],
            toDOM(node) {
                const { src, alt, title, width, height } = node.attrs
                return ['img', { src, alt, title, width, height, style: 'max-width:100%' }]
            },
        })

    const withList = addListNodes(baseNodes, 'paragraph block*', 'block')

    return new Schema({ nodes: withList, marks })
}

/* ─── Helpers ─── */
function markActive(state, markType) {
    const { from, $from, to, empty } = state.selection
    if (empty) return !!markType.isInSet(state.storedMarks || $from.marks())
    return state.doc.rangeHasMark(from, to, markType)
}

function getMarkAttr(state, markType, attrName) {
    const { from, $from, to, empty } = state.selection
    if (empty) {
        const stored = state.storedMarks || $from.marks()
        const mark = markType.isInSet(stored)
        return mark ? mark.attrs[attrName] : null
    }
    let value = null
    state.doc.nodesBetween(from, to, (node) => {
        const mark = markType.isInSet(node.marks)
        if (mark) value = mark.attrs[attrName]
    })
    return value
}

function currentParagraph(state) {
    const { $from } = state.selection
    for (let depth = $from.depth; depth >= 0; depth -= 1) {
        const node = $from.node(depth)
        if (node?.type?.name === 'paragraph') {
            return node
        }
    }
    return null
}

function getParagraphAttr(state, attrName) {
    const paragraph = currentParagraph(state)
    return paragraph?.attrs?.[attrName] ?? null
}

function setAlignment(state, dispatch, align) {
    const { from, to } = state.selection
    const tr = state.tr
    state.doc.nodesBetween(from, to, (node, pos) => {
        if (node.type.name === 'paragraph') {
            tr.setNodeMarkup(pos, undefined, { ...node.attrs, align: align || null })
        }
    })
    if (dispatch) dispatch(tr)
    return true
}

function setLineSpacing(state, dispatch, lineHeight) {
    const { from, to, empty, $from } = state.selection
    const tr = state.tr

    if (empty) {
        for (let depth = $from.depth; depth >= 0; depth -= 1) {
            const node = $from.node(depth)
            if (node?.type?.name === 'paragraph') {
                tr.setNodeMarkup($from.before(depth), undefined, { ...node.attrs, lineHeight })
                break
            }
        }
    } else {
        state.doc.nodesBetween(from, to, (node, pos) => {
            if (node.type.name === 'paragraph') {
                tr.setNodeMarkup(pos, undefined, { ...node.attrs, lineHeight })
            }
        })
    }

    if (!tr.docChanged) return false
    if (dispatch) dispatch(tr)
    return true
}

function insertImageFromFile(view) {
    const input = document.createElement('input')
    input.type = 'file'
    input.accept = 'image/*'
    input.onchange = () => {
        const file = input.files?.[0]
        if (!file) return
        const reader = new FileReader()
        reader.onload = () => {
            const src = reader.result
            const node = view.state.schema.nodes.image.create({ src, alt: file.name })
            const tr = view.state.tr.replaceSelectionWith(node)
            view.dispatch(tr)
            view.focus()
        }
        reader.readAsDataURL(file)
    }
    input.click()
}

function clearFormatting(state, dispatch) {
    const { from, to } = state.selection
    if (from === to) return false
    const tr = state.tr
    for (const [, markType] of Object.entries(state.schema.marks)) {
        tr.removeMark(from, to, markType)
    }
    if (dispatch) dispatch(tr)
    return true
}

function changeCaseCommand(state, dispatch) {
    const { from, to } = state.selection
    if (from === to) return false
    const text = state.doc.textBetween(from, to)
    let transformed
    if (text === text.toLowerCase()) {
        transformed = text.toUpperCase()
    } else if (text === text.toUpperCase()) {
        transformed = text.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    } else {
        transformed = text.toLowerCase()
    }
    if (dispatch) {
        dispatch(state.tr.insertText(transformed, from, to))
    }
    return true
}

/* ─── Input rules ─── */
function buildInputRules(schema) {
    const rules = smartQuotes.concat(ellipsis, emDash)
    if (schema.nodes.blockquote) {
        rules.push(wrappingInputRule(/^\s*>\s$/, schema.nodes.blockquote))
    }
    if (schema.nodes.ordered_list) {
        rules.push(wrappingInputRule(
            /^(\d+)\.\s$/,
            schema.nodes.ordered_list,
            (match) => ({ order: Number(match[1]) }),
            (match, node) => node.childCount + node.attrs.order === Number(match[1]),
        ))
    }
    if (schema.nodes.bullet_list) {
        rules.push(wrappingInputRule(/^\s*([-+*])\s$/, schema.nodes.bullet_list))
    }
    return inputRules({ rules })
}

/* ─── Serializer ─── */
function serializeToHtml(schema, doc) {
    const serializer = DOMSerializer.fromSchema(schema)
    const fragment = serializer.serializeFragment(doc.content)
    const div = document.createElement('div')
    div.appendChild(fragment)
    return div.innerHTML
}

function parseFromHtml(schema, html) {
    const div = document.createElement('div')
    div.innerHTML = html || '<p></p>'
    return PmDOMParser.fromSchema(schema).parse(div)
}

/* ─── Component ─── */
export default function ComposeEditor({ initialContent, onChange, lineSpacing = '1.6' }) {
    const editorRef = useRef(null)
    const viewRef = useRef(null)
    const [editorState, setEditorState] = useState(null)
    const onChangeRef = useRef(onChange)
    const lastSelectionRef = useRef(null)
    const lastHtmlRef = useRef(initialContent || '')
    const initialContentRef = useRef(initialContent)
    const lineSpacingValueRef = useRef(lineSpacing)

    useEffect(() => {
        onChangeRef.current = onChange
    }, [onChange])

    useEffect(() => {
        initialContentRef.current = initialContent
    }, [initialContent])

    useEffect(() => {
        lineSpacingValueRef.current = lineSpacing
    }, [lineSpacing])

    /* Popups */
    const [showEmoji, setShowEmoji] = useState(false)
    const [showLink, setShowLink] = useState(false)
    const [linkUrl, setLinkUrl] = useState('')
    const [linkTitle, setLinkTitle] = useState('')
    const [showLineSpacing, setShowLineSpacing] = useState(false)

    const emojiRef = useRef(null)
    const linkRef = useRef(null)
    const lineSpacingRef = useRef(null)

    const schema = useMemo(() => buildSchema(), [])

    /* Create editor view */
    useEffect(() => {
        if (!editorRef.current) return

        const initialHtml = initialContentRef.current || ''
        const initialLineSpacing = lineSpacingValueRef.current
        const doc = initialHtml
            ? parseFromHtml(schema, initialHtml)
            : schema.node('doc', null, [schema.node('paragraph', { align: null, lineHeight: initialLineSpacing })])

        const state = EditorState.create({
            doc,
            plugins: [
                buildInputRules(schema),
                keymap({
                    'Mod-z': undo,
                    'Mod-y': redo,
                    'Mod-Shift-z': redo,
                    'Mod-b': toggleMark(schema.marks.strong),
                    'Mod-i': toggleMark(schema.marks.em),
                    'Mod-u': toggleMark(schema.marks.underline),
                    'Mod-Shift-s': toggleMark(schema.marks.strikethrough),
                    Enter: splitListItem(schema.nodes.list_item),
                    'Tab': sinkListItem(schema.nodes.list_item),
                    'Shift-Tab': liftListItem(schema.nodes.list_item),
                }),
                keymap(baseKeymap),
                history(),
                gapCursor(),
            ],
        })

        const view = new EditorView(editorRef.current, {
            state,
            dispatchTransaction(tr) {
                const newState = view.state.apply(tr)
                view.updateState(newState)
                setEditorState(newState)
                lastSelectionRef.current = {
                    from: newState.selection.from,
                    to: newState.selection.to,
                }
                if (tr.docChanged && onChangeRef.current) {
                    const html = serializeToHtml(schema, newState.doc)
                    lastHtmlRef.current = html
                    onChangeRef.current(html)
                }
            },
        })

        viewRef.current = view
        setEditorState(state)
        lastHtmlRef.current = initialHtml
        lastSelectionRef.current = {
            from: state.selection.from,
            to: state.selection.to,
        }

        return () => {
            view.destroy()
            viewRef.current = null
        }
    }, [schema])

    useEffect(() => {
        const view = viewRef.current
        if (!view) return

        const nextHtml = initialContent || ''
        if (nextHtml === lastHtmlRef.current) return

        const nextDoc = nextHtml
            ? parseFromHtml(schema, nextHtml)
            : schema.node('doc', null, [schema.node('paragraph', { align: null, lineHeight: lineSpacing })])

        const nextState = EditorState.create({
            doc: nextDoc,
            plugins: view.state.plugins,
        })

        view.updateState(nextState)
        setEditorState(nextState)
        lastSelectionRef.current = {
            from: nextState.selection.from,
            to: nextState.selection.to,
        }
        lastHtmlRef.current = nextHtml
    }, [initialContent, lineSpacing, schema])

    /* Close popups on outside click */
    useEffect(() => {
        const handleClick = (e) => {
            if (showEmoji && emojiRef.current && !emojiRef.current.contains(e.target)) {
                setShowEmoji(false)
            }
            if (showLink && linkRef.current && !linkRef.current.contains(e.target)) {
                setShowLink(false)
            }
            if (showLineSpacing && lineSpacingRef.current && !lineSpacingRef.current.contains(e.target)) {
                setShowLineSpacing(false)
            }
        }
        document.addEventListener('mousedown', handleClick)
        return () => document.removeEventListener('mousedown', handleClick)
    }, [showEmoji, showLink, showLineSpacing])

    /* ── Toolbar command helpers ── */
    const exec = useCallback((cmd) => {
        if (!viewRef.current) return
        cmd(viewRef.current.state, viewRef.current.dispatch, viewRef.current)
        viewRef.current.focus()
    }, [])

    const toggleMarkCmd = useCallback((markType) => {
        exec(toggleMark(markType))
    }, [exec])

    const isMarkActive = useCallback((markType) => {
        if (!editorState) return false
        return markActive(editorState, markType)
    }, [editorState])

    const applyMark = useCallback((markType, attrs) => {
        if (!viewRef.current) return
        const view = viewRef.current
        let workingState = view.state
        const savedSelection = lastSelectionRef.current

        if (!view.hasFocus() && savedSelection) {
            const maxPos = workingState.doc.content.size
            const from = Math.max(0, Math.min(savedSelection.from, maxPos))
            const to = Math.max(0, Math.min(savedSelection.to, maxPos))
            const tr = workingState.tr.setSelection(TextSelection.create(workingState.doc, from, to))
            view.dispatch(tr)
            workingState = view.state
        }

        const { from, to, empty } = workingState.selection
        const mark = markType.create(attrs)
        if (empty) {
            const stored = workingState.storedMarks || workingState.selection.$from.marks()
            const otherMarks = stored.filter((m) => m.type !== markType)
            view.dispatch(workingState.tr.setStoredMarks([...otherMarks, mark]))
        } else {
            view.dispatch(workingState.tr.removeMark(from, to, markType).addMark(from, to, mark))
        }
        view.focus()
    }, [])

    const handleFontFamily = useCallback((e) => {
        applyMark(schema.marks.fontFamily, { family: e.target.value })
    }, [schema, applyMark])

    const handleFontSize = useCallback((e) => {
        applyMark(schema.marks.fontSize, { size: e.target.value })
    }, [schema, applyMark])

    const handleTextColor = useCallback((e) => {
        applyMark(schema.marks.textColor, { color: e.target.value })
    }, [schema, applyMark])

    const handleHighlight = useCallback((e) => {
        applyMark(schema.marks.highlight, { color: e.target.value })
    }, [schema, applyMark])

    const handleAlignment = useCallback((align) => {
        exec((state, dispatch) => setAlignment(state, dispatch, align))
    }, [exec])

    const handleEmoji = useCallback((emoji) => {
        if (!viewRef.current) return
        const view = viewRef.current
        const tr = view.state.tr.insertText(emoji)
        view.dispatch(tr)
        view.focus()
        setShowEmoji(false)
    }, [])

    const handleInsertLink = useCallback(() => {
        if (!viewRef.current || !linkUrl.trim()) return
        const view = viewRef.current
        const { from, to, empty } = view.state.selection
        const mark = schema.marks.link.create({ href: linkUrl, title: linkTitle || null })
        if (empty) {
            const text = linkTitle || linkUrl
            const node = schema.text(text, [mark])
            view.dispatch(view.state.tr.replaceSelectionWith(node, false))
        } else {
            view.dispatch(view.state.tr.addMark(from, to, mark))
        }
        view.focus()
        setShowLink(false)
        setLinkUrl('')
        setLinkTitle('')
    }, [schema, linkUrl, linkTitle])

    const handleLineSpacing = useCallback((value) => {
        exec((state, dispatch) => setLineSpacing(state, dispatch, value))
        setShowLineSpacing(false)
    }, [exec])

    const handleInsertImage = useCallback(() => {
        if (viewRef.current) insertImageFromFile(viewRef.current)
    }, [])

    /* Public method for parent components */
    const getHtml = useCallback(() => {
        if (!viewRef.current) return ''
        return serializeToHtml(schema, viewRef.current.state.doc)
    }, [schema])

    // Expose getHtml via ref-like pattern
    useEffect(() => {
        if (editorRef.current) {
            editorRef.current.__getHtml = getHtml
        }
    }, [getHtml])

    const currentFontFamily = editorState ? (getMarkAttr(editorState, schema.marks.fontFamily, 'family') || 'sans-serif') : 'sans-serif'
    const currentFontSize = editorState ? (getMarkAttr(editorState, schema.marks.fontSize, 'size') || '14px') : '14px'
    const currentTextColor = editorState ? (getMarkAttr(editorState, schema.marks.textColor, 'color') || '#000000') : '#000000'
    const currentHighlight = editorState ? (getMarkAttr(editorState, schema.marks.highlight, 'color') || '#ffff00') : '#ffff00'
    const currentLineSpacing = editorState ? (getParagraphAttr(editorState, 'lineHeight') || lineSpacing) : lineSpacing

    return (
        <div className="compose-editor">
            <div className="ce-toolbar">
                {/* Undo / Redo */}
                <div className="ce-toolbar-group">
                    <button type="button" onClick={() => exec(undo)} title="Geri Al">↩</button>
                    <button type="button" onClick={() => exec(redo)} title="Yinele">↪</button>
                </div>

                {/* Font family */}
                <div className="ce-toolbar-group">
                    <select value={currentFontFamily} onChange={handleFontFamily} title="Yazı Tipi">
                        <option value="sans-serif">Sans Serif</option>
                        <option value="Arial, sans-serif">Arial</option>
                        <option value="'Aptos', sans-serif">Aptos</option>
                        <option value="'Georgia', serif">Georgia</option>
                        <option value="'Times New Roman', serif">Times New Roman</option>
                        <option value="'Courier New', monospace">Courier New</option>
                        <option value="'Verdana', sans-serif">Verdana</option>
                        <option value="'Trebuchet MS', sans-serif">Trebuchet MS</option>
                    </select>
                </div>

                {/* Font size */}
                <div className="ce-toolbar-group">
                    <select value={currentFontSize} onChange={handleFontSize} title="Yazı Boyutu">
                        <option value="10px">10</option>
                        <option value="11px">11</option>
                        <option value="12px">12</option>
                        <option value="13px">13</option>
                        <option value="14px">14</option>
                        <option value="16px">16</option>
                        <option value="18px">18</option>
                        <option value="20px">20</option>
                        <option value="24px">24</option>
                        <option value="28px">28</option>
                        <option value="32px">32</option>
                        <option value="36px">36</option>
                    </select>
                </div>

                {/* Bold, Italic, Underline, Strikethrough */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        className={isMarkActive(schema.marks.strong) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.strong)}
                        title="Kalın"
                    ><b>B</b></button>
                    <button type="button"
                        className={isMarkActive(schema.marks.em) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.em)}
                        title="İtalik"
                    ><i>I</i></button>
                    <button type="button"
                        className={isMarkActive(schema.marks.underline) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.underline)}
                        title="Altı Çizili"
                    ><u>U</u></button>
                    <button type="button"
                        className={isMarkActive(schema.marks.strikethrough) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.strikethrough)}
                        title="Üstü Çizili"
                    ><s>S</s></button>
                </div>

                {/* Text color & Highlight */}
                <div className="ce-toolbar-group">
                    <div className="ce-color-wrap">
                        <button type="button" onMouseDown={(e) => e.preventDefault()} title="Metin Rengi" style={{ color: currentTextColor }}>A</button>
                        <input type="color" value={currentTextColor} onChange={handleTextColor} title="Metin Rengi" />
                    </div>
                    <div className="ce-color-wrap">
                        <button type="button" onMouseDown={(e) => e.preventDefault()} title="Vurgu Rengi" style={{ backgroundColor: currentHighlight, color: '#333' }}>🖍</button>
                        <input type="color" value={currentHighlight} onChange={handleHighlight} title="Vurgu Rengi" />
                    </div>
                </div>

                {/* Alignment */}
                <div className="ce-toolbar-group">
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handleAlignment('left')} title="Sola Hizala">⫷</button>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handleAlignment('center')} title="Ortala">☰</button>
                    <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => handleAlignment('right')} title="Sağa Hizala">⫸</button>
                </div>

                {/* Lists */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onClick={() => exec(wrapInList(schema.nodes.ordered_list))}
                        onMouseDown={(e) => e.preventDefault()}
                        title="Numaralı Liste"
                    >1.</button>
                    <button type="button"
                        onClick={() => exec(wrapInList(schema.nodes.bullet_list))}
                        onMouseDown={(e) => e.preventDefault()}
                        title="Madde İşaretli Liste"
                    >•</button>
                </div>

                {/* Indent */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onClick={() => exec(liftListItem(schema.nodes.list_item))}
                        onMouseDown={(e) => e.preventDefault()}
                        title="Girintiyi Azalt"
                    >⇤</button>
                    <button type="button"
                        onClick={() => exec(sinkListItem(schema.nodes.list_item))}
                        onMouseDown={(e) => e.preventDefault()}
                        title="Girintiyi Artır"
                    >⇥</button>
                </div>

                {/* Blockquote */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onClick={() => exec(wrapIn(schema.nodes.blockquote))}
                        onMouseDown={(e) => e.preventDefault()}
                        title="Alıntı"
                    >❝</button>
                </div>

                {/* Link */}
                <div className="ce-toolbar-group" style={{ position: 'relative' }} ref={linkRef}>
                    <button type="button"
                        className={isMarkActive(schema.marks.link) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                            if (isMarkActive(schema.marks.link)) {
                                exec(toggleMark(schema.marks.link))
                            } else {
                                setShowLink(!showLink)
                            }
                        }}
                        title="Bağlantı Ekle"
                    >🔗</button>
                    {showLink && (
                        <div className="ce-link-dialog">
                            <input
                                type="url"
                                placeholder="https://example.com"
                                value={linkUrl}
                                onChange={(e) => setLinkUrl(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleInsertLink()}
                                autoFocus
                            />
                            <input
                                type="text"
                                placeholder="Link başlığı (opsiyonel)"
                                value={linkTitle}
                                onChange={(e) => setLinkTitle(e.target.value)}
                                onKeyDown={(e) => e.key === 'Enter' && handleInsertLink()}
                            />
                            <div className="ce-link-dialog-actions">
                                <button type="button" onClick={() => setShowLink(false)}>İptal</button>
                                <button type="button" className="primary" onClick={handleInsertLink}>Ekle</button>
                            </div>
                        </div>
                    )}
                </div>

                {/* Emoji */}
                <div className="ce-toolbar-group" style={{ position: 'relative' }} ref={emojiRef}>
                    <button type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setShowEmoji(!showEmoji)}
                        title="Emoji"
                    >😊</button>
                    {showEmoji && (
                        <div className="ce-emoji-popup">
                            {EMOJIS.map((emoji) => (
                                <button key={emoji} type="button" onClick={() => handleEmoji(emoji)}>
                                    {emoji}
                                </button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Clear formatting */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => exec(clearFormatting)}
                        title="Biçimlendirmeyi Temizle"
                    >🧹</button>
                </div>

                {/* Case change */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => exec(changeCaseCommand)}
                        title="Büyük/Küçük Harf"
                    >aA</button>
                </div>

                {/* Line spacing */}
                <div className="ce-toolbar-group" style={{ position: 'relative' }} ref={lineSpacingRef}>
                    <button type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => setShowLineSpacing(!showLineSpacing)}
                        title="Satır Aralığı"
                    >⇕</button>
                    {showLineSpacing && (
                        <div className="ce-linespacing-popup">
                            {['1.0', '1.15', '1.4', '1.6', '2.0', '2.5', '3.0'].map((s) => (
                                <button
                                    key={s}
                                    type="button"
                                    className={currentLineSpacing === s ? 'active' : ''}
                                    onClick={() => handleLineSpacing(s)}
                                >{s}</button>
                            ))}
                        </div>
                    )}
                </div>

                {/* Sub / Superscript */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        className={isMarkActive(schema.marks.subscript) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.subscript)}
                        title="Alt Simge"
                    >x₂</button>
                    <button type="button"
                        className={isMarkActive(schema.marks.superscript) ? 'active' : ''}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => toggleMarkCmd(schema.marks.superscript)}
                        title="Üst Simge"
                    >x²</button>
                </div>

                {/* Insert image */}
                <div className="ce-toolbar-group">
                    <button type="button"
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={handleInsertImage}
                        title="Görsel Ekle"
                    >🖼️</button>
                </div>
            </div>

            {/* Editor area */}
            <div
                className="ce-editor-area"
                style={{ lineHeight: currentLineSpacing }}
                onClick={() => viewRef.current?.focus()}
            >
                <div ref={editorRef} />
            </div>
        </div>
    )
}

/* Export helper for parent to extract HTML */
export function getEditorHtml(editorElementRef) {
    return editorElementRef?.current?.__getHtml?.() || ''
}
