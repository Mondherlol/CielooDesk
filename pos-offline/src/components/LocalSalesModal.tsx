import { useEffect, useState } from 'react'
import type { OfflineSale } from '../types'
import { listSales, syncSale } from '../services/outbox'
import { formatPrice } from '../services/catalog'

interface Props {
    currency: string
    onClose: () => void
    onShowReceipt: (sale: OfflineSale) => void // clic sur une vente → revoir son ticket
}

export default function LocalSalesModal({ currency, onClose, onShowReceipt }: Props) {
    const [sales, setSales] = useState<OfflineSale[] | null>(null)
    const [syncingUuid, setSyncingUuid] = useState<string | null>(null)
    const [errorUuid, setErrorUuid] = useState<string | null>(null)

    useEffect(() => {
        void listSales().then(setSales)
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    async function upload(sale: OfflineSale): Promise<void> {
        setSyncingUuid(sale.uuid)
        setErrorUuid(null)
        const res = await syncSale(sale.uuid)
        setSyncingUuid(null)
        if (res.ok) {
            setSales((prev) => prev?.map((s) => (s.uuid === sale.uuid ? { ...s, synced: true, real_ref: res.ref } : s)) ?? prev)
        } else {
            setErrorUuid(sale.uuid)
        }
    }

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal sales-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Ventes locales</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>
                <p className="sales-modal-hint">
                    Les ventes non synchronisées sont transmises automatiquement au retour en ligne —
                    ou tout de suite via « Téléverser ».
                </p>

                <div className="sales-list">
                    {sales === null ? (
                        <div className="sales-empty">Chargement…</div>
                    ) : sales.length === 0 ? (
                        <div className="sales-empty">Aucune vente locale pour le moment</div>
                    ) : (
                        sales.map((s) => (
                            <div className="sale-row" key={s.uuid}>
                                <button className="sale-row-main" title="Voir le ticket" onClick={() => onShowReceipt(s)}>
                                    <span className={s.payment.method === 'cash' ? 'sale-method sale-method-cash' : 'sale-method sale-method-card'}>
                                        {s.payment.method === 'cash' ? (
                                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" />
                                            </svg>
                                        ) : (
                                            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
                                            </svg>
                                        )}
                                    </span>
                                    <span className="sale-info">
                                        <span className="sale-ref">
                                            {s.ref}
                                            <span className="sale-customer"> · {s.customer ? s.customer.name : 'Client passager'}</span>
                                        </span>
                                        <span className="sale-detail">
                                            {new Date(s.created_at).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })}
                                            {' · '}
                                            {s.lines.reduce((n, l) => n + l.qty, 0)} article{s.lines.reduce((n, l) => n + l.qty, 0) > 1 ? 's' : ''}
                                        </span>
                                    </span>
                                    <span className="sale-total">{formatPrice(s.total_ttc, currency)}</span>
                                </button>

                                {s.synced ? (
                                    <span className="sale-synced-badge" title={s.real_ref ? `Réf. Dolibarr : ${s.real_ref}` : undefined}>
                                        <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                        {s.real_ref ?? 'Synchronisée'}
                                    </span>
                                ) : (
                                    <button
                                        className={errorUuid === s.uuid ? 'sale-upload-btn sale-upload-btn-error' : 'sale-upload-btn'}
                                        disabled={syncingUuid === s.uuid}
                                        onClick={() => void upload(s)}
                                    >
                                        {syncingUuid === s.uuid ? (
                                            'Envoi…'
                                        ) : (
                                            <>
                                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M12 19V6" /><polyline points="6 11 12 5 18 11" /><path d="M5 21h14" />
                                                </svg>
                                                {errorUuid === s.uuid ? 'Échec — réessayer' : 'Téléverser'}
                                            </>
                                        )}
                                    </button>
                                )}
                            </div>
                        ))
                    )}
                </div>
            </div>
        </div>
    )
}
