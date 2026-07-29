import { useEffect, useMemo, useRef, useState } from 'react'
import type { PaymentMethod } from '../types'
import { formatPrice } from '../services/catalog'

interface Props {
    total: number
    currency: string
    initialMethod: PaymentMethod
    onConfirm: (method: PaymentMethod, received: number | null) => void
    onClose: () => void
}

// Billets proposés en raccourci : le premier ≥ total est souvent celui tendu.
const QUICK_NOTES = [5, 10, 20, 50, 100]

export default function PaymentModal({ total, currency, initialMethod, onConfirm, onClose }: Props) {
    const [method, setMethod] = useState<PaymentMethod>(initialMethod)
    const [receivedStr, setReceivedStr] = useState<string>('')
    const inputRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    useEffect(() => {
        if (method === 'cash') inputRef.current?.focus()
    }, [method])

    const received = useMemo(() => {
        const n = Number(receivedStr.replace(',', '.'))
        return Number.isFinite(n) && receivedStr.trim() !== '' ? n : null
    }, [receivedStr])

    // Montant exact par défaut : valider sans rien saisir = compte juste.
    const effectiveReceived = received ?? total
    const change = effectiveReceived - total
    const canConfirm = method === 'card' || change >= 0

    const quickAmounts = useMemo(
        () => QUICK_NOTES.filter((n) => n >= total).slice(0, 3),
        [total]
    )

    function confirm(): void {
        if (!canConfirm) return
        onConfirm(method, method === 'cash' ? effectiveReceived : null)
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal payment-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Encaissement</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                <div className="payment-total">
                    <span>Total à payer</span>
                    <strong>{formatPrice(total, currency)}</strong>
                </div>

                <div className="payment-methods-row">
                    <button
                        className={method === 'cash' ? 'method-btn method-cash method-active' : 'method-btn method-cash'}
                        onClick={() => setMethod('cash')}
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" />
                        </svg>
                        Espèce
                    </button>
                    <button
                        className={method === 'card' ? 'method-btn method-card method-active' : 'method-btn method-card'}
                        onClick={() => setMethod('card')}
                    >
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
                        </svg>
                        Carte
                    </button>
                </div>

                {method === 'cash' ? (
                    <div className="cash-section">
                        <label className="cash-label">Montant reçu</label>
                        <div className="cash-input-row">
                            <input
                                ref={inputRef}
                                type="text"
                                inputMode="decimal"
                                placeholder={formatPrice(total, currency)}
                                value={receivedStr}
                                onChange={(e) => setReceivedStr(e.target.value.replace(/[^0-9.,]/g, ''))}
                                onKeyDown={(e) => { if (e.key === 'Enter') confirm() }}
                            />
                        </div>
                        <div className="cash-quick">
                            <button className="quick-btn quick-exact" onClick={() => setReceivedStr('')}>
                                Compte juste
                            </button>
                            {quickAmounts.map((n) => (
                                <button key={n} className="quick-btn" onClick={() => setReceivedStr(String(n))}>
                                    {formatPrice(n, currency)}
                                </button>
                            ))}
                        </div>
                        <div className={change < 0 ? 'cash-change cash-change-neg' : 'cash-change'}>
                            <span>{change < 0 ? 'Montant insuffisant' : 'Monnaie à rendre'}</span>
                            <strong>{formatPrice(Math.max(0, change), currency)}</strong>
                        </div>
                    </div>
                ) : (
                    <div className="card-section">
                        <p>Encaissez {formatPrice(total, currency)} sur le TPE, puis validez.</p>
                    </div>
                )}

                <button className="payment-confirm" disabled={!canConfirm} onClick={confirm}>
                    Valider la vente
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <polyline points="20 6 9 17 4 12" />
                    </svg>
                </button>
            </div>
        </div>
    )
}
