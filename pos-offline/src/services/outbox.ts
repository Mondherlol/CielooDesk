// Outbox des ventes hors-ligne. La persistance passe par le shell quand il est
// là (fichiers JSON dans userData, écrits par le main Electron — survivent à
// un crash/coupure de courant), sinon localStorage (dev navigateur).
// La réf provisoire OFF-XXXX est attribuée par la couche de stockage.

import type { OfflineSale } from '../types'

const LS_KEY = 'cieloo-offline-outbox'

/** Vente sans réf : la réf est attribuée à l'enregistrement. */
export type DraftSale = Omit<OfflineSale, 'ref'>

function readLocal(): OfflineSale[] {
    try { return JSON.parse(localStorage.getItem(LS_KEY) ?? '[]') as OfflineSale[] } catch { return [] }
}

/** Enregistre la vente et renvoie la réf provisoire attribuée (OFF-XXXX). */
export async function saveSale(draft: DraftSale): Promise<string> {
    const bridge = window.cielooOffline
    if (bridge?.saveSale) {
        const res = await bridge.saveSale(draft)
        if (!res.ok || !res.ref) throw new Error(res.error ?? 'Échec de l\'enregistrement de la vente.')
        return res.ref
    }
    const sales = readLocal()
    const ref = `OFF-${String(sales.length + 1).padStart(4, '0')}`
    sales.push({ ...draft, ref })
    localStorage.setItem(LS_KEY, JSON.stringify(sales))
    return ref
}

/** Ventes locales, la plus récente d'abord. */
export async function listSales(): Promise<OfflineSale[]> {
    const bridge = window.cielooOffline
    if (bridge?.listSales) {
        const sales = (await bridge.listSales()) as OfflineSale[]
        return sales
    }
    return readLocal().slice().reverse()
}

/** Téléverse une vente vers le cloud (bouton "Téléverser" du ticket). */
export async function syncSale(uuid: string): Promise<{ ok: boolean; ref?: string; error?: string }> {
    const bridge = window.cielooOffline
    if (!bridge?.syncSale) return { ok: false, error: 'Synchronisation indisponible hors du shell.' }
    return bridge.syncSale(uuid)
}
