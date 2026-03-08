/**
 * avatar.js – Avatar resolution hook and utilities.
 *
 * useAvatar(email, name, accountId)
 *   Returns { src, initials, color } immediately (initials/color are always
 *   populated for instant rendering). `src` starts as null and is updated
 *   asynchronously once the backend resolves a real image.
 */

import { useState, useEffect } from 'react'
import { apiUrl } from './api'

// ── Session-level cache (email → blob URL string | null) ───────────────────
// null = confirmed no avatar (negative cache from server or repeated miss)
// string = blob URL to the resolved image
const _cache = new Map()

// Tracks in-progress fetches so we don't fire multiple requests for the same email
const _inflight = new Map()

// ── Deterministic initials ──────────────────────────────────────────────────
export function getAvatarInitials(name, email) {
    if (name) {
        const words = name.trim().split(/\s+/)
        if (words.length >= 2) {
            return (words[0][0] + words[words.length - 1][0]).toUpperCase()
        }
        return name.substring(0, 2).toUpperCase()
    }
    if (email) return email.substring(0, 2).toUpperCase()
    return '??'
}

// ── Domain-based deterministic color (consistent brand color per domain) ────
const AVATAR_PALETTE = [
    '#E53935', // red
    '#8E24AA', // purple
    '#1E88E5', // blue
    '#00897B', // teal
    '#43A047', // green
    '#F4511E', // deep orange
    '#6D4C41', // brown
    '#00ACC1', // cyan
    '#7CB342', // light green
    '#FFB300', // amber
    '#5E35B1', // deep purple
    '#039BE5', // light blue
    '#3949AB', // indigo
    '#C0CA33', // lime
    '#EF6C00', // orange
]

export function getAvatarColor(nameOrDomain) {
    let seed = nameOrDomain || 'unknown'
    // Use the domain part if it looks like an email
    if (seed.includes('@')) {
        seed = seed.split('@')[1] || seed
    }
    let hash = 0
    for (let i = 0; i < seed.length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash)
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

// ── Core fetcher with 3-retry back-off on 202 ───────────────────────────────
async function fetchAvatar(email, accountId, delays = [1000, 2000, 4000]) {
    const url = apiUrl(`/api/avatar/${accountId}?email=${encodeURIComponent(email)}`)

    for (let attempt = 0; attempt <= delays.length; attempt++) {
        let resp
        try {
            resp = await fetch(url, { cache: 'no-store' })
        } catch {
            return null
        }

        if (resp.status === 204) {
            // Definitive negative – server found nothing.
            return null
        }

        if (resp.status === 200) {
            try {
                const blob = await resp.blob()
                if (blob.size > 0) {
                    return URL.createObjectURL(blob)
                }
            } catch {
                // ignore
            }
            return null
        }

        if (resp.status === 202) {
            // Resolution in progress – wait and retry
            if (attempt < delays.length) {
                await new Promise((r) => setTimeout(r, delays[attempt]))
                continue
            }
        }

        // Any other status or exhausted retries
        return null
    }
    return null
}

// ── React hook ──────────────────────────────────────────────────────────────
export function useAvatar(email, name, accountId) {
    const initials = getAvatarInitials(name, email)
    const domain = email?.includes('@') ? email.split('@')[1] : email
    const color = getAvatarColor(domain || name)
    const cacheKey = `${accountId}:${(email || '').toLowerCase()}`

    const [src, setSrc] = useState(() => {
        const cached = _cache.get(cacheKey)
        return typeof cached === 'string' ? cached : null
    })

    useEffect(() => {
        if (!email || !accountId) return

        // Already resolved in session cache
        if (_cache.has(cacheKey)) {
            const cached = _cache.get(cacheKey)
            setSrc(typeof cached === 'string' ? cached : null)
            return
        }

        // Another component is already fetching for this key – subscribe
        if (_inflight.has(cacheKey)) {
            _inflight.get(cacheKey).then((url) => {
                setSrc(url)
            })
            return
        }

        // Start new fetch
        const promise = fetchAvatar(email, accountId).then((url) => {
            _cache.set(cacheKey, url) // null or blob URL
            _inflight.delete(cacheKey)
            return url
        })
        _inflight.set(cacheKey, promise)

        let cancelled = false
        promise.then((url) => {
            if (!cancelled) setSrc(url)
        })

        return () => {
            cancelled = true
        }
    }, [email, accountId, cacheKey])

    return { src, initials, color }
}
