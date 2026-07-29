import { useEffect } from 'react'
import type { Product } from '../types'
import { formatPrice } from '../services/catalog'
import Numpad from './Numpad'
import { useNumpadValue } from '../services/useNumpadValue'

interface Props {
    product: Product
    currency: string
    initialPercent: number
    onConfirm: (percent: number) => void
    onCancel: () => void
}

/**
 * Remise ligne (%) — équivalent du popup prix/remise de index.php (updatereduction).
 * Même garde-fou que invoice.php:2342-2352 : le prix résultant ne peut pas
 * descendre sous price_min du produit.
 */
export default function DiscountPopup({ product, currency, initialPercent, onConfirm, onCancel }: Props) {
    const { value, onKey } = useNumpadValue(initialPercent > 0 ? String(initialPercent) : '')

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const pct = Math.max(0, Math.min(100, Number(value.replace(',', '.')) || 0))
    const resultingUnit = product.price_ttc * (1 - pct / 100)
    const belowFloor = !!product.price_min && product.price_min > 0 && resultingUnit < product.price_min

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal qty-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Remise</h3>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>
                <p className="qty-popup-label">{product.label}</p>
                <div className="qty-popup-display">
                    {value === '' ? '0' : value}<span className="discount-percent-sign">%</span>
                </div>
                <div className="discount-preview">
                    <span className={belowFloor ? 'discount-preview-price discount-preview-blocked' : 'discount-preview-price'}>
                        {formatPrice(product.price_ttc, currency)} → {formatPrice(resultingUnit, currency)}
                    </span>
                    {belowFloor && (
                        <span className="discount-preview-warning">
                            Prix minimum : {formatPrice(product.price_min ?? 0, currency)}
                        </span>
                    )}
                </div>
                <Numpad onKey={onKey} />
                <div className="qty-popup-actions">
                    <button className="qty-popup-cancel" onClick={onCancel}>Annuler</button>
                    <button className="qty-popup-confirm" disabled={belowFloor} onClick={() => onConfirm(pct)}>
                        OK
                    </button>
                </div>
            </div>
        </div>
    )
}
