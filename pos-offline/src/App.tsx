import { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import type { CartLine, Catalog, Customer, DisplaySettings, ImagesMap, OfflineSaleLine, PaymentMethod, Product } from './types'
import { cartReducer, cartTotal, lineTotal, type CartAction } from './cart'
import { findByBarcode, formatPrice, loadCatalog, searchProducts } from './services/catalog'
import { saveSale, listSales, type DraftSale } from './services/outbox'
import { createLocalCustomer, listLocalCustomers } from './services/customers'
import { renderReceiptHtml } from './services/receipt'
import { playAdd, playError, playScan, playSuccess, playTick } from './services/sounds'
import { useBarcodeScanner } from './services/useBarcodeScanner'
import CartPanel from './components/CartPanel'
import CategorySidebar from './components/CategorySidebar'
import CustomerPicker from './components/CustomerPicker'
import DiscountPopup from './components/DiscountPopup'
import FreeLineModal from './components/FreeLineModal'
import LocalSalesModal from './components/LocalSalesModal'
import PaymentModal from './components/PaymentModal'
import ProductGrid from './components/ProductGrid'
import QtyPopup from './components/QtyPopup'
import ReceiptModal from './components/ReceiptModal'
import SearchBar from './components/SearchBar'
import TicketDiscountModal from './components/TicketDiscountModal'

interface Toast {
    kind: 'ok' | 'error'
    message: string
}

// Repli si le snapshot ne fournit pas encore ces réglages (ancien snapshot en
// cache, ou fixture de dev) — préserve le comportement déjà en place.
const DEFAULT_SETTINGS: DisplaySettings = {
    hide_categories: false,
    hide_category_images: false,
    hide_product_images: false,
    show_product_reference: 0,
    show_cat_product_count: true,
    hide_empty_categories: true,
    sort_product_field: 'label',
    show_ht: false,
    hide_zero_price_products: false,
    root_category_id: 0,
}

/** Chrono hors-ligne : "04:37" puis "1:02:15" au-delà d'une heure. */
function formatElapsed(ms: number): string {
    const s = Math.floor(Math.max(0, ms) / 1000)
    const h = Math.floor(s / 3600)
    const m = Math.floor((s % 3600) / 60)
    const sec = s % 60
    const mm = String(m).padStart(2, '0')
    const ss = String(sec).padStart(2, '0')
    return h > 0 ? `${h}:${mm}:${ss}` : `${mm}:${ss}`
}

export default function App() {
    const [catalog, setCatalog] = useState<Catalog | null>(null)
    const [selectedCat, setSelectedCat] = useState<number | null>(null)
    const [query, setQuery] = useState('')
    const [cart, dispatch] = useReducer(cartReducer, [])
    const [customer, setCustomer] = useState<Customer | null>(null)
    const [localCustomers, setLocalCustomers] = useState<Customer[]>([])
    const [pickerOpen, setPickerOpen] = useState(false)
    const [paymentMethod, setPaymentMethod] = useState<PaymentMethod | null>(null) // null = modal fermée
    const [salesOpen, setSalesOpen] = useState(false)
    const [receiptView, setReceiptView] = useState<{ html: string; ref: string } | null>(null)
    const [pendingCount, setPendingCount] = useState(0)
    const [qtyEditLine, setQtyEditLine] = useState<CartLine | null>(null)
    const [discountEditLine, setDiscountEditLine] = useState<CartLine | null>(null)
    const [ticketDiscountOpen, setTicketDiscountOpen] = useState(false)
    const [freeLineOpen, setFreeLineOpen] = useState(false)
    const [terminalName, setTerminalName] = useState<string | null>(null)
    const [images, setImages] = useState<ImagesMap>({ products: {}, categories: {} })
    // Repli : si le shell ne fournit pas l'horodatage, on compte depuis l'ouverture de la SPA.
    const [offlineSince, setOfflineSince] = useState<number>(() => Date.now())
    const [now, setNow] = useState<number>(() => Date.now())
    const [toast, setToast] = useState<Toast | null>(null)
    const toastTimer = useRef<number | undefined>(undefined)

    useEffect(() => {
        loadCatalog().then(setCatalog)
        void listSales().then((s) => setPendingCount(s.length))
        void listLocalCustomers().then((c) => setLocalCustomers(c.slice().reverse()))
        void window.cielooOffline?.getContext?.()
            .then((ctx) => {
                setTerminalName(ctx?.terminalName ?? null)
                if (ctx?.offlineSince) setOfflineSince(ctx.offlineSince)
            })
            .catch(() => { /* ancien shell sans getContext : badge par défaut */ })
        const clockTimer = window.setInterval(() => setNow(Date.now()), 1000)
        // Vignettes locales : re-scan périodique, la synchro tourne en arrière-plan
        // côté shell et de nouvelles images peuvent arriver pendant la session.
        const loadImages = (): void => {
            void window.cielooOffline?.getImages?.()
                .then((m) => { if (m) setImages(m) })
                .catch(() => { /* pas d'images : placeholders */ })
        }
        loadImages()
        const imgTimer = window.setInterval(loadImages, 60_000)
        return () => {
            window.clearInterval(imgTimer)
            window.clearInterval(clockTimer)
        }
    }, [])

    function showToast(kind: Toast['kind'], message: string, durationMs = 2200): void {
        window.clearTimeout(toastTimer.current)
        setToast({ kind, message })
        toastTimer.current = window.setTimeout(() => setToast(null), durationMs)
    }

    /** Dispatch panier avec bruitage selon l'action. */
    function dispatchCart(action: CartAction): void {
        if (action.type === 'add' || action.type === 'inc') playAdd()
        else playTick()
        dispatch(action)
    }

    /** Ajout produit (tuile, scan ou article libre). Pas de retours en mode hors-ligne. */
    function addProduct(product: Product, qty = 1): void {
        dispatchCart({ type: 'add', product, qty })
    }

    /** Scan douchette (hors champ de saisie) ou Entrée dans la recherche. */
    function handleCode(code: string): void {
        if (!catalog) return
        const product = findByBarcode(catalog.products, code)
        if (product) {
            playScan()
            addProduct(product)
            showToast('ok', `${product.label} ajouté`)
            setQuery('')
        } else if (code.trim()) {
            playError()
            showToast('error', `Code-barres inconnu : ${code.trim()}`)
        }
    }

    useBarcodeScanner(handleCode)

    /** Vente validée dans la modal : persistée AVANT d'afficher le succès. */
    async function completeSale(method: PaymentMethod, received: number | null): Promise<void> {
        if (!catalog || cart.length === 0) return
        const total = cartTotal(cart)
        const lines: OfflineSaleLine[] = cart.map((l) => ({
            product_id: l.product.id,
            ref: l.product.ref,
            label: l.product.label,
            barcode: l.product.barcode,
            qty: l.qty,
            unit_price_ttc: l.product.price_ttc,
            tva_tx: l.product.tva_tx,
            discount_percent: l.discount_percent ?? 0,
            total_ttc: lineTotal(l),
        }))
        const change = method === 'cash' && received !== null ? Math.max(0, received - total) : null
        const draft: DraftSale = {
            uuid: crypto.randomUUID(),
            created_at: new Date().toISOString(),
            user: catalog.user ?? null,
            // Client créé hors-ligne (id négatif) : coordonnées embarquées, le
            // rejeu le créera dans Dolibarr avant de rattacher la facture.
            customer: customer
                ? {
                    id: customer.id,
                    name: customer.name,
                    ...(customer.local ? { local: true as const, phone: customer.phone, email: customer.email } : {}),
                }
                : null,
            currency: catalog.currency,
            lines,
            total_ttc: total,
            payment: { method, received: method === 'cash' ? received : null, change },
            status: 'pending',
        }
        try {
            const ref = await saveSale(draft)
            playSuccess()
            dispatch({ type: 'clear' })
            setCustomer(null)
            setPaymentMethod(null)
            setPendingCount((c) => c + 1)
            const changeMsg = change !== null && change > 0
                ? ` — rendu ${formatPrice(change, catalog.currency)}`
                : ''
            showToast('ok', `Vente ${ref} enregistrée${changeMsg}`, 3500)
            printReceipt({ ...draft, ref })
        } catch (err) {
            playError()
            showToast('error', (err as Error).message, 4000)
        }
    }

    /** Envoie le HTML du ticket à l'impression (shell, sinon fenêtre navigateur). */
    function printHtml(html: string): void {
        const bridge = window.cielooOffline
        if (bridge?.printReceipt) {
            void bridge.printReceipt(html).then((res) => {
                if (!res.ok) showToast('error', `Impression : ${res.error ?? 'échec'}`, 4000)
            })
            return
        }
        // Dev navigateur : aperçu dans une fenêtre + dialogue d'impression.
        const w = window.open('', '_blank', 'width=380,height=640')
        if (w) {
            w.document.write(html)
            w.document.close()
            w.focus()
            setTimeout(() => w.print(), 300)
        }
    }

    /** Ticket : même rendu que le Ticket Designer — affiché en modal + imprimé. */
    function printReceipt(sale: DraftSale & { ref: string }): void {
        if (!catalog) return
        const html = renderReceiptHtml({ ...sale, status: 'pending' }, catalog)
        setReceiptView({ html, ref: sale.ref })
        printHtml(html)
    }

    const settings = catalog?.settings ?? DEFAULT_SETTINGS
    const compactMode = catalog?.terminal?.product_display_mode === 'compact'
    const vatRates = useMemo(
        () => [...new Set((catalog?.products ?? []).map((p) => p.tva_tx))].sort((a, b) => a - b),
        [catalog]
    )

    // Recherche active → toutes catégories ; sinon filtre par catégorie sélectionnée.
    const visible = useMemo(() => {
        if (!catalog) return []
        const q = query.trim()
        const base = q ? searchProducts(catalog.products, q)
            : selectedCat === null ? catalog.products
                : catalog.products.filter((p) => p.category_ids.includes(selectedCat))
        // admin/setup.php : TAKEPOS_SORTPRODUCTFIELD (ref/label pris en charge côté client ;
        // rowid/datec/tms retombent sur l'ordre naturel du snapshot, faute de ces champs ici).
        const field = settings.sort_product_field
        if (field === 'ref') return [...base].sort((a, b) => a.ref.localeCompare(b.ref))
        if (field === 'label') return [...base].sort((a, b) => a.label.localeCompare(b.label))
        return base
    }, [catalog, query, selectedCat, settings.sort_product_field])

    const countsByCat = useMemo(() => {
        const m = new Map<number, number>()
        for (const p of catalog?.products ?? []) {
            for (const catId of p.category_ids) {
                m.set(catId, (m.get(catId) ?? 0) + 1)
            }
        }
        return m
    }, [catalog])

    // admin/appearance.php : CIELOOPOS_HIDE_EMPTY_CATEGORIES (les catégories sans
    // aucun produit sont masquées par défaut, comme la caisse en ligne).
    const visibleCategories = useMemo(() => {
        const all = catalog?.categories ?? []
        if (!settings.hide_empty_categories) return all
        return all.filter((c) => (countsByCat.get(c.id) ?? 0) > 0)
    }, [catalog, countsByCat, settings.hide_empty_categories])

    if (!catalog) {
        return <div className="loading">Chargement du catalogue…</div>
    }

    const currentCatLabel = query.trim()
        ? `Résultats pour « ${query.trim()} »`
        : selectedCat === null
            ? 'Tous les produits'
            : catalog.categories.find((c) => c.id === selectedCat)?.label ?? 'Produits'

    const today = new Date().toLocaleDateString('fr-FR')
    const snapshotDate = new Date(catalog.generated_at).toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit',
    })

    return (
        <div className="app">
            <header className="topbar">
                <div className="terminal-badge">
                    <span className="terminal-icon">
                        <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <rect x="2" y="3" width="20" height="14" rx="2" /><line x1="8" y1="21" x2="16" y2="21" /><line x1="12" y1="17" x2="12" y2="21" />
                        </svg>
                    </span>
                    <span className="terminal-info">
                        <span className="terminal-name">{terminalName ?? 'CaisLà'}</span>
                        <span className="terminal-date">{today}</span>
                    </span>
                </div>

                <span className="offline-pill" title={`Données du ${snapshotDate}`}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3Z" />
                        <line x1="12" y1="9" x2="12" y2="13" /><line x1="12" y1="17" x2="12.01" y2="17" />
                    </svg>
                    MODE LOCAL
                    <span className="offline-elapsed">
                        <span className="offline-dot" />
                        {formatElapsed(now - offlineSince)}
                    </span>
                </span>

                <button className="pending-pill" title="Ventes locales en attente de transmission" onClick={() => setSalesOpen(true)}>
                    <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <path d="M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1Z" />
                        <path d="M8 7h8" /><path d="M8 11h8" /><path d="M8 15h5" />
                    </svg>
                    {pendingCount} vente{pendingCount > 1 ? 's' : ''}
                </button>

                <SearchBar value={query} onChange={setQuery} onSubmit={handleCode} />

                {window.cielooOffline && (
                    <button
                        className="return-online-btn"
                        title="Revenir à la caisse en ligne"
                        onClick={() => void window.cielooOffline?.returnOnline()}
                    >
                        Retour en ligne
                    </button>
                )}

                {catalog.user && (
                    <div className="user-chip" title={`Connecté : ${catalog.user.login}`}>
                        <span className="user-avatar">
                            {(catalog.user.name || catalog.user.login).charAt(0).toUpperCase()}
                            <span className="user-status-dot" />
                        </span>
                        <span className="user-name">{catalog.user.name || catalog.user.login}</span>
                    </div>
                )}
            </header>

            <div className="body">
                {/* content-area regroupe sidebar+produits ; la barre d'actions du bas y
                    est rattachée pour occuper toute cette largeur SANS déborder sous
                    le panier (colonne indépendante, cf. .content-area / .content-row). */}
                <div className="content-area">
                    <div className="content-row">
                        {!settings.hide_categories && (
                            <CategorySidebar
                                categories={visibleCategories}
                                selected={query.trim() ? null : selectedCat}
                                onSelect={(id) => {
                                    setSelectedCat(id)
                                    setQuery('')
                                }}
                                counts={countsByCat}
                                images={images.categories}
                                hideImages={settings.hide_category_images}
                                showCount={settings.show_cat_product_count}
                            />
                        )}

                        <main className="main">
                            <div className="products-head">
                                <h1>{currentCatLabel}</h1>
                                <span className="products-count">
                                    {visible.length === 1 ? '1 produit' : `${visible.length} produits`}
                                </span>
                            </div>
                            <div className="grid-scroll">
                                <ProductGrid
                                    products={visible}
                                    catalog={catalog}
                                    images={images}
                                    showReference={settings.show_product_reference}
                                    showHt={settings.show_ht}
                                    hideImages={settings.hide_product_images}
                                    compact={compactMode}
                                    onAdd={addProduct}
                                />
                            </div>
                        </main>
                    </div>

                    {/* Barre d'actions rapides — sous-ensemble réaliste hors-ligne des
                        boutons de index.php (pure logique client, sans dépendance
                        serveur). Les retours sont interdits en mode hors-ligne. */}
                    <div className="quick-actions-bar">
                        <button
                            className="quick-action-btn"
                            disabled={cart.length === 0}
                            onClick={() => dispatchCart({ type: 'clear' })}
                        >
                            <span className="quick-action-icon">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M3 6h18" /><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
                                    <path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2" />
                                </svg>
                            </span>
                            Vider le panier
                        </button>
                        <button
                            className="quick-action-btn"
                            disabled={cart.length === 0}
                            onClick={() => setTicketDiscountOpen(true)}
                        >
                            <span className="quick-action-icon">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="19" y1="5" x2="5" y2="19" /><circle cx="6.5" cy="6.5" r="2.5" /><circle cx="17.5" cy="17.5" r="2.5" />
                                </svg>
                            </span>
                            Remise
                        </button>
                        <button className="quick-action-btn" onClick={() => setFreeLineOpen(true)}>
                            <span className="quick-action-icon">
                                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <line x1="12" y1="5" x2="12" y2="19" /><line x1="5" y1="12" x2="19" y2="12" />
                                </svg>
                            </span>
                            Article libre
                        </button>
                    </div>
                </div>

                <CartPanel
                    lines={cart}
                    catalog={catalog}
                    images={images}
                    customer={customer}
                    showHt={settings.show_ht}
                    dispatch={dispatchCart}
                    onPickCustomer={() => setPickerOpen(true)}
                    onClearCustomer={() => setCustomer(null)}
                    onPay={(method) => setPaymentMethod(method)}
                    onEditQty={(line) => setQtyEditLine(line)}
                    onEditDiscount={(line) => setDiscountEditLine(line)}
                />
            </div>

            {pickerOpen && (
                <CustomerPicker
                    customers={[...localCustomers, ...(catalog.customers ?? [])]}
                    fideliteEnabled={catalog.fidelite_enabled ?? false}
                    onSelect={(c) => {
                        setCustomer(c)
                        setPickerOpen(false)
                        showToast('ok', c ? `Client : ${c.name}` : 'Client passager')
                    }}
                    onCreate={async (name, phone, email) => {
                        const created = await createLocalCustomer(name, phone, email)
                        setLocalCustomers((prev) => [created, ...prev])
                        setCustomer(created)
                        setPickerOpen(false)
                        playAdd()
                        showToast('ok', `Client ${created.name} créé — sera synchronisé au retour du réseau`, 3500)
                    }}
                    onClose={() => setPickerOpen(false)}
                />
            )}

            {qtyEditLine && (
                <QtyPopup
                    label={qtyEditLine.product.label}
                    initialQty={qtyEditLine.qty}
                    onCancel={() => setQtyEditLine(null)}
                    onConfirm={(qty) => {
                        dispatchCart({ type: 'set_qty', productId: qtyEditLine.product.id, qty })
                        setQtyEditLine(null)
                    }}
                />
            )}

            {discountEditLine && (
                <DiscountPopup
                    product={discountEditLine.product}
                    currency={catalog.currency}
                    initialPercent={discountEditLine.discount_percent ?? 0}
                    onCancel={() => setDiscountEditLine(null)}
                    onConfirm={(percent) => {
                        dispatchCart({ type: 'set_discount', productId: discountEditLine.product.id, percent })
                        setDiscountEditLine(null)
                    }}
                />
            )}

            {ticketDiscountOpen && (
                <TicketDiscountModal
                    total={cartTotal(cart)}
                    currency={catalog.currency}
                    onCancel={() => setTicketDiscountOpen(false)}
                    onConfirm={(percent) => {
                        dispatchCart({ type: 'global_discount', percent })
                        setTicketDiscountOpen(false)
                        showToast('ok', `Remise de ${percent.toFixed(1)}% appliquée au ticket`)
                    }}
                />
            )}

            {freeLineOpen && (
                <FreeLineModal
                    vatRates={vatRates}
                    onCancel={() => setFreeLineOpen(false)}
                    onConfirm={(product, qty) => {
                        addProduct(product, qty)
                        setFreeLineOpen(false)
                    }}
                />
            )}

            {paymentMethod !== null && (
                <PaymentModal
                    total={cartTotal(cart)}
                    currency={catalog.currency}
                    initialMethod={paymentMethod}
                    onConfirm={(method, received) => void completeSale(method, received)}
                    onClose={() => setPaymentMethod(null)}
                />
            )}

            {salesOpen && (
                <LocalSalesModal
                    currency={catalog.currency}
                    onClose={() => setSalesOpen(false)}
                    onShowReceipt={(sale) => {
                        setSalesOpen(false)
                        setReceiptView({ html: renderReceiptHtml(sale, catalog), ref: sale.ref })
                    }}
                />
            )}

            {receiptView && (
                <ReceiptModal
                    html={receiptView.html}
                    saleRef={receiptView.ref}
                    onPrint={() => printHtml(receiptView.html)}
                    onClose={() => setReceiptView(null)}
                />
            )}

            {toast && <div className={`toast toast-${toast.kind}`}>{toast.message}</div>}
        </div>
    )
}
