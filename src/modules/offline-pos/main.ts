// ─────────────────────────────────────────────────────────────────────────────
// Caisse de secours hors-ligne (pos-offline) : la SPA React embarquée qui
// remplace l'ancien prototype "Dolibarr local complet".
//
// Principe : tant que le réseau est là, on récupère périodiquement un SNAPSHOT
// (produits, catégories, clients, dernières ventes) depuis le module cieloopos
// de l'instance — authentifié par les cookies de session du POS déjà connecté
// dans la fenêtre principale (session par défaut). Le snapshot est stocké dans
// userData ; quand la wifi coupe, la bascule est instantanée : on charge le
// bundle statique et la SPA lit le snapshot via IPC. Aucun serveur local.
// ─────────────────────────────────────────────────────────────────────────────

import { app, ipcMain, net } from 'electron'
import crypto from 'node:crypto'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { loadSettings } from '../settings/main'
import { printHtmlReceipt } from '../print-server/main'

export interface SnapshotMeta {
    fetchedAt: string        // horodatage local du téléchargement
    generatedAt: string | null // horodatage serveur (champ generated_at du JSON)
    products: number
    categories: number
    customers: number
    sales: number
    bytes: number
}

const FETCH_TIMEOUT_MS = 20_000
const AUTO_REFRESH_MS = 10 * 60 * 1000   // snapshot rafraîchi toutes les 10 min en ligne
const FIRST_REFRESH_DELAY_MS = 45_000    // laisse le temps de se connecter au POS au boot

// ─── Chemins ────────────────────────────────────────────────────────────────

function snapshotDir(): string { return path.join(app.getPath('userData'), 'offline-pos') }
function snapshotPath(): string { return path.join(snapshotDir(), 'snapshot.json') }
function metaPath(): string { return path.join(snapshotDir(), 'meta.json') }
function outboxDir(): string { return path.join(snapshotDir(), 'outbox') }
function imagesDir(kind: 'products' | 'categories'): string { return path.join(snapshotDir(), 'images', kind) }

/** index.html du bundle SPA : packagé dans resources/, sinon pos-offline/dist du repo. */
export function offlinePosIndexHtml(): string {
    if (app.isPackaged) return path.join(process.resourcesPath, 'pos-offline', 'index.html')
    return path.join(app.getAppPath(), 'pos-offline', 'dist', 'index.html')
}

export function isOfflinePosBundlePresent(): boolean {
    return fs.existsSync(offlinePosIndexHtml())
}

// ─── Snapshot stocké ────────────────────────────────────────────────────────

export function hasSnapshot(): boolean {
    return fs.existsSync(snapshotPath())
}

export function readSnapshotMeta(): SnapshotMeta | null {
    try { return JSON.parse(fs.readFileSync(metaPath(), 'utf-8')) as SnapshotMeta } catch { return null }
}

function readSnapshotRaw(): string | null {
    try { return fs.readFileSync(snapshotPath(), 'utf-8') } catch { return null }
}

// ─── Récupération depuis l'instance ─────────────────────────────────────────

interface SnapshotJson {
    generated_at?: string
    products?: unknown[]
    categories?: unknown[]
    customers?: unknown[]
    sales?: unknown[]
    error?: string
}

/**
 * Télécharge le snapshot depuis le module cieloopos de l'instance.
 * `useSessionCookies` → la requête porte la session Dolibarr de la fenêtre
 * principale : il faut qu'un utilisateur soit connecté au POS.
 */
export function fetchSnapshot(instanceBaseUrl: string): Promise<SnapshotMeta> {
    const url = `${instanceBaseUrl.replace(/\/$/, '')}/custom/cieloopos/api/offline_snapshot.php`
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url, useSessionCookies: true })
        const timer = setTimeout(() => {
            req.abort()
            reject(new Error(`Timeout (${FETCH_TIMEOUT_MS / 1000}s) sur ${url}`))
        }, FETCH_TIMEOUT_MS)

        req.on('response', (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                clearTimeout(timer)
                void (async () => {
                    const body = Buffer.concat(chunks).toString('utf-8')
                    if (res.statusCode !== 200) {
                        throw new Error(`HTTP ${res.statusCode} : ${body.slice(0, 200)}`)
                    }
                    let json: SnapshotJson
                    try { json = JSON.parse(body) as SnapshotJson } catch {
                        // Typiquement la page de login Dolibarr (session expirée) → HTML.
                        throw new Error('Réponse invalide (session POS expirée ou module absent).')
                    }
                    if (json.error) throw new Error(json.error)
                    if (!Array.isArray(json.products) || !Array.isArray(json.categories)) {
                        throw new Error('Snapshot incomplet (products/categories manquants).')
                    }
                    const meta: SnapshotMeta = {
                        fetchedAt: new Date().toISOString(),
                        generatedAt: json.generated_at ?? null,
                        products: json.products.length,
                        categories: json.categories.length,
                        customers: Array.isArray(json.customers) ? json.customers.length : 0,
                        sales: Array.isArray(json.sales) ? json.sales.length : 0,
                        bytes: Buffer.byteLength(body),
                    }
                    await fsp.mkdir(snapshotDir(), { recursive: true })
                    // Écriture atomique : jamais de snapshot à moitié écrit sur coupure.
                    const tmp = snapshotPath() + '.tmp'
                    await fsp.writeFile(tmp, body)
                    await fsp.rename(tmp, snapshotPath())
                    await fsp.writeFile(metaPath(), JSON.stringify(meta, null, 2))
                    // Vignettes produits/catégories : synchro en tâche de fond,
                    // jamais bloquante pour le snapshot lui-même.
                    setTimeout(() => { void syncImages(instanceBaseUrl) }, 100)
                    resolve(meta)
                })().catch(reject)
            })
            res.on('error', (err: Error) => { clearTimeout(timer); reject(err) })
        })
        req.on('error', (err) => { clearTimeout(timer); reject(err) })
        req.end()
    })
}

// ─── Cache des images produits / catégories ─────────────────────────────────
// Après chaque snapshot, on télécharge en tâche de fond les vignettes qui
// manquent localement ({id}.img). Un item sans photo reçoit un marqueur
// {id}.miss (pas de re-tentative pendant 24h : une photo ajoutée côté cloud
// finit donc par arriver). Concurrence limitée pour ne pas matraquer l'instance.

const IMG_CONCURRENCY = 4
const MISS_RETRY_MS = 24 * 60 * 60 * 1000
const IMG_TIMEOUT_MS = 15_000

function imgPath(kind: 'products' | 'categories', id: number): string {
    return path.join(imagesDir(kind), `${id}.img`)
}

function missPath(kind: 'products' | 'categories', id: number): string {
    return path.join(imagesDir(kind), `${id}.miss`)
}

/** true si l'item doit être (re)téléchargé. */
function imageNeeded(kind: 'products' | 'categories', id: number): boolean {
    if (fs.existsSync(imgPath(kind, id))) return false
    try {
        const st = fs.statSync(missPath(kind, id))
        return Date.now() - st.mtimeMs > MISS_RETRY_MS
    } catch { return true }
}

type ImageResult = { status: 'ok' } | { status: 'none' } | { status: 'error'; detail: string }

/**
 * Télécharge une vignette. « Sans photo » n'est retenu QUE sur une 404 JSON
 * émise par offline_image.php : une 404 HTML (endpoint pas déployé, URL fausse)
 * est une erreur, sinon on polluerait le cache de marqueurs .miss à tort.
 */
function downloadImage(baseUrl: string, kind: 'products' | 'categories', id: number): Promise<ImageResult> {
    const type = kind === 'products' ? 'product' : 'category'
    const url = `${baseUrl.replace(/\/$/, '')}/custom/cieloopos/api/offline_image.php?type=${type}&id=${id}`
    return new Promise((resolve) => {
        const req = net.request({ method: 'GET', url, useSessionCookies: true })
        const timer = setTimeout(() => { req.abort(); resolve({ status: 'error', detail: `timeout ${IMG_TIMEOUT_MS / 1000}s` }) }, IMG_TIMEOUT_MS)
        req.on('response', (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                clearTimeout(timer)
                void (async () => {
                    const ct = String(res.headers['content-type'] ?? '')
                    if (res.statusCode === 404 && ct.includes('application/json')) {
                        await fsp.writeFile(missPath(kind, id), '')
                        resolve({ status: 'none' })
                        return
                    }
                    if (res.statusCode !== 200 || !ct.startsWith('image/')) {
                        const body = Buffer.concat(chunks).toString('utf-8').slice(0, 120)
                        resolve({ status: 'error', detail: `HTTP ${res.statusCode} (${ct || 'sans content-type'}) : ${body}` })
                        return
                    }
                    const tmp = imgPath(kind, id) + '.tmp'
                    await fsp.writeFile(tmp, Buffer.concat(chunks))
                    await fsp.rename(tmp, imgPath(kind, id))
                    resolve({ status: 'ok' })
                })().catch((e: Error) => resolve({ status: 'error', detail: e.message }))
            })
            res.on('error', (e: Error) => { clearTimeout(timer); resolve({ status: 'error', detail: e.message }) })
        })
        req.on('error', (e) => { clearTimeout(timer); resolve({ status: 'error', detail: e.message }) })
        req.end()
    })
}

export interface ImageSyncReport {
    checked: number
    downloaded: number
    withoutPhoto: number
    errors: number
    firstError: string | null
    alreadyCached: number
}

/**
 * Synchronise les vignettes des produits/catégories du snapshot courant.
 * Si une synchro est déjà en cours (déclenchée en arrière-plan après un
 * snapshot), on la REJOINT au lieu de rendre un rapport vide — l'action
 * manuelle du menu rapporte ainsi toujours des chiffres réels.
 */
let currentImageSync: Promise<ImageSyncReport> | null = null

export type ImageSyncProgress = (done: number, total: number) => void

export function syncImages(baseUrl: string, onProgress?: ImageSyncProgress): Promise<ImageSyncReport> {
    if (currentImageSync) return currentImageSync
    currentImageSync = doSyncImages(baseUrl, onProgress).finally(() => { currentImageSync = null })
    return currentImageSync
}

async function doSyncImages(baseUrl: string, onProgress?: ImageSyncProgress): Promise<ImageSyncReport> {
    const report: ImageSyncReport = { checked: 0, downloaded: 0, withoutPhoto: 0, errors: 0, firstError: null, alreadyCached: 0 }
    try {
        const raw = readSnapshotRaw()
        if (raw === null) { report.firstError = 'Aucun snapshot téléchargé.'; return report }
        let snap: { products?: Array<{ id: number }>; categories?: Array<{ id: number }> }
        try { snap = JSON.parse(raw) as typeof snap } catch { report.firstError = 'Snapshot illisible.'; return report }

        await fsp.mkdir(imagesDir('products'), { recursive: true })
        await fsp.mkdir(imagesDir('categories'), { recursive: true })

        const jobs: Array<{ kind: 'products' | 'categories'; id: number }> = []
        const consider = (kind: 'products' | 'categories', id: number): void => {
            if (imageNeeded(kind, id)) jobs.push({ kind, id })
            else if (fs.existsSync(imgPath(kind, id))) report.alreadyCached++
        }
        for (const p of snap.products ?? []) consider('products', p.id)
        for (const c of snap.categories ?? []) consider('categories', c.id)
        report.checked = jobs.length
        if (jobs.length === 0) return report

        let cursor = 0
        let done = 0
        onProgress?.(0, jobs.length)
        const worker = async (): Promise<void> => {
            while (cursor < jobs.length) {
                const job = jobs[cursor++]
                const res = await downloadImage(baseUrl, job.kind, job.id)
                if (res.status === 'ok') report.downloaded++
                else if (res.status === 'none') report.withoutPhoto++
                else {
                    report.errors++
                    if (!report.firstError) report.firstError = `${job.kind}/${job.id} → ${res.detail}`
                }
                done++
                onProgress?.(done, jobs.length)
            }
        }
        await Promise.all(Array.from({ length: Math.min(IMG_CONCURRENCY, jobs.length) }, () => worker()))
        console.log(`[offline-pos] images : ${report.downloaded} téléchargées, ${report.withoutPhoto} sans photo, `
            + `${report.errors} erreurs (${report.checked} vérifiées, ${report.alreadyCached} déjà en cache)`
            + (report.firstError ? ` — 1ère erreur : ${report.firstError}` : ''))
        return report
    } catch (err) {
        report.firstError = report.firstError ?? (err as Error).message
        return report
    }
}

/** Efface les marqueurs « sans photo » : tout sera re-vérifié à la prochaine synchro. */
export function clearMissMarkers(): void {
    for (const kind of ['products', 'categories'] as const) {
        try {
            for (const f of fs.readdirSync(imagesDir(kind))) {
                if (f.endsWith('.miss')) fs.unlinkSync(path.join(imagesDir(kind), f))
            }
        } catch { /* dossier absent */ }
    }
}

/** Map id → URL file:// des vignettes disponibles localement (pour la SPA). */
function listLocalImages(): { products: Record<string, string>; categories: Record<string, string> } {
    const scan = (kind: 'products' | 'categories'): Record<string, string> => {
        const map: Record<string, string> = {}
        try {
            for (const f of fs.readdirSync(imagesDir(kind))) {
                if (!f.endsWith('.img')) continue
                map[f.slice(0, -4)] = pathToFileURL(path.join(imagesDir(kind), f)).href
            }
        } catch { /* dossier absent : aucune image */ }
        return map
    }
    return { products: scan('products'), categories: scan('categories') }
}

// ─── Rafraîchissement automatique ───────────────────────────────────────────

let refreshTimer: NodeJS.Timeout | null = null

/**
 * Rafraîchit le snapshot en tâche de fond tant que la caisse est en ligne.
 * `getBaseUrl` renvoie null pour suspendre (pas d'instance, ou déjà en mode
 * hors-ligne). Les échecs sont silencieux : le snapshot précédent reste valable.
 */
export function startSnapshotAutoRefresh(getBaseUrl: () => string | null): void {
    stopSnapshotAutoRefresh()
    const tick = async (): Promise<void> => {
        const base = getBaseUrl()
        if (!base) return
        try {
            const meta = await fetchSnapshot(base)
            console.log(`[offline-pos] snapshot rafraîchi : ${meta.products} produits, ${meta.customers} clients (${Math.round(meta.bytes / 1024)} ko)`)
        } catch (err) {
            console.warn('[offline-pos] rafraîchissement snapshot échoué :', (err as Error).message)
        }
    }
    setTimeout(() => { void tick() }, FIRST_REFRESH_DELAY_MS)
    refreshTimer = setInterval(() => { void tick() }, AUTO_REFRESH_MS)
}

export function stopSnapshotAutoRefresh(): void {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

// ─── Outbox des ventes hors-ligne ───────────────────────────────────────────
// Un fichier JSON par vente (00001-<uuid>.json) : append-only, écriture
// atomique, aucune structure à migrer. Le rejeu vers le cloud viendra lire ce
// dossier et marquera/déplacera les ventes importées.

interface OfflineSaleDoc {
    uuid?: string
    ref?: string
    [k: string]: unknown
}

function listOutboxFiles(): string[] {
    try {
        return fs.readdirSync(outboxDir())
            .filter((f) => f.endsWith('.json'))
            .sort() // préfixe séquentiel zero-padded → tri chronologique
    } catch { return [] }
}

/** Enregistre une vente et lui attribue sa réf provisoire OFF-XXXX. */
async function saveOfflineSale(sale: OfflineSaleDoc): Promise<string> {
    if (!sale || typeof sale !== 'object' || !Array.isArray(sale.lines) || sale.lines.length === 0) {
        throw new Error('Document de vente invalide.')
    }
    await fsp.mkdir(outboxDir(), { recursive: true })
    const seq = listOutboxFiles().length + 1
    const ref = `OFF-${String(seq).padStart(4, '0')}`
    const uuid = typeof sale.uuid === 'string' && sale.uuid !== '' ? sale.uuid : crypto.randomUUID()
    const doc = { ...sale, uuid, ref }
    const file = path.join(outboxDir(), `${String(seq).padStart(5, '0')}-${uuid}.json`)
    const tmp = file + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(doc, null, 2))
    await fsp.rename(tmp, file)
    return ref
}

function readOfflineSales(): OfflineSaleDoc[] {
    const sales: OfflineSaleDoc[] = []
    for (const f of listOutboxFiles()) {
        try { sales.push(JSON.parse(fs.readFileSync(path.join(outboxDir(), f), 'utf-8')) as OfflineSaleDoc) }
        catch { /* fichier corrompu : ignoré, jamais bloquant pour la caisse */ }
    }
    return sales.reverse() // la plus récente d'abord
}

function findOutboxFileByUuid(uuid: string): string | null {
    for (const f of listOutboxFiles()) {
        if (f.includes(uuid)) return path.join(outboxDir(), f)
    }
    return null
}

// ─── Synchro des ventes vers le cloud (rejeu) ────────────────────────────────
// POST vers offline_import_sale.php, idempotent par uuid côté serveur. Sur
// succès, le fichier local est marqué synced+real_ref (jamais supprimé : il
// reste consultable/réimprimable dans l'historique local).

interface ImportSaleResult { ok: boolean; ref?: string; facture_id?: number; error?: string }

function postJson(url: string, body: unknown, timeoutMs: number): Promise<{ status: number; json: unknown }> {
    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'POST', url, useSessionCookies: true })
        req.setHeader('Content-Type', 'application/json')
        const timer = setTimeout(() => { req.abort(); reject(new Error(`Timeout (${timeoutMs / 1000}s)`)) }, timeoutMs)
        req.on('response', (res) => {
            const chunks: Buffer[] = []
            res.on('data', (c: Buffer) => chunks.push(c))
            res.on('end', () => {
                clearTimeout(timer)
                const raw = Buffer.concat(chunks).toString('utf-8')
                try { resolve({ status: res.statusCode, json: JSON.parse(raw) }) }
                catch { reject(new Error(`Réponse invalide (session POS expirée ou module absent) : ${raw.slice(0, 150)}`)) }
            })
            res.on('error', (err: Error) => { clearTimeout(timer); reject(err) })
        })
        req.on('error', (err) => { clearTimeout(timer); reject(err) })
        req.write(JSON.stringify(body))
        req.end()
    })
}

/** Envoie UNE vente au cloud. Idempotent : rejouer une vente déjà synced la renvoie telle quelle. */
export async function syncSaleToCloud(baseUrl: string, uuid: string): Promise<ImportSaleResult> {
    const file = findOutboxFileByUuid(uuid)
    if (!file) return { ok: false, error: 'Vente introuvable en local.' }
    let doc: OfflineSaleDoc
    try { doc = JSON.parse(fs.readFileSync(file, 'utf-8')) as OfflineSaleDoc }
    catch { return { ok: false, error: 'Fichier de vente illisible.' } }

    if (doc.synced === true) {
        return { ok: true, ref: doc.real_ref as string | undefined, facture_id: doc.facture_id as number | undefined }
    }

    const url = `${baseUrl.replace(/\/$/, '')}/custom/cieloopos/api/offline_import_sale.php`
    try {
        const { status, json } = await postJson(url, doc, 25_000)
        const result = json as { ok?: boolean; ref?: string; facture_id?: number; error?: string }
        if (status !== 200 || !result.ok) {
            return { ok: false, error: result.error ?? `HTTP ${status}` }
        }
        const updated: OfflineSaleDoc = { ...doc, synced: true, real_ref: result.ref, facture_id: result.facture_id }
        const tmp = file + '.tmp'
        await fsp.writeFile(tmp, JSON.stringify(updated, null, 2))
        await fsp.rename(tmp, file)
        return { ok: true, ref: result.ref, facture_id: result.facture_id }
    } catch (err) {
        return { ok: false, error: (err as Error).message }
    }
}

export interface BulkSyncReport {
    total: number
    synced: number
    failed: number
    firstError: string | null
}

export type BulkSyncProgress = (done: number, total: number) => void

/** Synchronise toutes les ventes locales pas encore transmises, dans l'ordre chronologique. */
export async function syncAllPendingSales(baseUrl: string, onProgress?: BulkSyncProgress): Promise<BulkSyncReport> {
    const pending = readOfflineSales().reverse().filter((s) => s.synced !== true && typeof s.uuid === 'string')
    const report: BulkSyncReport = { total: pending.length, synced: 0, failed: 0, firstError: null }
    onProgress?.(0, pending.length)
    for (let i = 0; i < pending.length; i++) {
        const res = await syncSaleToCloud(baseUrl, pending[i].uuid as string)
        if (res.ok) report.synced++
        else {
            report.failed++
            if (!report.firstError) report.firstError = `${pending[i].ref ?? pending[i].uuid} → ${res.error}`
        }
        onProgress?.(i + 1, pending.length)
    }
    return report
}

// ─── Clients créés hors-ligne ───────────────────────────────────────────────
// Un client créé pendant une coupure vit dans customers.json (id négatif local)
// jusqu'à ce que le rejeu le crée côté Dolibarr. Il est proposé dans la
// recherche client au même titre que ceux du snapshot.

interface LocalCustomerDoc {
    id: number
    name: string
    phone: string | null
    email: string | null
    created_at: string
    local: true
}

function customersPath(): string { return path.join(snapshotDir(), 'local-customers.json') }

function readLocalCustomers(): LocalCustomerDoc[] {
    try { return JSON.parse(fs.readFileSync(customersPath(), 'utf-8')) as LocalCustomerDoc[] } catch { return [] }
}

async function saveLocalCustomer(input: { name?: unknown; phone?: unknown; email?: unknown }): Promise<LocalCustomerDoc> {
    const name = String(input.name ?? '').trim()
    if (name === '') throw new Error('Le nom du client est obligatoire.')
    const phone = String(input.phone ?? '').trim()
    const email = String(input.email ?? '').trim()
    const customers = readLocalCustomers()
    const customer: LocalCustomerDoc = {
        // id négatif : impossible de collisionner avec un rowid Dolibarr
        id: -Date.now(),
        name,
        phone: phone !== '' ? phone : null,
        email: email !== '' ? email : null,
        created_at: new Date().toISOString(),
        local: true,
    }
    customers.push(customer)
    await fsp.mkdir(snapshotDir(), { recursive: true })
    const tmp = customersPath() + '.tmp'
    await fsp.writeFile(tmp, JSON.stringify(customers, null, 2))
    await fsp.rename(tmp, customersPath())
    return customer
}

// ─── IPC (consommé par la SPA via le preload) ───────────────────────────────

export interface OfflinePosIpcDeps {
    returnOnline: () => Promise<void> | void
    refreshBaseUrl: () => string | null
    /** Horodatage (ms) de la bascule hors-ligne, null si inconnu. */
    getOfflineSince: () => number | null
}

export function registerOfflinePosIpc(deps: OfflinePosIpcDeps): void {
    // Le snapshot est renvoyé déjà parsé ; null si aucun n'a jamais été téléchargé.
    ipcMain.handle('offline-pos:get-snapshot', () => {
        const raw = readSnapshotRaw()
        if (raw === null) return null
        try { return JSON.parse(raw) as unknown } catch { return null }
    })

    ipcMain.handle('offline-pos:get-meta', () => readSnapshotMeta())

    // Contexte machine : nom du terminal configuré (affiché en haut à gauche
    // comme sur la caisse en ligne) + horodatage de la bascule hors-ligne.
    ipcMain.handle('offline-pos:get-context', () => {
        const s = loadSettings()
        return {
            terminalName: s.terminalName?.trim() || null,
            offlineSince: deps.getOfflineSince(),
        }
    })

    // Vignettes disponibles localement (id → URL file://).
    ipcMain.handle('offline-pos:get-images', () => listLocalImages())

    ipcMain.handle('offline-pos:return-online', async () => { await deps.returnOnline() })

    // Vente hors-ligne : persistée sur disque AVANT que la SPA n'affiche le succès.
    ipcMain.handle('offline-pos:save-sale', async (_e, sale: OfflineSaleDoc) => {
        try {
            const ref = await saveOfflineSale(sale)
            return { ok: true, ref }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
    })

    ipcMain.handle('offline-pos:list-sales', () => readOfflineSales())

    // Bouton « Téléverser » d'un ticket dans la liste des ventes locales.
    ipcMain.handle('offline-pos:sync-sale', async (_e, uuid: string) => {
        const base = deps.refreshBaseUrl()
        if (!base) return { ok: false, error: 'Aucune instance Cieloo configurée.' }
        return syncSaleToCloud(base, uuid)
    })

    ipcMain.handle('offline-pos:save-customer', async (_e, input: { name?: unknown; phone?: unknown; email?: unknown }) => {
        try {
            const customer = await saveLocalCustomer(input ?? {})
            return { ok: true, customer }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
    })

    ipcMain.handle('offline-pos:list-customers', () => readLocalCustomers())

    // Ticket de caisse : HTML autonome rendu par la SPA (mêmes blocs que le
    // Ticket Designer), imprimé en silencieux via le print-server.
    ipcMain.handle('offline-pos:print-receipt', async (_e, html: string) => {
        try {
            if (typeof html !== 'string' || html.length === 0) throw new Error('Ticket vide.')
            await printHtmlReceipt(html)
            return { ok: true }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
    })

    // Tentative de rafraîchissement manuel (bouton dans la SPA quand le réseau revient).
    ipcMain.handle('offline-pos:refresh-snapshot', async () => {
        const base = deps.refreshBaseUrl()
        if (!base) return { ok: false, error: 'Aucune instance configurée.' }
        try {
            const meta = await fetchSnapshot(base)
            return { ok: true, meta }
        } catch (err) {
            return { ok: false, error: (err as Error).message }
        }
    })
}
