// ─────────────────────────────────────────────────────────────────────────────
// Mode Balance — Dibal / profil LinéoSoft (via DFS + RGI).
//
// Reproduit ce que faisait Joolan : un service cloud génère la liste des produits
// pesés, l'agent local écrit un Articles.txt (TAB, Windows-1252, CRLF) dans le
// dossier surveillé par RGI, qui l'envoie à la balance puis l'efface.
//
//   produits  ←  GET cieloopos/api/balance_api.php  (réf = 5 chiffres, en vente)
//   fichier   →  <exportFolder>/Articles.txt
//
// Déclencheurs : au lancement, sur intervalle, sur webhook (trigger Dolibarr en
// mode caisse locale), et manuellement depuis la fenêtre-outil « Balance ».
// ─────────────────────────────────────────────────────────────────────────────

import { app, net, session, dialog, shell, ipcMain, BrowserWindow } from 'electron'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
    loadSettings,
    setBalanceSettings,
    type BalanceSettings,
} from '../settings/main'

// ─── Types ──────────────────────────────────────────────────────────────────

export interface BalanceProduct {
    code: string
    label: string
    price_ttc: number
    tva_tx: number
    type: number
}

interface BalanceApiResponse {
    generated_at: string
    signature: string
    count: number
    products: BalanceProduct[]
}

export interface BalanceGenResult {
    ok: boolean
    written: boolean
    skipped: boolean
    count: number
    filePath?: string
    generatedAt?: string
    error?: string
}

export interface BalancePreview {
    ok: boolean
    count: number
    products: BalanceProduct[]
    content: string
    error?: string
}

export interface BalanceDeps {
    resolveBase: () => string | null
    resolveOrigin: () => string | null
}

interface BalanceState {
    lastContentHash?: string
    lastSignature?: string
    lastWrittenAt?: string
    lastCount?: number
}

// ─── Formatage LinéoSoft ────────────────────────────────────────────────────

const COL_SEP = '\t'
const ROW_SEP = '\r\n'

/** Table de transcodage Windows-1252 pour les caractères Unicode > 0xFF (0x80–0x9F). */
const CP1252_HIGH: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85,
    0x2020: 0x86, 0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a,
    0x2039: 0x8b, 0x0152: 0x8c, 0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92,
    0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95, 0x2013: 0x96, 0x2014: 0x97,
    0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b, 0x0153: 0x9c,
    0x017e: 0x9e, 0x0178: 0x9f,
}

/** Encode une chaîne en Windows-1252 (caractères inconnus → '?'). */
function toCp1252Buffer(str: string): Buffer {
    const bytes = Buffer.alloc(str.length)
    let n = 0
    for (const ch of str) {
        const cp = ch.codePointAt(0) ?? 0x3f
        if (cp <= 0xff) bytes[n++] = cp
        else if (CP1252_HIGH[cp] !== undefined) bytes[n++] = CP1252_HIGH[cp]
        else bytes[n++] = 0x3f // '?'
    }
    return bytes.subarray(0, n)
}

/** Nettoie un libellé : pas de séparateur, espaces compactés, tronqué. */
function sanitizeName(label: string, maxLen: number): string {
    return label
        .replace(/[\t\r\n]+/g, ' ')
        .replace(/\s+/g, ' ')
        .trim()
        .slice(0, maxLen)
}

/** Prix décimal avec point, zéros de fin supprimés (ex. 33.837, 100, 45.5). */
function formatPrice(value: number, decimals: number): string {
    const v = Number.isFinite(value) ? value : 0
    const fixed = v.toFixed(decimals)
    return decimals > 0 ? fixed.replace(/\.?0+$/, '') : fixed
}

/** Taux TVA sans zéros superflus (ex. 5.5, 20, 7). */
function formatRate(value: number): string {
    if (!Number.isFinite(value)) return '0'
    return String(Number(value.toFixed(2)))
}

/** Cherche l'ID TVA balance correspondant au taux du produit. */
function lookupTvaId(tva: number, s: BalanceSettings): number {
    const hit = s.tvaMap.find((m) => Math.abs(m.taux - tva) < 0.001)
    return hit ? hit.id : s.defaultTvaId
}

/** Construit une ligne : Mode⇥Code⇥Désignation⇥Prix⇥IdTVA⇥Taux⇥Type⇥PLU */
function buildLine(p: BalanceProduct, s: BalanceSettings): string {
    const code = p.code
    const type = p.type === 1 || p.type === 2 ? p.type : s.defaultType
    return [
        'M',
        code,
        sanitizeName(p.label, s.nameMaxLength),
        formatPrice(p.price_ttc, s.priceDecimals),
        String(lookupTvaId(p.tva_tx, s)),
        formatRate(p.tva_tx),
        String(type),
        code.slice(-3),
    ].join(COL_SEP)
}

export function buildFileContent(products: BalanceProduct[], s: BalanceSettings): string {
    if (products.length === 0) return ''
    return products.map((p) => buildLine(p, s)).join(ROW_SEP) + ROW_SEP
}

// ─── Récupération des produits depuis Dolibarr ───────────────────────────────

let deps: BalanceDeps | null = null

async function cookieHeader(origin: string): Promise<string> {
    const cookies = await session.defaultSession.cookies.get({ url: origin })
    return cookies.map((c) => `${c.name}=${c.value}`).join('; ')
}

async function fetchProducts(): Promise<BalanceApiResponse> {
    if (!deps) throw new Error('Module balance non initialisé')
    const base = deps.resolveBase()
    const origin = deps.resolveOrigin()
    if (!base || !origin) throw new Error('Instance Dolibarr non détectée — ouvrez la caisse d\'abord')

    const s = loadSettings().balance
    const sep = s.apiKey ? `&api_key=${encodeURIComponent(s.apiKey)}` : ''
    const url = `${base}/custom/cieloopos/api/balance_api.php?type=${s.defaultType}${sep}`
    const header = await cookieHeader(origin)

    return new Promise((resolve, reject) => {
        const req = net.request({ method: 'GET', url })
        if (header) req.setHeader('Cookie', header)
        if (s.apiKey) req.setHeader('Authorization', `Bearer ${s.apiKey}`)
        let body = ''
        req.on('response', (res) => {
            res.on('data', (c) => { body += c.toString() })
            res.on('end', () => {
                if (res.statusCode !== 200) {
                    reject(new Error(`HTTP ${res.statusCode} — ${body.slice(0, 200)}`))
                    return
                }
                const trimmed = body.trimStart()
                // net.request a suivi un 302 → page de login HTML : session absente/expirée.
                if (trimmed.startsWith('<')) {
                    reject(new Error(s.apiKey
                        ? 'Token API refusé ou page de login renvoyée — vérifiez le token dans les réglages Balance'
                        : 'Session caisse non active — connectez-vous à la caisse, ou renseignez un token API dans les réglages Balance'))
                    return
                }
                try {
                    resolve(JSON.parse(body) as BalanceApiResponse)
                } catch {
                    reject(new Error(`Réponse non-JSON (${body.slice(0, 120)})`))
                }
            })
            res.on('error', reject)
        })
        req.on('error', reject)
        req.end()
    })
}

// ─── État persistant (détection « Pas de changement ») ───────────────────────

function statePath(): string {
    return path.join(app.getPath('userData'), 'balance-state.json')
}

function loadState(): BalanceState {
    try { return JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as BalanceState }
    catch { return {} }
}

function saveState(s: BalanceState): void {
    try { fs.writeFileSync(statePath(), JSON.stringify(s, null, 2)) } catch { /* best-effort */ }
}

export function getBalanceState(): BalanceState {
    return loadState()
}

// ─── Génération du fichier ───────────────────────────────────────────────────

let generating = false

export async function generateBalanceFile(opts: { force?: boolean } = {}): Promise<BalanceGenResult> {
    const s = loadSettings().balance
    if (!s.enabled) return { ok: false, written: false, skipped: true, count: 0, error: 'Mode balance désactivé' }
    if (!s.exportFolder) return { ok: false, written: false, skipped: false, count: 0, error: 'Dossier d\'export non configuré' }
    if (generating) return { ok: false, written: false, skipped: true, count: 0, error: 'Génération déjà en cours' }

    generating = true
    try {
        const data = await fetchProducts()
        const content = buildFileContent(data.products, s)
        const contentHash = createHash('md5').update(content).digest('hex')

        const state = loadState()
        if (!opts.force && state.lastContentHash === contentHash) {
            return { ok: true, written: false, skipped: true, count: data.count, generatedAt: data.generated_at }
        }

        await fs.promises.mkdir(s.exportFolder, { recursive: true })
        const filePath = path.join(s.exportFolder, s.fileName)
        await fs.promises.writeFile(filePath, toCp1252Buffer(content))

        saveState({
            lastContentHash: contentHash,
            lastSignature: data.signature,
            lastWrittenAt: new Date().toISOString(),
            lastCount: data.count,
        })
        return { ok: true, written: true, skipped: false, count: data.count, filePath, generatedAt: data.generated_at }
    } catch (e) {
        return { ok: false, written: false, skipped: false, count: 0, error: e instanceof Error ? e.message : String(e) }
    } finally {
        generating = false
    }
}

async function previewProducts(): Promise<BalancePreview> {
    const s = loadSettings().balance
    try {
        const data = await fetchProducts()
        return { ok: true, count: data.count, products: data.products, content: buildFileContent(data.products, s) }
    } catch (e) {
        return { ok: false, count: 0, products: [], content: '', error: e instanceof Error ? e.message : String(e) }
    }
}

/** Diffuse un résultat de génération vers les fenêtres ouvertes (mise à jour live). */
function broadcastStatus(result: BalanceGenResult): void {
    for (const win of BrowserWindow.getAllWindows()) {
        if (!win.isDestroyed()) win.webContents.send('balance:status-updated', result)
    }
}

// ─── Webhook loopback (déclenché par le trigger Dolibarr en mode local) ──────

let webhookServer: http.Server | null = null

function stopWebhook(): void {
    if (webhookServer) {
        try { webhookServer.close() } catch { /* ignore */ }
        webhookServer = null
    }
}

function startWebhook(port: number): void {
    stopWebhook()
    if (port <= 0) return
    const server = http.createServer((req, res) => {
        if (req.url && req.url.startsWith('/refresh')) {
            res.writeHead(200, { 'Content-Type': 'text/plain' })
            res.end('ok')
            void generateBalanceFile({ force: false }).then(broadcastStatus)
        } else {
            res.writeHead(404)
            res.end()
        }
    })
    server.on('error', () => { /* port occupé : on ignore */ })
    server.listen(port, '127.0.0.1')
    webhookServer = server
}

// ─── Rafraîchissement périodique ─────────────────────────────────────────────

let refreshTimer: ReturnType<typeof setInterval> | null = null

function stopInterval(): void {
    if (refreshTimer) { clearInterval(refreshTimer); refreshTimer = null }
}

function startInterval(min: number): void {
    stopInterval()
    if (min <= 0) return
    refreshTimer = setInterval(() => {
        void generateBalanceFile({ force: false }).then(broadcastStatus)
    }, min * 60_000)
}

/** (Re)applique les services de fond selon les réglages courants. */
function applyRuntime(): void {
    const s = loadSettings().balance
    if (s.enabled) {
        startWebhook(s.webhookPort)
        startInterval(s.refreshIntervalMin)
    } else {
        stopWebhook()
        stopInterval()
    }
}

// ─── Cycle de vie + IPC ──────────────────────────────────────────────────────

export function startBalance(d: BalanceDeps): void {
    deps = d
    applyRuntime()
    // Tentative initiale différée (le temps que la session caisse soit prête).
    setTimeout(() => {
        if (loadSettings().balance.enabled) {
            void generateBalanceFile({ force: false }).then(broadcastStatus)
        }
    }, 25_000)
}

export function stopBalance(): void {
    stopWebhook()
    stopInterval()
}

// ─── Gestion des applis DFS/Dibal (RGI envoie Articles.txt, DGI/DFS = config) ─

/** Applis de la suite DFS lançables depuis le menu Balance. */
export type DfsApp = 'RGI' | 'DGI' | 'DFS'

const DFS_BASE_DIRS = [
    'C:\\Program Files (x86)\\DFS',
    'C:\\Program Files\\DFS',
]

function dfsAppCandidates(appName: DfsApp): string[] {
    return DFS_BASE_DIRS.map((dir) => `${dir}\\${appName}\\${appName}.exe`)
}

/** Chemin de l'exe : pour RGI on respecte le chemin configuré ; sinon auto-détection. */
export function resolveDfsAppPath(appName: DfsApp): string | null {
    if (appName === 'RGI') {
        const configured = loadSettings().balance.rgiPath
        if (configured && fs.existsSync(configured)) return configured
    }
    return dfsAppCandidates(appName).find((p) => fs.existsSync(p)) ?? null
}

/** Un process est-il en cours ? (via tasklist Windows) */
function isProcessRunning(exeName: string): Promise<boolean> {
    return new Promise((resolve) => {
        execFile('tasklist', ['/FI', `IMAGENAME eq ${exeName}`, '/NH'], { windowsHide: true }, (err, stdout) => {
            resolve(!err && stdout.toLowerCase().includes(exeName.toLowerCase()))
        })
    })
}

export function isRgiRunning(): Promise<boolean> {
    return isProcessRunning('RGI.exe')
}

export interface DfsLaunchResult {
    status: 'launched' | 'already' | 'not_found' | 'error'
    path?: string
    error?: string
}

/** Lance une appli DFS via ShellExecute (shell.openPath) — pas d'EACCES. */
export async function launchDfsApp(appName: DfsApp): Promise<DfsLaunchResult> {
    if (await isProcessRunning(`${appName}.exe`)) return { status: 'already' }
    const exe = resolveDfsAppPath(appName)
    if (!exe) return { status: 'not_found' }
    const err = await shell.openPath(exe)
    if (err) return { status: 'error', error: err, path: exe }
    return { status: 'launched', path: exe }
}

/** Demande à l'utilisateur de localiser RGI.exe et mémorise le chemin. */
export async function selectRgiPath(): Promise<string | null> {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const options = {
        title: 'Localiser RGI.exe',
        properties: ['openFile'],
        filters: [{ name: 'RGI', extensions: ['exe'] }],
        defaultPath: loadSettings().balance.rgiPath || 'C:\\Program Files (x86)\\DFS\\RGI',
        buttonLabel: 'Sélectionner',
    } satisfies Electron.OpenDialogOptions
    const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null
    const exe = result.filePaths[0]
    setBalanceSettings({ rgiPath: exe })
    return exe
}

async function selectExportFolder(): Promise<string | null> {
    const parent = BrowserWindow.getFocusedWindow() ?? undefined
    const current = loadSettings().balance.exportFolder ?? undefined
    const options = {
        title: 'Sélectionner le dossier surveillé par RGI (ex. C:\\Joolan\\Balance\\plu)',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: current,
        buttonLabel: 'Sélectionner ce dossier',
    } satisfies Electron.OpenDialogOptions

    const result = parent
        ? await dialog.showOpenDialog(parent, options)
        : await dialog.showOpenDialog(options)
    if (result.canceled || result.filePaths.length === 0) return null

    const folder = result.filePaths[0]
    setBalanceSettings({ exportFolder: folder })
    return folder
}

/**
 * @param onEnabledChange  appelé quand le toggle « activé » bascule (pour
 *                         reconstruire le menu natif où apparaît l'onglet Balance).
 */
export function registerBalanceIpc(onEnabledChange: () => void): void {
    ipcMain.handle('balance:get-config', () => loadSettings().balance)

    ipcMain.handle('balance:save-config', (_e, payload: Partial<BalanceSettings>) => {
        const wasEnabled = loadSettings().balance.enabled
        const updated = setBalanceSettings(payload)
        applyRuntime()
        if (updated.balance.enabled !== wasEnabled) onEnabledChange()
        return updated.balance
    })

    ipcMain.handle('balance:select-folder', () => selectExportFolder())

    ipcMain.handle('balance:generate-now', async () => {
        const result = await generateBalanceFile({ force: true })
        broadcastStatus(result)
        return result
    })

    ipcMain.handle('balance:preview', () => previewProducts())

    ipcMain.handle('balance:get-status', () => loadState())
}
