import { useEffect } from 'react'
import Numpad from './Numpad'
import { useNumpadValue } from '../services/useNumpadValue'

interface Props {
    label: string
    initialQty: number
    onConfirm: (qty: number) => void
    onCancel: () => void
}

/**
 * Pavé quantité — reproduit le popup de invoice.php/index.php déclenché depuis
 * le tiroir d'actions d'une ligne du panier : PAS de validation par Entrée, il
 * faut cliquer "OK" ; un clic à l'extérieur annule silencieusement ; une
 * quantité à 0 (ou vide) retire la ligne. Taper un chiffre remplace la valeur
 * pré-remplie au lieu de s'y ajouter (cf. useNumpadValue).
 */
export default function QtyPopup({ label, initialQty, onConfirm, onCancel }: Props) {
    const abs = Math.abs(initialQty)
    const negative = initialQty < 0
    const { value, onKey, setDirect } = useNumpadValue(abs > 0 ? String(abs) : '')

    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    const parsed = Number(value.replace(',', '.')) || 0

    function step(delta: number): void {
        setDirect(String(Math.max(0, parsed + delta)))
    }

    function confirm(): void {
        onConfirm(negative ? -parsed : parsed)
    }

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal qty-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Quantité</h3>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>
                <p className="qty-popup-label">{label}</p>
                <div className="qty-popup-row">
                    <button className="qty-popup-step" onClick={() => step(-1)}>−</button>
                    <div className="qty-popup-display">
                        {negative && <span className="qty-popup-sign">−</span>}
                        {value === '' ? '0' : value}
                    </div>
                    <button className="qty-popup-step" onClick={() => step(1)}>+</button>
                </div>
                <Numpad onKey={onKey} />
                <div className="qty-popup-actions">
                    <button className="qty-popup-cancel" onClick={onCancel}>Annuler</button>
                    <button className="qty-popup-confirm" onClick={confirm}>
                        {parsed <= 0 ? 'Retirer la ligne' : 'OK'}
                    </button>
                </div>
            </div>
        </div>
    )
}
