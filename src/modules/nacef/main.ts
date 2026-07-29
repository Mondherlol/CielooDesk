// ─── Mode NACEF (fiscalisation tunisienne S-MDF) ───────────────────────────────
//
// Deux responsabilités, activées par le toggle « mode NACEF » des paramètres :
//
//  1. ROUTES FISCALES — ajoute des routes statiques /32 vers les serveurs fiscaux,
//     via une passerelle dédiée (ex. `route -p add 196.203.237.115 mask
//     255.255.255.255 192.168.1.253`). Ces serveurs ne sont joignables qu'à travers
//     ce next-hop, pas par la passerelle Internet par défaut. `-p` = persistant
//     (survit au reboot) → l'élévation UAC n'a lieu qu'UNE fois, et seulement si une
//     route manque réellement (la lecture de la table de routage, elle, ne demande
//     aucun droit).
//
//  2. PROXY CORS LOCAL — réimplémente en natif Node le relais que faisait le script
//     `smdf-cors-proxy.ps1` : navigateur → 127.0.0.1:proxyPort → boîtier S-MDF
//     (localhost:10006), en rajoutant les en-têtes CORS. Avantages sur le .ps1 :
//     serveur async non-bloquant (plus de sérialisation mono-thread pendant le popup
//     PIN+OTP), aucun admin ni urlacl (bind direct sur le socket loopback, hors
//     HTTP.sys), aucune fenêtre console, cycle de vie géré par l'app.

import { app, ipcMain } from 'electron'
import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { loadSettings, updateSettings, normalizeNacef, type NacefSettings } from '../settings/main'

const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

// On ne transmet au boîtier QUE ces en-têtes : il peut rejeter (401) une requête
// qu'il identifie comme venant d'un navigateur (Origin, Referer, Cookie, Sec-Fetch-*…).
const FORWARD_HEADERS = ['accept', 'content-type', 'authorization'] as const

// Le popup S-MDF (PIN + OTP) peut retenir la réponse plusieurs minutes lors d'une sync.
const PROXY_TIMEOUT_MS = 310_000

// ─── Proxy CORS ────────────────────────────────────────────────────────────────

let server: http.Server | null = null
let serverPort = 0

export function isNacefProxyRunning(): boolean {
    return server !== null && server.listening
}

export function startNacefProxy(cfg?: NacefSettings): void {
    const nacef = cfg ?? loadSettings().nacef

    // Déjà en écoute sur le bon port → rien à faire ; sinon on redémarre proprement.
    if (server) {
        if (serverPort === nacef.proxyPort && server.listening) return
        stopNacefProxy()
    }

    const target = nacef.proxyTarget.replace(/\/+$/, '')
    let targetUrl: URL
    try { targetUrl = new URL(target) } catch { return }
    const isHttps = targetUrl.protocol === 'https:'
    const agentMod = isHttps ? https : http
    const targetPort = targetUrl.port || (isHttps ? '443' : '80')

    const srv = http.createServer((req, res) => {
        // En-têtes CORS sur TOUTES les réponses.
        res.setHeader('Access-Control-Allow-Origin', nacef.origin)
        res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, PATCH, OPTIONS')
        const ask = req.headers['access-control-request-headers']
        res.setHeader('Access-Control-Allow-Headers', typeof ask === 'string' && ask ? ask : 'Content-Type, Authorization')
        res.setHeader('Access-Control-Max-Age', '600')

        // Préflight : réponse immédiate.
        if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return }

        // Recopie UNIQUEMENT des en-têtes utiles : la requête doit arriver au boîtier
        // comme un appel serveur, sans marqueur navigateur.
        const headers: Record<string, string> = {}
        for (const h of FORWARD_HEADERS) {
            const v = req.headers[h]
            if (typeof v === 'string') headers[h] = v
        }

        const proxyReq = agentMod.request({
            protocol: targetUrl.protocol,
            hostname: targetUrl.hostname,
            port: targetPort,
            method: req.method,
            path: req.url,
            headers,
        }, (proxyRes) => {
            res.statusCode = proxyRes.statusCode ?? 502
            const ct = proxyRes.headers['content-type']
            if (ct) res.setHeader('Content-Type', ct)
            proxyRes.pipe(res)
        })

        proxyReq.setTimeout(PROXY_TIMEOUT_MS, () => { proxyReq.destroy(new Error('timeout')) })
        proxyReq.on('error', (err) => {
            if (res.headersSent) { res.destroy(); return }
            res.statusCode = 502
            res.end(`Proxy S-MDF error: ${err.message}`)
        })

        req.pipe(proxyReq)
    })

    srv.on('error', (err) => {
        console.error(`[nacef] proxy listen error on :${nacef.proxyPort} —`, err.message)
        if (server === srv) { server = null; serverPort = 0 }
    })

    // Bind sur toutes les interfaces (0.0.0.0) : reste joignable en loopback
    // (127.0.0.1) comme avant, mais aussi depuis les autres machines du LAN — c'est
    // ce qui permet à un poste « hub » de relayer NACEF pour les autres (cf. doc
    // module). Toujours sans urlacl / admin requis, contrairement à HttpListener
    // (HTTP.sys) qu'utilisait le .ps1. Windows Firewall bloque par défaut les
    // connexions entrantes tant qu'une règle n'autorise pas explicitement le port
    // (profil Privé recommandé).
    srv.listen(nacef.proxyPort, '0.0.0.0', () => {
        console.log(`[nacef] proxy CORS actif : http://0.0.0.0:${nacef.proxyPort} -> ${target}`)
    })

    server = srv
    serverPort = nacef.proxyPort
}

export function stopNacefProxy(): void {
    if (!server) return
    try { server.close() } catch { /* déjà fermé */ }
    server = null
    serverPort = 0
}

// ─── Routes fiscales ───────────────────────────────────────────────────────────

export interface NacefRouteResult {
    ok: boolean
    added: string[]
    alreadyPresent: string[]
    error?: string
    /** true si non applicable (hors Windows) — traité comme un succès no-op. */
    skipped?: boolean
}

/** Table de routage IPv4 (lecture seule, aucun droit admin requis). */
function routeTableText(): Promise<string> {
    return new Promise((resolve) => {
        execFile('route', ['print', '-4'], { windowsHide: true }, (err, stdout) => {
            resolve(err ? '' : stdout)
        })
    })
}

/** Parmi `destinations`, celles dont la route /32 → `gateway` n'existe pas encore. */
async function computeMissingRoutes(destinations: string[], gateway: string): Promise<string[]> {
    const table = await routeTableText()
    const esc = (ip: string) => ip.replace(/\./g, '\\.')
    return destinations.filter((dest) => {
        // Ligne du type : "196.203.237.115  255.255.255.255   192.168.1.253  <iface>  <metric>"
        const re = new RegExp(`^\\s*${esc(dest)}\\s+255\\.255\\.255\\.255\\s+${esc(gateway)}\\b`, 'm')
        return !re.test(table)
    })
}

/** Destinations manquantes pour la config NACEF courante (0 si tout est en place). */
export async function getMissingNacefRoutes(cfg?: NacefSettings): Promise<string[]> {
    if (process.platform !== 'win32') return []
    const nacef = cfg ?? loadSettings().nacef
    if (!IPV4_RE.test(nacef.gateway)) return []
    const destinations = nacef.destinations.filter((d) => IPV4_RE.test(d))
    if (destinations.length === 0) return []
    return computeMissingRoutes(destinations, nacef.gateway)
}

/**
 * Ajoute (persistant, `-p`) les routes fiscales manquantes. Une seule élévation UAC,
 * et UNIQUEMENT si au moins une route manque — sinon aucune interaction.
 */
export async function ensureNacefRoutes(cfg?: NacefSettings): Promise<NacefRouteResult> {
    if (process.platform !== 'win32') return { ok: true, added: [], alreadyPresent: [], skipped: true }

    const nacef = cfg ?? loadSettings().nacef
    const gateway = nacef.gateway
    const destinations = nacef.destinations.filter((d) => IPV4_RE.test(d))

    // Garde-fou : ces valeurs partent dans un PowerShell élevé → on refuse tout ce qui
    // n'est pas une IPv4 stricte (déjà filtré par normalizeNacef, mais on re-valide ici).
    if (!IPV4_RE.test(gateway) || destinations.length === 0) {
        return { ok: false, added: [], alreadyPresent: [], error: 'passerelle ou destinations invalides' }
    }

    const missing = await computeMissingRoutes(destinations, gateway)
    const alreadyPresent = destinations.filter((d) => !missing.includes(d))
    if (missing.length === 0) return { ok: true, added: [], alreadyPresent }

    // Un seul script élevé (une seule UAC) pour toutes les routes manquantes.
    const lines = missing.map((d) => `route -p add ${d} mask 255.255.255.255 ${gateway}`)
    const scriptPath = path.join(app.getPath('userData'), 'nacef-add-routes.ps1')
    try {
        fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n', 'utf-8')
    } catch (e) {
        return { ok: false, added: [], alreadyPresent, error: `écriture script: ${(e as Error).message}` }
    }

    const escapedScript = scriptPath.replace(/\\/g, '\\\\')
    const psCmd = `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NonInteractive -ExecutionPolicy Bypass -File "${escapedScript}"'`

    const elevated = await new Promise<boolean>((resolve) => {
        execFile('powershell.exe', ['-NonInteractive', '-Command', psCmd], { timeout: 60_000, windowsHide: true }, (err) => {
            resolve(!err)
        })
    })
    try { fs.unlinkSync(scriptPath) } catch { /* best-effort */ }

    if (!elevated) return { ok: false, added: [], alreadyPresent, error: 'élévation refusée ou échec du script' }

    // Vérifie que les routes sont bien présentes après coup.
    const stillMissing = await computeMissingRoutes(destinations, gateway)
    const added = missing.filter((d) => !stillMissing.includes(d))
    return {
        ok: stillMissing.length === 0,
        added,
        alreadyPresent,
        error: stillMissing.length ? `routes non ajoutées: ${stillMissing.join(', ')}` : undefined,
    }
}

// ─── Application de l'état NACEF ────────────────────────────────────────────────

/**
 * Applique l'état NACEF courant : proxy + routes si activé, arrêt sinon.
 * Les routes sont best-effort (ne bloquent jamais le proxy en cas d'échec/refus UAC).
 */
export async function applyNacef(cfg?: NacefSettings): Promise<void> {
    const nacef = cfg ?? loadSettings().nacef
    if (!nacef.enabled) { stopNacefProxy(); return }
    // Le proxy démarre tout de suite ; la réparation des routes se fait en tâche de fond.
    startNacefProxy(nacef)
    try { await ensureNacefRoutes(nacef) } catch (e) {
        console.error('[nacef] ensureNacefRoutes:', (e as Error).message)
    }
}

// ─── IPC ─────────────────────────────────────────────────────────────────────

export interface NacefStatus {
    enabled: boolean
    proxyRunning: boolean
    port: number
    target: string
    gateway: string
    destinations: string[]
    routesPresent: boolean
    missingRoutes: string[]
}

export function registerNacefIpc(): void {
    ipcMain.handle('nacef:get-config', () => loadSettings().nacef)

    ipcMain.handle('nacef:get-status', async (): Promise<NacefStatus> => {
        const nacef = loadSettings().nacef
        const missing = nacef.enabled ? await getMissingNacefRoutes(nacef) : []
        return {
            enabled: nacef.enabled,
            proxyRunning: isNacefProxyRunning(),
            port: nacef.proxyPort,
            target: nacef.proxyTarget,
            gateway: nacef.gateway,
            destinations: nacef.destinations,
            routesPresent: missing.length === 0,
            missingRoutes: missing,
        }
    })

    // Sauvegarde + application immédiate (démarre/arrête proxy, répare les routes si activé).
    ipcMain.handle('nacef:save-config', async (_e, payload: Partial<NacefSettings>): Promise<NacefSettings> => {
        const updated = updateSettings((current) => ({
            ...current,
            nacef: normalizeNacef({ ...current.nacef, ...payload }),
        }))
        await applyNacef(updated.nacef)
        return updated.nacef
    })
}
