// ─────────────────────────────────────────────────────────────────────────────
// Synchro Cloud → Local (sens unique pour l'instant).
//
// Passe par le Dashboard (broker) : la caisse n'a JAMAIS d'accès direct à la base
// Infomaniak. Auth = X-Terminal-Key (déjà utilisée par le heartbeat). L'instance
// est identifiée par son instance_url (ex: acme.cieloo.io).
//
//  - 1er passage : seed complet (la base locale DEVIENT celle du cloud).
//  - ensuite     : pull incrémental des lignes modifiées (watermark sur `tms`).
//
// Le Dashboard renvoie déjà du SQL réécrit vers le préfixe local (llx_), gzip.
// ─────────────────────────────────────────────────────────────────────────────

import { app, net } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import {
    recreateLocalDatabase,
    importSqlGz,
    getSyncState,
    setSyncState,
    type TableProgressFn,
} from '../local-dolibarr/main'

export interface SyncDeps {
    dashboardUrl: string
    terminalKey: string
    instanceUrl: string
}

export interface SyncInfo {
    db_name: string
    src_prefix: string
    target_prefix: string
    dolibarr_version: string | null
    tables: number
    est_bytes?: number
}

type ProgressFn = (info: { phase: string; pct?: number; message?: string }) => void

// Le pack local est en Dolibarr 21.0.x : on n'accepte de synchroniser/installer
// que des instances de la même série mineure (le schéma doit correspondre).
export const EXPECTED_DOLIBARR_SERIES = '21.0'
export const EXPECTED_DOLIBARR_LABEL = '21.0.1'

/** true si la version cloud est compatible avec le pack local (ou inconnue → on ne bloque pas). */
export function isVersionCompatible(version: string | null | undefined): boolean {
    if (!version) return true
    return version.trim().startsWith(EXPECTED_DOLIBARR_SERIES)
}

function headerStr(v: string | string[] | undefined): string | null {
    if (!v) return null
    return Array.isArray(v) ? (v[0] ?? null) : v
}

function buildUrl(deps: SyncDeps, route: string, params: Record<string, string> = {}): string {
    const qs = new URLSearchParams({ instance_url: deps.instanceUrl, ...params }).toString()
    return `${deps.dashboardUrl.replace(/\/$/, '')}/api/sync/${route}?${qs}`
}

/** GET JSON sur un endpoint sync. */
function getJson<T>(deps: SyncDeps, route: string, params?: Record<string, string>): Promise<T> {
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url: buildUrl(deps, route, params) })
        req.setHeader('X-Terminal-Key', deps.terminalKey)
        req.on('response', (res) => {
            let body = ''
            res.on('data', (c) => { body += c.toString() })
            res.on('end', () => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur ${route}: ${body.slice(0, 300)}`)); return }
                try { resolve(JSON.parse(body) as T) } catch (e) { reject(e as Error) }
            })
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
    })
}

/** Télécharge un flux SQL gzip vers un fichier temporaire. Renvoie le watermark serveur. */
function downloadGz(deps: SyncDeps, route: string, params: Record<string, string>, onBytes?: (n: number) => void): Promise<{ file: string; until: string | null }> {
    return new Promise((resolve, reject) => {
        const file = path.join(app.getPath('temp'), `cieloo-sync-${route}-${Date.now()}.sql.gz`)
        const req = net.request({ method: 'GET', url: buildUrl(deps, route, params) })
        req.setHeader('X-Terminal-Key', deps.terminalKey)
        req.on('response', (res) => {
            if (res.statusCode !== 200) {
                let body = ''
                res.on('data', (c) => { body += c.toString() })
                res.on('end', () => reject(new Error(`HTTP ${res.statusCode} sur ${route}: ${body.slice(0, 300)}`)))
                return
            }
            const until = headerStr(res.headers['x-cieloo-until'])
            const out = fs.createWriteStream(file)
            let received = 0
            res.on('data', (chunk: Buffer) => { received += chunk.length; out.write(chunk); onBytes?.(received) })
            res.on('end', () => out.end(() => resolve({ file, until })))
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
    })
}

export function fetchSyncInfo(deps: SyncDeps): Promise<SyncInfo> {
    return getJson<SyncInfo>(deps, 'info')
}

export interface PackInfo {
    version: string
    download_url: string
    sha256: string
    size: number
}

/** Récupère les infos du dernier pack hébergé sur le dashboard (endpoint public). */
export function fetchLatestPack(dashboardUrl: string): Promise<PackInfo> {
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url: `${dashboardUrl.replace(/\/$/, '')}/api/packs/latest` })
        req.on('response', (res) => {
            let body = ''
            res.on('data', (c) => { body += c.toString() })
            res.on('end', () => {
                if (res.statusCode !== 200) { reject(new Error(`HTTP ${res.statusCode} sur /packs/latest: ${body.slice(0, 200)}`)); return }
                try { resolve(JSON.parse(body) as PackInfo) } catch (e) { reject(e as Error) }
            })
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
    })
}

function mb(n: number): string { return (n / 1048576).toFixed(1) + ' Mo' }

// Throttle : 1 mise a jour max toutes les `everyMs` (evite le spam de l'ecran).
function throttle<T extends (...a: never[]) => void>(fn: T, everyMs: number): T {
    let last = 0
    return ((...args: never[]) => {
        const now = Date.now()
        if (now - last >= everyMs) { last = now; fn(...args) }
    }) as T
}

// Construit le callback de progression « table i/total + ETA » pour l'import.
function importTracker(onProgress: ProgressFn | undefined, label: string): TableProgressFn {
    const start = Date.now()
    return (done, total, table) => {
        const pct = total > 0 ? Math.round((done / total) * 100) : undefined
        const elapsed = (Date.now() - start) / 1000
        const eta = done > 0 && total > 0 ? Math.max(0, Math.round((elapsed / done) * (total - done))) : null
        const etaStr = eta !== null ? ` · ~${eta}s` : ''
        onProgress?.({ phase: 'sync-import', pct, message: `${label} (${done}/${total}) ${table}${etaStr}` })
    }
}

/** Seed complet : remplace la base locale par celle du cloud. Renvoie le nouveau watermark. */
export async function seedLocalFromCloud(deps: SyncDeps, onProgress?: ProgressFn): Promise<string | null> {
    onProgress?.({ phase: 'sync-seed', message: 'Téléchargement de la base cloud…' })
    const onBytes = throttle((n: number) => {
        onProgress?.({ phase: 'sync-seed', message: `Téléchargement de la base cloud… (${mb(n)})` })
    }, 400)
    const { file, until } = await downloadGz(deps, 'full', {}, onBytes)
    try {
        onProgress?.({ phase: 'sync-import', pct: 0, message: 'Réinitialisation de la base locale…' })
        await recreateLocalDatabase()
        await importSqlGz(file, importTracker(onProgress, 'Import de la base'))
        setSyncState({ seeded: true, watermark: until })
        onProgress?.({ phase: 'sync-done', pct: 100, message: 'Base synchronisée depuis le cloud.' })
        return until
    } finally {
        fs.promises.rm(file, { force: true }).catch(() => { /* nettoyage best-effort */ })
    }
}

/** Pull incrémental : applique les lignes modifiées depuis le watermark. Renvoie le nouveau watermark. */
export async function pullCloudChanges(deps: SyncDeps, since: string, onProgress?: ProgressFn): Promise<string | null> {
    onProgress?.({ phase: 'sync-changes', message: 'Récupération des changements cloud…' })
    const { file, until } = await downloadGz(deps, 'changes', { since })
    try {
        await importSqlGz(file, importTracker(onProgress, 'Mise à jour'))
        if (until) setSyncState({ watermark: until })
        onProgress?.({ phase: 'sync-done', pct: 100, message: 'Caisse à jour.' })
        return until ?? since
    } finally {
        fs.promises.rm(file, { force: true }).catch(() => { /* nettoyage best-effort */ })
    }
}

/**
 * Orchestration complète appelée à chaque démarrage en mode local :
 *  - récupère les infos d'instance (et la version Dolibarr) ;
 *  - bloque si la version cloud est incompatible (throw avec code 'VERSION_MISMATCH') ;
 *  - seed complet au 1er passage, sinon pull incrémental.
 * En cas d'erreur réseau (cloud injoignable), on NE bloque PAS : la caisse locale
 * doit fonctionner hors-ligne — on réessaiera au prochain lancement.
 */
export async function runCloudSync(deps: SyncDeps, onProgress?: ProgressFn): Promise<{ status: 'seeded' | 'updated' | 'skipped' | 'offline'; version?: string | null }> {
    let info: SyncInfo
    try {
        onProgress?.({ phase: 'sync-check', message: 'Vérification de la caisse cloud…' })
        info = await fetchSyncInfo(deps)
    } catch {
        // Cloud injoignable / instance inconnue → on continue en local sans bloquer.
        return { status: 'offline' }
    }

    if (!isVersionCompatible(info.dolibarr_version)) {
        const err = new Error(
            `Cette instance est en Dolibarr ${info.dolibarr_version}. `
            + `La caisse locale nécessite la version ${EXPECTED_DOLIBARR_LABEL}.`
        ) as Error & { code?: string; version?: string | null }
        err.code = 'VERSION_MISMATCH'
        err.version = info.dolibarr_version
        throw err
    }

    const state = getSyncState()
    if (!state.seeded || !state.watermark) {
        await seedLocalFromCloud(deps, onProgress)
        return { status: 'seeded', version: info.dolibarr_version }
    }
    await pullCloudChanges(deps, state.watermark, onProgress)
    return { status: 'updated', version: info.dolibarr_version }
}
