import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
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
  const [transfer, setTransfer] = useState(null)
  const lastFlushAtRef = useRef(0)
  const pollInFlightRef = useRef(false)
  const lastSyncAttemptAtRef = useRef(0)

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
      setTransfer(data.transfer || null)
      return data
    } catch (err) {
      setBackendReachable(false)
      setImapReachable(false)
      setSmtpReachable(false)
      setSyncState('offline')
      setLastError(err?.message || 'Unable to reach backend')
      setTransfer(null)
      return null
    }
  }, [])

  const runSyncNow = useCallback(async (accountId) => {
    if (!accountId) return false
    try {
      const res = await fetch(apiUrl(`/api/offline/${accountId}/sync-now`), { method: 'POST' })
      return res.ok
    } catch {
      return false
    }
  }, [])

  const flushQueue = useCallback(async (accountId) => {
    if (!accountId) return
    try {
      const ok = await runSyncNow(accountId)
      if (ok) {
        lastFlushAtRef.current = Date.now()
      }
      await refreshStatus(accountId)
    } catch {
      
    }
  }, [refreshStatus, runSyncNow])

  useEffect(() => {
    const accountId = localStorage.getItem('current_account_id')
    if (!accountId) return
    const STATUS_POLL_INTERVAL_MS = 10_000
    const SYNC_COOLDOWN_MS = 60_000
    const STALE_FLUSH_MS = 5 * 60_000

    const pollOnce = async () => {
      if (pollInFlightRef.current) return
      pollInFlightRef.current = true
      try {
        const data = await refreshStatus(accountId)
        const depth = Number(data?.queue_depth || 0)
        const lastFlushAt = lastFlushAtRef.current
        const isStale = lastFlushAt > 0 && Date.now() - lastFlushAt > STALE_FLUSH_MS
        const cooldownOk = Date.now() - lastSyncAttemptAtRef.current >= SYNC_COOLDOWN_MS
        const shouldFlush = networkOnline && cooldownOk && (depth > 0 || isStale)
        if (shouldFlush) {
          lastSyncAttemptAtRef.current = Date.now()
          const ok = await runSyncNow(accountId)
          if (ok) lastFlushAtRef.current = Date.now()
          await refreshStatus(accountId)
        }
      } finally {
        pollInFlightRef.current = false
      }
    }

    pollOnce()
    const timer = setInterval(pollOnce, STATUS_POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [networkOnline, refreshStatus, runSyncNow])

  const remoteMailAvailable = backendReachable && imapReachable

  const value = useMemo(
    () => ({
      networkOnline,
      backendReachable,
      imapReachable,
      smtpReachable,
      remoteMailAvailable,
      syncState,
      queueDepth,
      lastSyncAt,
      lastError,
      transfer,
      refreshStatus,
      flushQueue,
    }),
    [
      networkOnline,
      backendReachable,
      imapReachable,
      smtpReachable,
      remoteMailAvailable,
      syncState,
      queueDepth,
      lastSyncAt,
      lastError,
      transfer,
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
