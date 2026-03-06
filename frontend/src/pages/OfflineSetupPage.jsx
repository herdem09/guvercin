import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import './OfflineSetupPage.css'

function normalizeFolderPath(path) {
  if (path.startsWith('Folders/')) return path.slice('Folders/'.length)
  return path
}

function normalizeLabelPath(path) {
  if (path.startsWith('Labels/')) return path.slice('Labels/'.length)
  if (path.startsWith('Etiketler/')) return path.slice('Etiketler/'.length)
  return path
}

function buildTreeNodes(paths, nodeType) {
  const root = []
  const insert = (parts, fullPath) => {
    let level = root
    for (let i = 0; i < parts.length; i += 1) {
      const part = parts[i]
      const nodePath = parts.slice(0, i + 1).join('/')
      const key = `${nodeType}:${nodePath}`
      let node = level.find((n) => n.key === key)
      if (!node) {
        node = {
          key,
          name: part,
          nodeType,
          valuePath: nodePath,
          children: [],
          real: true,
        }
        level.push(node)
      }
      level = node.children
    }
    // keep leaf path for clarity
    if (level && fullPath) {
      // noop but preserves call-site meaning
    }
  }

  paths
    .filter(Boolean)
    .map((p) => p.trim())
    .filter(Boolean)
    .forEach((path) => {
      const normalized = nodeType === 'folder' ? normalizeFolderPath(path) : normalizeLabelPath(path)
      const parts = normalized.split('/').filter(Boolean)
      if (parts.length) insert(parts, normalized)
    })

  const sortNodes = (nodes) => {
    nodes.sort((a, b) => a.name.localeCompare(b.name, 'tr'))
    nodes.forEach((n) => sortNodes(n.children))
  }
  sortNodes(root)
  return root
}

function OfflineSetupPage() {
  const { t } = useTranslation()
  const navigate = useNavigate()

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [folders, setFolders] = useState([])
  const [labels, setLabels] = useState([])

  const [selectedPrefixes, setSelectedPrefixes] = useState(() => new Set(['all']))
  const [excludedExact, setExcludedExact] = useState(() => new Set())
  const [expanded, setExpanded] = useState(() => new Set(['all', 'group:folders', 'group:labels']))
  const [policyMode, setPolicyMode] = useState('all')
  const [policyValue, setPolicyValue] = useState('')
  const [cacheRawRfc822, setCacheRawRfc822] = useState(true)

  const folderTree = useMemo(() => buildTreeNodes(folders, 'folder'), [folders])
  const labelTree = useMemo(() => buildTreeNodes(labels, 'label'), [labels])

  const fetchMailboxPreview = async () => {
    setLoading(true)
    setError('')
    try {
      const formData = JSON.parse(localStorage.getItem('temp_account_form') || '{}')
      const response = await fetch(apiUrl('/api/auth/mailboxes-preview'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          email: formData.email || '',
          imapServer: formData.imapServer || '',
          imapPort: formData.imapPort || '',
          password: formData.password || '',
          sslMode: formData.sslMode || 'STARTTLS',
        }),
      })
      if (!response.ok) {
        const data = await response.json().catch(() => ({}))
        throw new Error(data.message || 'Mailbox preview failed')
      }
      const data = await response.json()
      const fetchedFolders = Array.isArray(data.folders) ? data.folders : []
      const fetchedLabels = Array.isArray(data.labels) ? data.labels : []
      setFolders(fetchedFolders)
      setLabels(fetchedLabels)
    } catch (err) {
      setError(err?.message || t('Unable to load mailboxes.'))
      setFolders([])
      setLabels([])
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    fetchMailboxPreview()
  }, [])

  const hasInheritedSelection = (node) => {
    if (selectedPrefixes.has('all')) return true
    if (node.nodeType === 'folder' && selectedPrefixes.has('group:folders')) return true
    if (node.nodeType === 'label' && selectedPrefixes.has('group:labels')) return true
    for (const prefix of selectedPrefixes) {
      if (!prefix.includes(':')) continue
      if (!prefix.startsWith(`${node.nodeType}:`)) continue
      const p = prefix.split(':')[1]
      if (node.valuePath === p || node.valuePath.startsWith(`${p}/`)) {
        return true
      }
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
    const inherited = hasInheritedSelection(node)
    const excluded = excludedExact.has(node.key)
    return inherited && !excluded
  }

  const toggleNode = (node) => {
    const selected = isIncluded(node)
    if (selected) {
      if (selectedPrefixes.has(node.key)) {
        const next = new Set(selectedPrefixes)
        next.delete(node.key)
        setSelectedPrefixes(next)
        return
      }
      if (node.real && hasInheritedSelection(node)) {
        const nextEx = new Set(excludedExact)
        nextEx.add(node.key)
        setExcludedExact(nextEx)
      } else if (!node.real) {
        const next = new Set(selectedPrefixes)
        next.delete(node.key)
        setSelectedPrefixes(next)
      }
      return
    }

    if (node.real && hasInheritedSelection(node)) {
      const nextEx = new Set(excludedExact)
      nextEx.delete(node.key)
      setExcludedExact(nextEx)
      return
    }
    const next = new Set(selectedPrefixes)
    next.add(node.key)
    setSelectedPrefixes(next)
  }

  const persistAndContinue = () => {
    const includeRules = []
    const addInclude = (nodePath, nodeType, source = 'user') => {
      includeRules.push({
        node_path: nodePath,
        node_type: nodeType,
        rule_type: 'include_prefix',
        source,
      })
    }

    if (selectedPrefixes.has('all')) {
      addInclude('*', 'folder', 'inherited')
      addInclude('*', 'label', 'inherited')
    } else {
      if (selectedPrefixes.has('group:folders')) addInclude('*', 'folder', 'inherited')
      if (selectedPrefixes.has('group:labels')) addInclude('*', 'label', 'inherited')
    }

    for (const key of selectedPrefixes) {
      if (!key.includes(':')) continue
      if (key === 'group:folders' || key === 'group:labels') continue
      const [nodeType, nodePath] = key.split(':')
      addInclude(nodePath, nodeType, 'user')
    }

    const excludeRules = Array.from(excludedExact).map((key) => {
      const [nodeType, nodePath] = key.split(':')
      return {
        node_path: nodePath,
        node_type: nodeType,
        rule_type: 'exclude_exact',
        source: 'user',
      }
    })

    const dedupe = new Map()
    for (const rule of [...includeRules, ...excludeRules]) {
      dedupe.set(`${rule.node_type}|${rule.rule_type}|${rule.node_path}`, rule)
    }
    const downloadRules = Array.from(dedupe.values())

    const normalizedValue = policyMode === 'all' ? null : Number(policyValue || 0)
    localStorage.setItem(
      'temp_offline_config',
      JSON.stringify({
        enabled: true,
        download_rules: downloadRules,
        initial_sync_policy: {
          mode: policyMode,
          value: normalizedValue && normalizedValue > 0 ? normalizedValue : null,
        },
        cache_raw_rfc822: cacheRawRfc822,
      }),
    )
    navigate('/ai_chooser')
  }

  const toggleExpand = (key) => {
    const next = new Set(expanded)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    setExpanded(next)
  }

  const renderNode = (node, depth = 0) => {
    const hasChildren = Array.isArray(node.children) && node.children.length > 0
    const open = expanded.has(node.key)
    return (
      <div key={node.key} className="off-node">
        <div className="off-node__row" style={{ paddingLeft: `${depth * 14}px` }}>
          {hasChildren ? (
            <button type="button" className={`off-chevron ${open ? 'open' : ''}`} onClick={() => toggleExpand(node.key)}>
              ❯
            </button>
          ) : (
            <span className="off-chevron-placeholder" />
          )}
          <label className="off-node__label">
            <input type="checkbox" checked={isIncluded(node)} onChange={() => toggleNode(node)} />
            <span>{node.name}</span>
          </label>
        </div>
        {hasChildren && open && (
          <div className="off-node__children">{node.children.map((child) => renderNode(child, depth + 1))}</div>
        )}
      </div>
    )
  }

  const tree = [
    {
      key: 'all',
      name: 'all',
      real: false,
      children: [
        { key: 'group:folders', name: 'Folders', real: false, children: folderTree },
        { key: 'group:labels', name: 'Labels', real: false, children: labelTree },
      ],
    },
  ]

  return (
    <div className="offline-setup-page">
      <div className="offline-setup-card">
        <h2 className="sticky-title">{t('Offline Setup')}</h2>
        <p className="off-subtitle">{t('Choose folders and labels for offline usage')}</p>

        {loading ? (
          <div className="off-loading">{t('Loading mailboxes...')}</div>
        ) : error ? (
          <div className="off-error">
            <p>{error}</p>
            <button type="button" onClick={fetchMailboxPreview}>{t('Try again')}</button>
          </div>
        ) : (
          <div className="off-tree">{tree.map((node) => renderNode(node))}</div>
        )}

        <div className="off-policy">
          <h3>{t('Initial Download Policy')}</h3>
          <div className="off-policy__modes">
            <label>
              <input type="radio" name="mode" value="all" checked={policyMode === 'all'} onChange={() => setPolicyMode('all')} />
              {t('All Emails')}
            </label>
            <label>
              <input type="radio" name="mode" value="by_days" checked={policyMode === 'by_days'} onChange={() => setPolicyMode('by_days')} />
              {t('By Days')}
            </label>
            <label>
              <input type="radio" name="mode" value="by_count" checked={policyMode === 'by_count'} onChange={() => setPolicyMode('by_count')} />
              {t('By Mail Count')}
            </label>
          </div>
          {policyMode !== 'all' && (
            <input
              type="number"
              min="1"
              value={policyValue}
              placeholder={policyMode === 'by_days' ? '30' : '1000'}
              onChange={(e) => setPolicyValue(e.target.value)}
            />
          )}
          <label style={{ display: 'flex', gap: '10px', alignItems: 'center', marginTop: '12px' }}>
            <input type="checkbox" checked={cacheRawRfc822} onChange={(e) => setCacheRawRfc822(e.target.checked)} />
            <span>{t('Cache attachments for offline use')}</span>
          </label>
        </div>

        <button type="button" className="continue-button" onClick={persistAndContinue} disabled={loading}>
          {t('Continue')}
        </button>
      </div>
    </div>
  )
}

export default OfflineSetupPage
