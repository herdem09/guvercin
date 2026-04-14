import React, { useState, useEffect, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { useTranslation } from 'react-i18next'
import { apiUrl } from '../utils/api'
import './AccountSettingsPage.css'

function AccountSettingsPage() {
    const { t } = useTranslation()
    const navigate = useNavigate()

    const [accounts, setAccounts] = useState([])
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    // Modal state
    const [deleteCandidate, setDeleteCandidate] = useState(null)
    const [deletePassword, setDeletePassword] = useState('')
    const [deleteError, setDeleteError] = useState(null)
    const [isDeleting, setIsDeleting] = useState(false)

    const fetchAccounts = useCallback(async () => {
        try {
            setLoading(true)
            const response = await fetch(apiUrl('/api/auth/accounts'))
            if (!response.ok) throw new Error('Failed to fetch accounts')
            const data = await response.json()
            setAccounts(data.accounts || [])
        } catch (err) {
            setError(err.message)
        } finally {
            setLoading(false)
        }
    }, [])

    useEffect(() => {
        fetchAccounts()
    }, [fetchAccounts])

    const handleDeleteClick = (account) => {
        setDeleteCandidate(account)
        setDeletePassword('')
        setDeleteError(null)
    }

    const cancelDelete = () => {
        setDeleteCandidate(null)
        setDeletePassword('')
        setDeleteError(null)
    }

    const confirmDelete = async (e) => {
        e.preventDefault()
        if (!deleteCandidate) return

        setIsDeleting(true)
        setDeleteError(null)

        try {
            const res = await fetch(apiUrl(`/api/account/${deleteCandidate.account_id}`), {
                method: 'DELETE',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ password: deletePassword }),
            })

            const json = await res.json()
            if (!res.ok) {
                throw new Error(json.message || json.error || 'Failed to delete account')
            }

            // Success
            await fetchAccounts()
            setDeleteCandidate(null)
        } catch (err) {
            let msg = err.message
            if (msg.includes('Incorrect password')) {
                msg = t('Incorrect password')
            }
            setDeleteError(msg)
        } finally {
            setIsDeleting(false)
        }
    }

    return (
        <div className="account-settings-page">
            <div className="asp-container">
                <header className="asp-header">
                    <button type="button" className="asp-back-btn" onClick={() => navigate(-1)}>
                        <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <line x1="19" y1="12" x2="5" y2="12"></line>
                            <polyline points="12 19 5 12 12 5"></polyline>
                        </svg>
                        {t('Back')}
                    </button>
                    <h2>{t('Manage Accounts')}</h2>
                </header>

                <div className="asp-content">
                    {loading ? (
                        <div className="asp-loading">
                            <div className="asp-spinner"></div>
                            <p>{t('Loading accounts...')}</p>
                        </div>
                    ) : error ? (
                        <div className="asp-error-state">
                            <p>{error}</p>
                            <button onClick={fetchAccounts}>{t('Try again')}</button>
                        </div>
                    ) : accounts.length === 0 ? (
                        <div className="asp-empty-state">
                            <p>{t('No accounts found.')}</p>
                        </div>
                    ) : (
                        <ul className="asp-account-list">
                            {accounts.map(acc => (
                                <li key={acc.account_id} className="asp-account-item">
                                    <div className="asp-account-info">
                                        <div className="asp-account-name">{acc.display_name}</div>
                                        <div className="asp-account-email">{acc.email_address}</div>
                                    </div>
                                    <button 
                                        type="button" 
                                        className="asp-delete-btn" 
                                        title={t('Delete Account')}
                                        onClick={() => handleDeleteClick(acc)}
                                    >
                                        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="3 6 5 6 21 6"></polyline>
                                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                                        </svg>
                                    </button>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            </div>

            {deleteCandidate && (
                <div className="asp-modal-overlay">
                    <div className="asp-modal">
                        <h3 className="asp-modal-title">{t('Delete Account')}</h3>
                        <p className="asp-modal-warning">
                            {t('Are you sure you want to delete')} <strong>{deleteCandidate.email_address}</strong>?
                            <br/><br/>
                            {t('This will permanently erase all local data for this account from your PC. This action cannot be undone.')}
                        </p>
                        
                        <form onSubmit={confirmDelete} className="asp-modal-form">
                            <div className="asp-input-group">
                                <label htmlFor="delete-pwd">{t('Enter password to confirm:')}</label>
                                <input 
                                    id="delete-pwd"
                                    type="password" 
                                    placeholder={t('Account Password')}
                                    value={deletePassword}
                                    onChange={e => setDeletePassword(e.target.value)}
                                    autoFocus
                                    required
                                />
                            </div>

                            {deleteError && (
                                <div className="asp-modal-error">
                                    {deleteError}
                                </div>
                            )}

                            <div className="asp-modal-actions">
                                <button type="button" className="asp-btn-cancel" onClick={cancelDelete} disabled={isDeleting}>
                                    {t('Cancel')}
                                </button>
                                <button type="submit" className="asp-btn-danger" disabled={isDeleting}>
                                    {isDeleting ? t('Deleting...') : t('Delete Account')}
                                </button>
                            </div>
                        </form>
                    </div>
                </div>
            )}
        </div>
    )
}

export default AccountSettingsPage
