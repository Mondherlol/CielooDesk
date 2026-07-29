import { useEffect, useMemo, useRef, useState } from 'react'
import type { Customer } from '../types'
import { searchCustomers } from '../services/catalog'

interface Props {
    customers: Customer[]
    fideliteEnabled: boolean
    onSelect: (customer: Customer | null) => void // null = client passager
    onCreate: (name: string, phone: string, email: string) => Promise<void>
    onClose: () => void
}

const MAX_RESULTS = 100

// Couleurs d'avatar comme la page « Tous les clients » online (stables par id).
const AVATAR_COLORS = ['#6366f1', '#14b8a6', '#ef4444', '#ec4899', '#8b5cf6', '#0ea5e9', '#f59e0b', '#10b981']

function avatarColor(c: Customer): string {
    return AVATAR_COLORS[Math.abs(c.id) % AVATAR_COLORS.length]
}

function initials(name: string): string {
    return name.trim().slice(0, 2).toUpperCase()
}

const nf = new Intl.NumberFormat('fr-FR')

export default function CustomerPicker({ customers, fideliteEnabled, onSelect, onCreate, onClose }: Props) {
    const [query, setQuery] = useState('')
    const [mode, setMode] = useState<'list' | 'create'>('list')
    const [newName, setNewName] = useState('')
    const [newPhone, setNewPhone] = useState('')
    const [newEmail, setNewEmail] = useState('')
    const [creating, setCreating] = useState(false)
    const [createError, setCreateError] = useState<string | null>(null)
    const inputRef = useRef<HTMLInputElement>(null)
    const nameRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    useEffect(() => {
        if (mode === 'list') inputRef.current?.focus()
        else nameRef.current?.focus()
    }, [mode])

    const results = useMemo(
        () => searchCustomers(customers, query).slice(0, MAX_RESULTS),
        [customers, query]
    )

    async function submitCreate(): Promise<void> {
        if (creating) return
        if (newName.trim() === '') {
            setCreateError('Le nom est obligatoire.')
            return
        }
        setCreating(true)
        setCreateError(null)
        try {
            await onCreate(newName, newPhone, newEmail)
        } catch (err) {
            setCreateError((err as Error).message)
            setCreating(false)
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal customers-modal" onClick={(e) => e.stopPropagation()}>
                {/* En-tête façon « Tous les clients » de la caisse online */}
                <div className="customers-head">
                    <span className="customers-head-icon">
                        <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2" /><circle cx="9" cy="7" r="4" />
                            <path d="M23 21v-2a4 4 0 0 0-3-3.87" /><path d="M16 3.13a4 4 0 0 1 0 7.75" />
                        </svg>
                    </span>
                    <h3>{mode === 'list' ? 'Tous les clients' : 'Nouveau client'}</h3>

                    {mode === 'list' && (
                        <>
                            <div className="customer-search">
                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <circle cx="11" cy="11" r="8" /><line x1="21" y1="21" x2="16.65" y2="16.65" />
                                </svg>
                                <input
                                    ref={inputRef}
                                    type="text"
                                    placeholder="Rechercher ou scanner un code-barres…"
                                    value={query}
                                    onChange={(e) => setQuery(e.target.value)}
                                />
                            </div>
                            <button className="new-customer-btn" onClick={() => setMode('create')}>
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                                Nouveau
                            </button>
                        </>
                    )}
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                {mode === 'create' ? (
                    <div className="customer-form">
                        <label className="form-field">
                            <span>Nom *</span>
                            <input
                                ref={nameRef}
                                type="text"
                                placeholder="Nom du client"
                                value={newName}
                                onChange={(e) => setNewName(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate() }}
                            />
                        </label>
                        <label className="form-field">
                            <span>Téléphone</span>
                            <input
                                type="tel"
                                placeholder="06 12 34 56 78"
                                value={newPhone}
                                onChange={(e) => setNewPhone(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate() }}
                            />
                        </label>
                        <label className="form-field">
                            <span>Email</span>
                            <input
                                type="email"
                                placeholder="client@exemple.com"
                                value={newEmail}
                                onChange={(e) => setNewEmail(e.target.value)}
                                onKeyDown={(e) => { if (e.key === 'Enter') void submitCreate() }}
                            />
                        </label>

                        {createError && <div className="form-error">{createError}</div>}

                        <p className="form-hint">
                            Le client sera créé dans Dolibarr à la prochaine synchronisation.
                        </p>

                        <div className="form-actions">
                            <button className="form-back-btn" onClick={() => { setMode('list'); setCreateError(null) }}>
                                Retour
                            </button>
                            <button className="form-create-btn" disabled={creating} onClick={() => void submitCreate()}>
                                {creating ? 'Création…' : 'Créer et sélectionner'}
                            </button>
                        </div>
                    </div>
                ) : (
                    <div className="customers-table-wrap">
                        <table className="customers-table">
                            <thead>
                                <tr>
                                    <th className="col-client">Client</th>
                                    <th>Téléphone</th>
                                    <th>Email</th>
                                    {fideliteEnabled && <th className="col-num">Points</th>}
                                    {fideliteEnabled && <th className="col-num">Visites</th>}
                                    {fideliteEnabled && <th>Palier</th>}
                                </tr>
                            </thead>
                            <tbody>
                                <tr className="customer-tr customer-tr-walkin" onClick={() => onSelect(null)}>
                                    <td className="col-client">
                                        <span className="customer-cell">
                                            <span className="customer-avatar customer-avatar-walkin">
                                                <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                                                </svg>
                                            </span>
                                            <span className="customer-cell-name">Client Passager</span>
                                        </span>
                                    </td>
                                    <td colSpan={fideliteEnabled ? 5 : 2} className="walkin-note">
                                        Vente sans client identifié
                                    </td>
                                </tr>

                                {results.map((c) => (
                                    <tr className="customer-tr" key={c.id} onClick={() => onSelect(c)}>
                                        <td className="col-client">
                                            <span className="customer-cell">
                                                <span
                                                    className={c.local ? 'customer-avatar customer-avatar-local' : 'customer-avatar'}
                                                    style={c.local ? undefined : { background: avatarColor(c), color: '#fff' }}
                                                >
                                                    {initials(c.name)}
                                                </span>
                                                <span className="customer-cell-name">
                                                    {c.name}
                                                    {c.local && <span className="customer-local-badge">créé hors-ligne</span>}
                                                </span>
                                            </span>
                                        </td>
                                        <td className="cell-muted">
                                            {c.phone ? (
                                                <span className="phone-cell">
                                                    <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none">
                                                        <path d="M6.62 10.79a15.05 15.05 0 0 0 6.59 6.59l2.2-2.2a1 1 0 0 1 1.02-.24 11.36 11.36 0 0 0 3.57.57 1 1 0 0 1 1 1V20a1 1 0 0 1-1 1A17 17 0 0 1 3 4a1 1 0 0 1 1-1h3.5a1 1 0 0 1 1 1 11.36 11.36 0 0 0 .57 3.57 1 1 0 0 1-.25 1.02Z" />
                                                    </svg>
                                                    {c.phone}
                                                </span>
                                            ) : '—'}
                                        </td>
                                        <td className="cell-muted">{c.email ?? '—'}</td>
                                        {fideliteEnabled && (
                                            <td className="col-num">
                                                {c.points !== null && c.points !== undefined ? (
                                                    <span className="points-pill">
                                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none">
                                                            <path d="M12 2l2.9 6.26L21.5 9.27l-4.75 4.05L18.18 20 12 16.4 5.82 20l1.43-6.68L2.5 9.27l6.6-1.01L12 2z" />
                                                        </svg>
                                                        {nf.format(c.points)}
                                                    </span>
                                                ) : '—'}
                                            </td>
                                        )}
                                        {fideliteEnabled && (
                                            <td className="col-num">
                                                {c.visits !== null && c.visits !== undefined ? (
                                                    <span className="visits-pill">
                                                        {c.visits} visite{c.visits > 1 ? 's' : ''}
                                                    </span>
                                                ) : '—'}
                                            </td>
                                        )}
                                        {fideliteEnabled && (
                                            <td>
                                                {c.tier ? (
                                                    <span className="tier-badge" style={{ background: c.tier.color }}>
                                                        <svg viewBox="0 0 24 24" width="12" height="12" fill="currentColor" stroke="none">
                                                            <path d="M2 8l4.5 3L12 4l5.5 7L22 8l-2 11H4L2 8z" />
                                                        </svg>
                                                        {c.tier.label}
                                                    </span>
                                                ) : '—'}
                                            </td>
                                        )}
                                    </tr>
                                ))}

                                {results.length === 0 && (
                                    <tr>
                                        <td colSpan={fideliteEnabled ? 6 : 3}>
                                            <div className="customer-empty">
                                                Aucun client trouvé
                                                <button className="customer-empty-create" onClick={() => { setMode('create'); setNewName(query.trim()) }}>
                                                    Créer « {query.trim() || 'nouveau client'} »
                                                </button>
                                            </div>
                                        </td>
                                    </tr>
                                )}
                            </tbody>
                        </table>
                    </div>
                )}
            </div>
        </div>
    )
}
