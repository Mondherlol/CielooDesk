import type { CartLine, Product } from './types'

export type CartAction =
    // qty : +1 par défaut ; passer -1 pour le "mode retour" (ligne à quantité négative,
    // comme Retour() côté online). Ajouter/re-ajouter un produit le remonte en haut du panier.
    | { type: 'add'; product: Product; qty?: number }
    | { type: 'inc'; productId: number }
    | { type: 'dec'; productId: number } // à 1, décrémenter retire la ligne
    | { type: 'set_qty'; productId: number; qty: number } // popup quantité — 0/négatif retire la ligne
    | { type: 'set_discount'; productId: number; percent: number } // remise ligne (%)
    | { type: 'global_discount'; percent: number } // remise ticket : écrase la remise de TOUTES les lignes
    | { type: 'remove'; productId: number }
    | { type: 'clear' }

function clampPercent(p: number): number {
    if (!Number.isFinite(p)) return 0
    return Math.max(0, Math.min(100, p))
}

export function cartReducer(lines: CartLine[], action: CartAction): CartLine[] {
    switch (action.type) {
        case 'add': {
            const delta = action.qty ?? 1
            const existing = lines.find((l) => l.product.id === action.product.id)
            const rest = lines.filter((l) => l.product.id !== action.product.id)
            const newQty = (existing?.qty ?? 0) + delta
            if (newQty <= 0) return rest // scan en mode retour d'un article déjà entièrement retourné
            // Remonte en haut du panier — dernier article touché toujours visible en premier.
            return [{ product: action.product, qty: newQty, discount_percent: existing?.discount_percent ?? 0 }, ...rest]
        }
        case 'inc':
            return lines.map((l) =>
                l.product.id === action.productId ? { ...l, qty: l.qty + 1 } : l
            )
        case 'dec':
            return lines
                .map((l) => (l.product.id === action.productId ? { ...l, qty: l.qty - 1 } : l))
                .filter((l) => l.qty > 0)
        case 'set_qty':
            if (action.qty <= 0) return lines.filter((l) => l.product.id !== action.productId)
            return lines.map((l) => (l.product.id === action.productId ? { ...l, qty: action.qty } : l))
        case 'set_discount':
            return lines.map((l) =>
                l.product.id === action.productId ? { ...l, discount_percent: clampPercent(action.percent) } : l
            )
        case 'global_discount': {
            // Comme update_reduction_global côté online : le % remplace la remise
            // de CHAQUE ligne, il ne s'ajoute pas à une remise déjà posée.
            const pct = clampPercent(action.percent)
            return lines.map((l) => ({ ...l, discount_percent: pct }))
        }
        case 'remove':
            return lines.filter((l) => l.product.id !== action.productId)
        case 'clear':
            return []
    }
}

/** Total TTC d'une ligne, remise déduite. */
export function lineTotal(line: CartLine): number {
    const discount = line.discount_percent ?? 0
    return line.product.price_ttc * line.qty * (1 - discount / 100)
}

export function cartTotal(lines: CartLine[]): number {
    return lines.reduce((sum, l) => sum + lineTotal(l), 0)
}

export function cartCount(lines: CartLine[]): number {
    return lines.reduce((sum, l) => sum + l.qty, 0)
}
