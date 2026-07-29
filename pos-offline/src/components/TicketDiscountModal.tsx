import { useEffect } from 'react'
import { formatPrice } from '../services/catalog'
import Numpad from './Numpad'
import { useNumpadValue } from '../services/useNumpadValue'

interface Props {
    total: number
    currency: string
    onConfirm: (percent: number) => void
    onCancel: () => void
}

/**
 * Remise globale du ticket — équivalent (simplifié) de OpenTicketDiscountPopup
 * (index.php) : un pourcentage, qui s'applique en écrasant la remise de CHAQUE
 * ligne (cart.ts:global_discount), comme update_reduction_global côté online.
 */
export default function TicketDiscountModal({ total, currency, onConfirm, onCancel }: Props) {
    const { value, onKey } = useNumpadValue('')

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const pct = Math.max(0, Math.min(100, Number(value.replace(',', '.')) || 0))
    const newTotal = total * (1 - pct / 100)

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal qty-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Remise sur le ticket</h3>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>

                <p className="qty-popup-label">Total actuel : {formatPrice(total, currency)}</p>
                <div className="qty-popup-display">
                    {value === '' ? '0' : value}<span className="discount-percent-sign">%</span>
                </div>
                <div className="discount-preview">
                    <span className="discount-preview-price">
                        Nouveau total : {formatPrice(newTotal, currency)}
                    </span>
                </div>
                <Numpad onKey={onKey} />
                <div className="qty-popup-actions">
                    <button className="qty-popup-cancel" onClick={onCancel}>Annuler</button>
                    <button className="qty-popup-confirm" disabled={pct <= 0} onClick={() => onConfirm(pct)}>
                        Appliquer
                    </button>
                </div>
            </div>
        </div>
    )
}
