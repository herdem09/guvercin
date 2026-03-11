
import React, { useState } from 'react'
import { useAvatar } from '../utils/avatar'

const Avatar = React.memo(function Avatar({ email, name, accountId, size = 36, className = '' }) {
    const { src, initials, color } = useAvatar(email, name, accountId)
    const [imgError, setImgError] = useState(false)

    const baseStyle = {
        width: size,
        height: size,
        minWidth: size,
        minHeight: size,
        borderRadius: '50%',
        overflow: 'hidden',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: Math.max(10, Math.round(size * 0.38)),
        fontWeight: '700',
        userSelect: 'none',
        flexShrink: 0,
        position: 'relative',
    }

    const showImage = src && !imgError

    return (
        <div
            className={`gv-avatar ${className}`}
            style={{
                ...baseStyle,
                backgroundColor: showImage ? 'transparent' : color,
                color: '#fff',
            }}
            title={name || email || ''}
        >
            {}
            <span
                style={{
                    position: 'absolute',
                    inset: 0,
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    opacity: showImage ? 0 : 1,
                    transition: 'opacity 0.3s ease',
                    pointerEvents: 'none',
                }}
            >
                {initials}
            </span>

            {}
            {src && (
                <img
                    src={src}
                    alt={name || email || 'avatar'}
                    onError={() => setImgError(true)}
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        borderRadius: '50%',
                        opacity: imgError ? 0 : 1,
                        transition: 'opacity 0.3s ease',
                        position: 'absolute',
                        inset: 0,
                    }}
                />
            )}
        </div>
    )
})

export default Avatar
