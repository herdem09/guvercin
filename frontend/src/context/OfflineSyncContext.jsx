import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import { apiUrl } from '../utils/api'

const OfflineSyncContext = createContext(null)

export function OfflineSyncProvider({ children }) {
  const [networkOnline, setNetworkOnline] = useState(() => navigator.onLine)
  const [backendReachable, setBackendReachable] = useState(true)
  const [imapReachable, setImapReachable] = useState(false)
  const [smtpReachable, setSmtpReachable] = useState(false)
  const [syncState, setSyncState] = useState('idle')
  const [queueDepth, setQueueDepth] = useState(0)
  const [lastSyncAt, setLastSyncAt] = useState(null)
  const [lastError, setLastError] = useState(null)

  useEffect(() => {
    const onOnline = () => setNetworkOnline(true)
    const onOffline = () => setNetworkOnline(false)
    window.addEventListener('online', onOnline)
    window.addEventListener('offline', onOffline)
    return () => {
      window.removeEventListener('online', onOnline)
      window.removeEventListener('offline', onOffline)
    }
  }, [])

  const refreshStatus = useCallback(async (accountId) => {
    if (!accountId) return
    try {
      const response = await fetch(apiUrl(`/api/offline/${accountId}/status`), { cache: 'no-store' })
      if (!response.ok) {
        throw new Error('Status endpoint failed')
      }
      const data = await response.json()
      setBackendReachable(!!data.backend_reachable)
      setImapReachable(!!data.imap_reachable)
      setSmtpReachable(!!data.smtp_reachable)
      setSyncState(data.sync_state || 'idle')
      setQueueDepth(Number(data.queue_depth || 0))
      setLastSyncAt(data.last_sync_at || null)
      setLastError(data.last_error || null)
    } catch (err) {
      setBackendReachable(false)
      setSyncState('offline')
      setLastError(err?.message || 'Unable to reach backend')
    }
  }, [])

  const flushQueue = useCallback(async (accountId) => {
    if (!accountId) return
    try {
      await fetch(apiUrl(`/api/offline/${accountId}/sync-now`), { method: 'POST' })
      await refreshStatus(accountId)
    } catch {
      // status refresh will capture eventual failures
    }
  }, [refreshStatus])

  useEffect(() => {
    const accountId = localStorage.getItem('current_account_id')
    if (!accountId) return
    const timer = setInterval(() => {
      refreshStatus(accountId)
      if (networkOnline) {
        flushQueue(accountId)
      }
    }, 6000)
    refreshStatus(accountId)
    return () => clearInterval(timer)
  }, [flushQueue, networkOnline, refreshStatus])

  const value = useMemo(
    () => ({
      networkOnline,
      backendReachable,
      imapReachable,
      smtpReachable,
      syncState,
      queueDepth,
      lastSyncAt,
      lastError,
      refreshStatus,
      flushQueue,
    }),
    [
      networkOnline,
      backendReachable,
      imapReachable,
      smtpReachable,
      syncState,
      queueDepth,
      lastSyncAt,
      lastError,
      refreshStatus,
      flushQueue,
    ],
  )

  return <OfflineSyncContext.Provider value={value}>{children}</OfflineSyncContext.Provider>
}

export function useOfflineSync() {
  const ctx = useContext(OfflineSyncContext)
  if (!ctx) {
    throw new Error('useOfflineSync must be used within OfflineSyncProvider')
  }
  return ctx
}
