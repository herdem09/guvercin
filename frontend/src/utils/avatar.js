
import { useState, useEffect } from 'react'
import { apiUrl } from './api'

const _cache = new Map()

const _inflight = new Map()

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

const AVATAR_PALETTE = [
    '#E53935', 
    '#8E24AA', 
    '#1E88E5', 
    '#00897B', 
    '#43A047', 
    '#F4511E', 
    '#6D4C41', 
    '#00ACC1', 
    '#7CB342', 
    '#FFB300', 
    '#5E35B1', 
    '#039BE5', 
    '#3949AB', 
    '#C0CA33', 
    '#EF6C00', 
]

export function getAvatarColor(nameOrDomain) {
    let seed = nameOrDomain || 'unknown'
    
    if (seed.includes('@')) {
        seed = seed.split('@')[1] || seed
    }
    let hash = 0
    for (let i = 0; i < seed.length; i++) {
        hash = seed.charCodeAt(i) + ((hash << 5) - hash)
    }
    return AVATAR_PALETTE[Math.abs(hash) % AVATAR_PALETTE.length]
}

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
            
            return null
        }

        if (resp.status === 200) {
            try {
                const blob = await resp.blob()
                if (blob.size > 0) {
                    return URL.createObjectURL(blob)
                }
            } catch {
                
            }
            return null
        }

        if (resp.status === 202) {
            
            if (attempt < delays.length) {
                await new Promise((r) => setTimeout(r, delays[attempt]))
                continue
            }
        }

        return null
    }
    return null
}

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

        if (_cache.has(cacheKey)) {
            const cached = _cache.get(cacheKey)
            setSrc(typeof cached === 'string' ? cached : null)
            return
        }

        if (_inflight.has(cacheKey)) {
            _inflight.get(cacheKey).then((url) => {
                setSrc(url)
            })
            return
        }

        const promise = fetchAvatar(email, accountId).then((url) => {
            _cache.set(cacheKey, url) 
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
