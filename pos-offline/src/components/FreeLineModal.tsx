import { useEffect, useRef, useState } from 'react'
import type { Product } from '../types'

interface Props {
    vatRates: number[] // taux TVA disponibles dans le catalogue (secours : [0, 5.5, 10, 20])
    onConfirm: (product: Product, qty: number) => void
    onCancel: () => void
}

/**
 * Article libre — équivalent de FreeZone() / freezone.php côté online : une
 * ligne hors-catalogue (désignation + prix + TVA libres). Sert aussi de
 * mécanisme de "remise en montant fixe" (prix négatif), comme la remise
 * "Montant" de reduction.php.
 */
export default function FreeLineModal({ vatRates, onConfirm, onCancel }: Props) {
    const [label, setLabel] = useState('')
    const [price, setPrice] = useState('')
    const [qty, setQty] = useState('1')
    const [tva, setTva] = useState(vatRates[0] ?? 0)
    const [error, setError] = useState<string | null>(null)
    const labelRef = useRef<HTMLInputElement>(null)

    useEffect(() => {
        labelRef.current?.focus()
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onCancel() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onCancel])

    function submit(): void {
        const priceNum = Number(price.replace(',', '.'))
        const qtyNum = Number(qty.replace(',', '.')) || 1
        if (label.trim() === '') { setError('La désignation est obligatoire.'); return }
        if (!Number.isFinite(priceNum) || priceNum === 0) { setError('Indiquez un prix (négatif pour une remise en montant).'); return }
        onConfirm({
            id: -Date.now(),
            ref: 'LIBRE',
            label: label.trim(),
            barcode: null,
            price_ttc: priceNum,
            tva_tx: tva,
            price_min: null,
            category_ids: [],
        }, qtyNum > 0 ? qtyNum : 1)
    }

    return (
        <div className="modal-overlay" onClick={onCancel}>
            <div className="modal customer-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Article libre</h3>
                    <button className="modal-close" onClick={onCancel}>×</button>
                </div>

                <div className="customer-form">
                    <label className="form-field">
                        <span>Désignation *</span>
                        <input
                            ref={labelRef}
                            type="text"
                            placeholder="Ex : Frais de port, Remise fidélité…"
                            value={label}
                            onChange={(e) => setLabel(e.target.value)}
                        />
                    </label>
                    <label className="form-field">
                        <span>Prix TTC * (négatif = remise en montant)</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            placeholder="0.00"
                            value={price}
                            onChange={(e) => setPrice(e.target.value.replace(/[^0-9.,-]/g, ''))}
                            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                        />
                    </label>
                    <label className="form-field">
                        <span>Quantité</span>
                        <input
                            type="text"
                            inputMode="decimal"
                            value={qty}
                            onChange={(e) => setQty(e.target.value.replace(/[^0-9.,]/g, ''))}
                            onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
                        />
                    </label>
                    <label className="form-field">
                        <span>TVA</span>
                        <select value={tva} onChange={(e) => setTva(Number(e.target.value))}>
                            {(vatRates.length > 0 ? vatRates : [0, 5.5, 10, 20]).map((r) => (
                                <option key={r} value={r}>{r}%</option>
                            ))}
                        </select>
                    </label>

                    {error && <div className="form-error">{error}</div>}

                    <div className="form-actions">
                        <button className="form-back-btn" onClick={onCancel}>Annuler</button>
                        <button className="form-create-btn" onClick={submit}>Ajouter au panier</button>
                    </div>
                </div>
            </div>
        </div>
    )
}
