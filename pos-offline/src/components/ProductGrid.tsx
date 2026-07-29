import type { Catalog, Category, ImagesMap, Product } from '../types'
import { formatAmount } from '../services/catalog'

interface Props {
    products: Product[]
    catalog: Catalog
    images: ImagesMap
    /** admin/appearance.php : TAKEPOS_SHOW_PRODUCT_REFERENCE (0 libellé / 1 réf+libellé / 2 réf seule) */
    showReference: 0 | 1 | 2
    /** admin/setup.php : TAKEPOS_SHOW_HT */
    showHt: boolean
    /** admin/appearance.php : TAKEPOS_HIDE_PRODUCT_IMAGES */
    hideImages: boolean
    /** admin/terminal.php : CIELOO_PRODUCT_DISPLAY_MODE<n> */
    compact: boolean
    onAdd: (product: Product) => void
}

function productLabel(p: Product, showReference: 0 | 1 | 2): string {
    if (showReference === 2) return p.ref
    if (showReference === 1) return `${p.ref} — ${p.label}`
    return p.label
}

export default function ProductGrid({ products, catalog, images, showReference, showHt, hideImages, compact, onAdd }: Props) {
    const catById = new Map<number, Category>(catalog.categories.map((c) => [c.id, c]))

    if (products.length === 0) {
        return (
            <div className="grid-empty">
                <p>Aucun produit trouvé</p>
                <span>Essayez un autre nom ou code-barres</span>
            </div>
        )
    }

    if (compact) {
        return (
            <div className="product-list">
                {products.map((p) => (
                    <button className="product-row" key={p.id} onClick={() => onAdd(p)}>
                        <span className="product-row-label">{productLabel(p, showReference)}</span>
                        <span className="product-row-prices">
                            {showHt && <span className="product-row-ht">{formatAmount(p.price_ttc / (1 + p.tva_tx / 100), catalog.currency)} HT</span>}
                            <span className="product-row-ttc">{formatAmount(p.price_ttc, catalog.currency)}</span>
                        </span>
                    </button>
                ))}
            </div>
        )
    }

    return (
        <div className="product-grid">
            {products.map((p) => {
                const cat = p.category_ids.length > 0 ? catById.get(p.category_ids[0]) : undefined
                const tint = cat?.color ?? '#94a3b8'
                const imgUrl = hideImages ? undefined : images.products[String(p.id)]
                return (
                    <button className="product-card" key={p.id} onClick={() => onAdd(p)}>
                        <span className="product-thumb" style={{ color: tint, background: `${tint}14` }}>
                            {imgUrl ? (
                                <img src={imgUrl} alt="" loading="lazy" draggable={false} />
                            ) : (
                                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M21 8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16Z" />
                                    <path d="m3.3 7 8.7 5 8.7-5" /><path d="M12 22V12" />
                                </svg>
                            )}
                        </span>
                        <span className="product-label">{productLabel(p, showReference)}</span>
                        <span className="product-price">
                            {formatAmount(p.price_ttc, catalog.currency)}
                            {showHt && (
                                <span className="product-price-ht">
                                    {formatAmount(p.price_ttc / (1 + p.tva_tx / 100), catalog.currency)} HT
                                </span>
                            )}
                        </span>
                    </button>
                )
            })}
        </div>
    )
}
