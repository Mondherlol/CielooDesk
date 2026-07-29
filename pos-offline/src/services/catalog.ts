// Accès au catalogue : snapshot réel via le pont du shell (window.cielooOffline,
// alimenté par cieloopos/api/offline_snapshot.php), sinon fixture JSON embarquée
// (dev navigateur sans shell).

import type { Catalog, Customer, Product } from '../types'
import fixture from '../data/catalog.json'

// Les catégories Dolibarr n'ont pas toujours de couleur : palette de repli,
// attribution stable (index de la catégorie dans la liste).
const FALLBACK_COLORS = ['#0ea5e9', '#f59e0b', '#10b981', '#8b5cf6', '#ec4899', '#d97706', '#14b8a6', '#f43f5e']

function normalizeCatalog(raw: Catalog): Catalog {
    return {
        ...raw,
        categories: raw.categories.map((c, i) => ({
            ...c,
            color: c.color && c.color.trim() !== '' ? c.color : FALLBACK_COLORS[i % FALLBACK_COLORS.length],
        })),
    }
}

export async function loadCatalog(): Promise<Catalog> {
    const bridge = window.cielooOffline
    if (bridge) {
        const snap = (await bridge.getSnapshot()) as Catalog | null
        if (snap && Array.isArray(snap.products) && Array.isArray(snap.categories)) {
            return normalizeCatalog(snap)
        }
    }
    return normalizeCatalog(fixture as Catalog)
}

/** Minuscules + sans accents, pour une recherche tolérante ("creme" → "Crème"). */
const DIACRITICS = /\p{Diacritic}/gu
function normalize(s: string): string {
    return s.toLowerCase().normalize('NFD').replace(DIACRITICS, '')
}


/** Recherche par libellé, ref ou code-barres (toutes catégories confondues). */
export function searchProducts(products: Product[], query: string): Product[] {
    const q = normalize(query.trim())
    if (!q) return products
    return products.filter((p) =>
        normalize(p.label).includes(q) ||
        normalize(p.ref).includes(q) ||
        (p.barcode !== null && p.barcode.includes(q))
    )
}

/** Correspondance exacte de code-barres (scan douchette ou Entrée dans la recherche). */
export function findByBarcode(products: Product[], code: string): Product | null {
    const c = code.trim()
    if (!c) return null
    return products.find((p) => p.barcode === c) ?? null
}

/** Recherche client par nom, code, code-barres carte, téléphone ou email. */
export function searchCustomers(customers: Customer[], query: string): Customer[] {
    const q = normalize(query.trim())
    if (!q) return customers
    return customers.filter((c) =>
        normalize(c.name).includes(q) ||
        (c.code_client !== null && normalize(c.code_client).includes(q)) ||
        (c.barcode != null && c.barcode.includes(q)) ||
        (c.phone !== null && c.phone.replace(/\s/g, '').includes(q.replace(/\s/g, ''))) ||
        (c.email !== null && normalize(c.email).includes(q))
    )
}

/** Montant avec devise ("4,760 TND") — nb de décimales dicté par la devise. */
export function formatPrice(amount: number, currency: string): string {
    return new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).format(amount)
}

const decimalsCache = new Map<string, number>()

/** Montant seul ("4,760"), comme sur les tuiles produits de la caisse online. */
export function formatAmount(amount: number, currency: string): string {
    let dec = decimalsCache.get(currency)
    if (dec === undefined) {
        try {
            dec = new Intl.NumberFormat('fr-FR', { style: 'currency', currency }).resolvedOptions().maximumFractionDigits ?? 2
        } catch { dec = 2 }
        decimalsCache.set(currency, dec)
    }
    return new Intl.NumberFormat('fr-FR', { minimumFractionDigits: dec, maximumFractionDigits: dec }).format(amount)
}
