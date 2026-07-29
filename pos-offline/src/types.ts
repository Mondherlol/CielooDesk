// Format du snapshot servi par cieloopos/api/offline_snapshot.php.
// La fixture JSON (mode dev navigateur, sans shell) respecte le même contrat.

export interface Category {
    id: number
    label: string
    color: string // '' si non définie dans Dolibarr → palette de repli appliquée au chargement
    icon?: string | null // classe FontAwesome configurée dans le POS (non rendue offline pour l'instant)
}

/** Vignettes disponibles localement : id (string) → URL file://. */
export interface ImagesMap {
    products: Record<string, string>
    categories: Record<string, string>
}

export interface Product {
    id: number
    ref: string
    label: string
    barcode: string | null
    price_ttc: number
    tva_tx: number
    /** Plancher de remise (invoice.php:updatereduction) — null/absent = pas de plancher. */
    price_min?: number | null
    category_ids: number[] // un produit Dolibarr peut être dans plusieurs catégories
}

export interface Customer {
    id: number // négatif = client créé hors-ligne, pas encore connu de Dolibarr
    name: string
    code_client: string | null
    barcode?: string | null
    phone: string | null
    email: string | null
    /** Solde fidélité — null si non éligible ou module désactivé. */
    points?: number | null
    /** Nombre de visites (factures converties fidélité). */
    visits?: number | null
    /** Palier de fidélité atteint (label + couleur configurés dans le module). */
    tier?: { label: string; color: string } | null
    /** true = créé hors-ligne sur cette caisse. */
    local?: boolean
}

export interface Sale {
    id: number
    ref: string
    date: string | null
    total_ttc: number
    paid: boolean
    customer: string | null
}

export interface UserInfo {
    id: number
    login: string
    name: string
}

// ─── Template du ticket (Ticket Designer de la caisse online) ───────────────

/** Bloc de layout tel que stocké par le designer — propriétés libres par type. */
export interface ReceiptBlock {
    id?: string
    type: string
    visible?: boolean
    [key: string]: unknown
}

export interface ReceiptInfo {
    layout: ReceiptBlock[]
    company: { name: string; address: string; zip: string; town: string; mf: string }
    warehouse: { name: string; address: string; address2: string; city: string; zip: string; mf: string }
    logo: string // data URI ('' si pas de logo)
    header_text: string
    footer_text: string
    terminal: string
    terminal_name: string
}

// ─── Terminal / réglages d'affichage (admin/terminal.php, appearance.php, setup.php) ─

export interface TerminalInfo {
    id: number
    name: string | null
    warehouse_id: number | null
    /** Tiers "comptoir" par défaut de ce terminal — pour le rejeu des ventes "Client Passager". */
    default_customer_id: number | null
    product_display_mode: 'images' | 'compact'
}

export interface DisplaySettings {
    hide_categories: boolean
    hide_category_images: boolean
    hide_product_images: boolean
    /** 0 = libellé seul, 1 = réf + libellé, 2 = réf seule. */
    show_product_reference: 0 | 1 | 2
    show_cat_product_count: boolean
    hide_empty_categories: boolean
    sort_product_field: 'rowid' | 'ref' | 'label' | 'datec' | 'tms' | string
    show_ht: boolean
    hide_zero_price_products: boolean
    root_category_id: number
}

export interface Catalog {
    generated_at: string // horodatage serveur du snapshot
    currency: string
    user?: UserInfo // utilisateur POS dont la session a produit le snapshot
    receipt?: ReceiptInfo | null // template de ticket du designer (null si libs absentes)
    fidelite_enabled?: boolean // module fidélité actif sur l'instance
    terminal?: TerminalInfo | null
    settings?: DisplaySettings
    categories: Category[]
    products: Product[]
    customers?: Customer[]
    sales?: Sale[]
}

export interface CartLine {
    product: Product
    qty: number
    /** Remise ligne en % (0-100), comme invoice.php:updatereduction. */
    discount_percent?: number
}

// ─── Vente hors-ligne (document d'outbox) ───────────────────────────────────
// Chaque vente est un document autonome, persisté AVANT la confirmation à
// l'écran, rejoué plus tard vers le cloud (endpoint d'import idempotent).

export type PaymentMethod = 'cash' | 'card'

export interface OfflineSaleLine {
    product_id: number
    ref: string
    label: string
    barcode: string | null
    qty: number
    unit_price_ttc: number
    tva_tx: number
    /** Remise appliquée sur cette ligne (%), 0 si aucune — déjà déduite de total_ttc. */
    discount_percent: number
    total_ttc: number
}

export interface OfflineSalePayment {
    method: PaymentMethod
    received: number | null // espèces : montant donné ; carte : null
    change: number | null   // espèces : monnaie rendue ; carte : null
}

/** Client rattaché à une vente. Pour un client créé hors-ligne (id négatif),
 *  on embarque ses coordonnées : le rejeu le créera côté Dolibarr. */
export interface SaleCustomer {
    id: number
    name: string
    local?: boolean
    phone?: string | null
    email?: string | null
}

export interface OfflineSale {
    uuid: string
    ref: string             // réf provisoire OFF-XXXX, la vraie numérotation vient au rejeu
    created_at: string      // ISO local
    user: UserInfo | null
    customer: SaleCustomer | null // null = client passager
    currency: string
    lines: OfflineSaleLine[]
    total_ttc: number
    payment: OfflineSalePayment
    status: 'pending'
    /** true une fois rejouée avec succès vers Dolibarr (rejeu = idempotent par uuid). */
    synced?: boolean
    /** Vraie référence Dolibarr attribuée au rejeu (la réf OFF-XXXX reste la réf locale). */
    real_ref?: string
    facture_id?: number
}
