import React, { useState, useRef, useEffect } from 'react'
import { apiUrl } from '../utils/api'
import './LockScreen.css'

/**
 * LockScreen
 * Props:
 *   accountId    – number
 *   accountEmail – string
 *   displayName  – string | null
 *   onUnlocked   – () => void
 *   onCancel     – () => void (optional)
 */
function LockScreen({ accountId, accountEmail, displayName, onUnlocked, onCancel }) {
    const [password, setPassword] = useState('')
    const [error, setError] = useState('')
    const [loading, setLoading] = useState(false)
    const [shake, setShake] = useState(false)
    const inputRef = useRef(null)

    useEffect(() => {
        inputRef.current?.focus()
    }, [])

    const handleSubmit = async (e) => {
        e.preventDefault()
        if (!password) return
        setLoading(true)
        setError('')

        try {
            const res = await fetch(apiUrl('/api/security/verify-password'), {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ account_id: accountId, password }),
            })
            const data = await res.json()

            if (data.ok) {
                onUnlocked()
            } else {
                setPassword('')
                setError('Incorrect password. Please try again.')
                setShake(true)
                setTimeout(() => setShake(false), 500)
                inputRef.current?.focus()
            }
        } catch {
            setError('Unable to verify password. Check backend connection.')
        } finally {
            setLoading(false)
        }
    }

    const initials = (displayName || accountEmail || '?')
        .split(' ')
        .map((w) => w[0])
        .join('')
        .slice(0, 2)
        .toUpperCase()

    return (
        <div className="ls-root">
            {/* Background blur blobs */}
            <div className="ls-blob ls-blob--1" aria-hidden="true" />
            <div className="ls-blob ls-blob--2" aria-hidden="true" />
            <div className="ls-blob ls-blob--3" aria-hidden="true" />

            <div className={`ls-card ${shake ? 'shake' : ''}`}>
                {/* Lock icon */}
                <div className="ls-lock-icon" aria-hidden="true">
                    <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                        <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                    </svg>
                </div>

                {/* Avatar */}
                <div className="ls-avatar" aria-hidden="true">{initials}</div>

                {/* Name */}
                <h1 className="ls-name">{displayName || accountEmail}</h1>
                {displayName && (
                    <p className="ls-email">{accountEmail}</p>
                )}

                <p className="ls-hint">Enter your account password to continue</p>

                <form className="ls-form" onSubmit={handleSubmit} autoComplete="off">
                    <div className="ls-input-wrap">
                        <input
                            ref={inputRef}
                            id="ls-password"
                            type="password"
                            className={`ls-input ${error ? 'ls-input--error' : ''}`}
                            placeholder="Password"
                            value={password}
                            onChange={(e) => { setPassword(e.target.value); setError('') }}
                            autoComplete="current-password"
                            disabled={loading}
                        />
                    </div>

                    {error && (
                        <p className="ls-error" role="alert">{error}</p>
                    )}

                    <button
                        type="submit"
                        className="ls-btn"
                        disabled={loading || !password}
                    >
                        {loading ? (
                            <span className="ls-spinner" />
                        ) : (
                            <>
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2" />
                                    <path d="M7 11V7a5 5 0 0 1 10 0v4" />
                                </svg>
                                Unlock
                            </>
                        )}
                    </button>

                    {onCancel && (
                        <button
                            type="button"
                            className="ls-cancel-btn"
                            onClick={onCancel}
                            disabled={loading}
                        >
                            Switch Account
                        </button>
                    )}
                </form>
            </div>
        </div>
    )
}

export default LockScreen
