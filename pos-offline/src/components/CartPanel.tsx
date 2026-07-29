import { useState } from 'react'
import type { CartLine, Catalog, Category, Customer, ImagesMap, PaymentMethod } from '../types'
import type { CartAction } from '../cart'
import { cartCount, cartTotal, lineTotal } from '../cart'
import { formatPrice } from '../services/catalog'

interface Props {
    lines: CartLine[]
    catalog: Catalog
    images: ImagesMap
    customer: Customer | null // null = client passager
    showHt: boolean
    dispatch: (action: CartAction) => void
    onPickCustomer: () => void
    onClearCustomer: () => void
    onPay: (method: PaymentMethod) => void // ouvre la modal d'encaissement
    onEditQty: (line: CartLine) => void // bouton "Qté" du tiroir d'actions
    onEditDiscount: (line: CartLine) => void // bouton "Remise" du tiroir d'actions
}

export default function CartPanel({
    lines, catalog, images, customer, showHt, dispatch,
    onPickCustomer, onClearCustomer, onPay, onEditQty, onEditDiscount,
}: Props) {
    const total = cartTotal(lines)
    const count = cartCount(lines)
    const catById = new Map<number, Category>(catalog.categories.map((c) => [c.id, c]))
    const totalHt = lines.reduce((s, l) => s + lineTotal(l) / (1 + l.product.tva_tx / 100), 0)

    // Ligne sélectionnée (clic sur la ligne) : déroule Qté/Remise en dessous.
    const [selectedId, setSelectedId] = useState<number | null>(null)

    function toggleSelect(productId: number): void {
        setSelectedId((cur) => (cur === productId ? null : productId))
    }

    return (
        <aside className="cart">
            {/* Sélecteur de client, comme la caisse online */}
            <div className="client-row">
                <button className="client-icon-btn" title="Choisir un client" onClick={onPickCustomer}>
                    <svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2" /><circle cx="12" cy="7" r="4" />
                    </svg>
                </button>
                <button className="client-select-btn" onClick={onPickCustomer}>
                    <span className="client-select-name">{customer ? customer.name : 'Client Passager'}</span>
                    <span className="client-select-detail">
                        {customer
                            ? [
                                customer.local ? 'créé hors-ligne' : customer.code_client,
                                customer.phone,
                                customer.points !== null && customer.points !== undefined
                                    ? `★ ${new Intl.NumberFormat('fr-FR').format(customer.points)} pts`
                                    : null,
                            ].filter(Boolean).join(' · ') || 'Client identifié'
                            : 'Touchez pour choisir un client'}
                    </span>
                </button>
                {customer && (
                    <button className="client-clear-btn" title="Repasser en client passager" onClick={onClearCustomer}>
                        ×
                    </button>
                )}
            </div>

            <div className="cart-card">
                <div className="cart-head">
                    <h2>
                        Panier{' '}
                        <span className="cart-head-count">
                            ({count === 0 ? 'vide' : count === 1 ? '1 article' : `${count} articles`})
                        </span>
                    </h2>
                    {lines.length > 0 && (
                        <button className="cart-clear" onClick={() => dispatch({ type: 'clear' })}>
                            Vider
                            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                            </svg>
                        </button>
                    )}
                </div>

                <div className="cart-lines">
                    {lines.length === 0 ? (
                        <div className="cart-empty">
                            <svg viewBox="0 0 24 24" width="44" height="44" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                                <circle cx="9" cy="21" r="1" /><circle cx="20" cy="21" r="1" />
                                <path d="M1 1h4l2.68 13.39a2 2 0 0 0 2 1.61h9.72a2 2 0 0 0 2-1.61L23 6H6" />
                            </svg>
                            <p>Panier vide</p>
                            <span>Scannez ou touchez un produit</span>
                        </div>
                    ) : (
                        lines.map((l) => {
                            const cat = l.product.category_ids.length > 0 ? catById.get(l.product.category_ids[0]) : undefined
                            const tint = cat?.color ?? '#94a3b8'
                            const imgUrl = images.products[String(l.product.id)]
                            const selected = selectedId === l.product.id
                            return (
                                <div key={l.product.id} className="cart-line-group">
                                    <div
                                        className={selected ? 'cart-line cart-line-selected' : 'cart-line'}
                                        onClick={() => toggleSelect(l.product.id)}
                                    >
                                        <span className="cart-line-thumb" style={{ color: tint, background: `${tint}14` }}>
                                            {imgUrl ? (
                                                <img src={imgUrl} alt="" draggable={false} />
                                            ) : (
                                                <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                                                    <path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
                                                </svg>
                                            )}
                                        </span>
                                        <div className="cart-line-info">
                                            <span className="cart-line-label">
                                                {l.product.label}
                                                {!!l.discount_percent && (
                                                    <span className="cart-line-discount-badge">-{l.discount_percent}%</span>
                                                )}
                                            </span>
                                            <span className="cart-line-qty">×{l.qty}</span>
                                        </div>
                                        <div className="cart-line-right">
                                            <span className="cart-line-price-group">
                                                {!!l.discount_percent && (
                                                    <span className="cart-line-price-original">
                                                        {formatPrice(l.product.price_ttc * l.qty, catalog.currency)}
                                                    </span>
                                                )}
                                                <span className="cart-line-total">
                                                    {formatPrice(lineTotal(l), catalog.currency)}
                                                </span>
                                            </span>
                                        </div>
                                    </div>

                                    {/* Reste ouvert tant que l'utilisateur ne referme pas explicitement la
                                        ligne — ouvrir Qté/Remise ne doit pas faire disparaître la sélection. */}
                                    {selected && (
                                        <div className="cart-line-actions">
                                            <button
                                                className="cart-line-action-btn"
                                                onClick={(e) => { e.stopPropagation(); onEditQty(l) }}
                                            >
                                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <rect x="3" y="7" width="18" height="13" rx="2" /><path d="M16 3v4" /><path d="M8 3v4" /><path d="M3 11h18" />
                                                </svg>
                                                Qté
                                            </button>
                                            <button
                                                className="cart-line-action-btn"
                                                onClick={(e) => { e.stopPropagation(); onEditDiscount(l) }}
                                            >
                                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" />
                                                </svg>
                                                Remise
                                            </button>
                                            <button
                                                className="cart-line-action-btn cart-line-action-danger"
                                                onClick={(e) => { e.stopPropagation(); setSelectedId(null); dispatch({ type: 'remove', productId: l.product.id }) }}
                                            >
                                                <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                                    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                                </svg>
                                                Retirer
                                            </button>
                                        </div>
                                    )}
                                </div>
                            )
                        })
                    )}
                </div>
            </div>

            <div className="cart-footer">
                {showHt && (
                    <div className="cart-total-row cart-total-row-ht">
                        <span>Total HT</span>
                        <span>{formatPrice(totalHt, catalog.currency)}</span>
                    </div>
                )}
                <div className="cart-total-row">
                    <span>Total TTC</span>
                    <strong>{formatPrice(total, catalog.currency)}</strong>
                </div>
                <div className="pay-methods">
                    <button className="pay-method pay-cash" disabled={lines.length === 0} onClick={() => onPay('cash')}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="6" width="20" height="12" rx="2" /><circle cx="12" cy="12" r="2" />
                        </svg>
                        Espèce
                    </button>
                    <button className="pay-method pay-card" disabled={lines.length === 0} onClick={() => onPay('card')}>
                        <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="1" y="4" width="22" height="16" rx="2" /><line x1="1" y1="10" x2="23" y2="10" />
                        </svg>
                        Carte
                    </button>
                </div>
                <button className="pay-btn" disabled={lines.length === 0} onClick={() => onPay('cash')}>
                    Encaisser
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <line x1="5" y1="12" x2="19" y2="12" /><polyline points="12 5 19 12 12 19" />
                    </svg>
                </button>
                <span className="cart-hint">Vente enregistrée en local, transmise au retour du réseau</span>
            </div>
        </aside>
    )
}
