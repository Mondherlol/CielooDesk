import { app, BrowserWindow, ipcMain, Menu, globalShortcut, net, dialog, shell, clipboard, screen, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import { spawn, exec } from 'node:child_process'
import { start as startLocalMediaServer, stop as stopLocalMediaServer } from '../modules/local-media-server/main'

import { registerAutoLoginIpc } from '../modules/auto-login/main'
import {
    registerSettingsIpc, applyBootSettings, openSettingsWindow,
    loadSettings, onRebuildMenu, setPrintSettings, updateSettings, getNetworkInfo, type PrintSettings
} from '../modules/settings/main'
import {
    applyPrintSettings,
    getPrintServerStatus,
    getSystemPrinters,
    startPrintServer,
    stopPrintServer,
    printTestPage,
    printBarcodeTestPage,
    type BarcodeTestMode,
} from '../modules/print-server/main'
import { startSecondScreen, syncSecondScreen, stopSecondScreen } from '../modules/second-screen/main'
import { initAutoUpdater, registerUpdaterIpc } from '../modules/updater/main'
import { registerCustomerDisplayIpc, pushIdleText } from '../modules/customer-display/main'
import {
    registerBalanceIpc, startBalance, stopBalance, generateBalanceFile,
    launchDfsApp, isRgiRunning, selectRgiPath, type DfsApp,
} from '../modules/balance/main'
import {
    registerNacefIpc, startNacefProxy, stopNacefProxy, ensureNacefRoutes,
} from '../modules/nacef/main'
import {
    ensurePack as ensureLocalPack,
    startLocal as startLocalDolibarr,
    stopLocal as stopLocalDolibarr,
    uninstallLocal as uninstallLocalDolibarr,
    resetLocalConfig as resetLocalConfigDolibarr,
    isPackPresent as isLocalPackPresent,
    getLocalStatus,
    getLocalBaseUrl,
    getLocalFolders,
    getLocalDebugInfo,
    getDbAdminUrl,
    getSyncState,
} from '../modules/local-dolibarr/main'
import {
    runCloudSync,
    fetchLatestPack,
    seedLocalFromCloud,
    syncSiteFilesFromCloud,
    fetchSyncInfo,
    isVersionCompatible,
    EXPECTED_DOLIBARR_LABEL,
    type SyncDeps,
} from '../modules/cloud-sync/main'
import {
    fetchSnapshot as fetchOfflineSnapshot,
    hasSnapshot as hasOfflineSnapshot,
    readSnapshotMeta as readOfflineSnapshotMeta,
    offlinePosIndexHtml,
    isOfflinePosBundlePresent,
    registerOfflinePosIpc,
    startSnapshotAutoRefresh,
    syncImages as syncOfflineImages,
    clearMissMarkers as clearOfflineImageMissMarkers,
    syncAllPendingSales as syncAllOfflinePendingSales,
} from '../modules/offline-pos/main'
import { startSessionCookiePersistence } from '../modules/session-persist/main'

const isDev = !app.isPackaged

// ─── Données partagées entre comptes Windows (machine-wide) ────────────────────
//
// PROBLÈME : app.getPath('userData') = %APPDATA%\CielooPosv2, PROPRE À CHAQUE compte
// Windows. Un poste configuré sous le compte admin (config.json, réglages, caisse
// locale) devenait « vierge » vu par un compte caissier non-admin → l'écran de
// config d'instance réapparaissait à chaque connexion sous un autre compte.
//
// SOLUTION : rediriger userData vers C:\ProgramData\CielooPosv2, commun à TOUS les
// comptes. L'installeur (perMachine) crée ce dossier et accorde aux Utilisateurs le
// droit de modification (cf. build/installer.nsh). Migration one-shot depuis
// l'ancien emplacement par-utilisateur pour ne pas reperdre une config existante.
//
// Doit s'exécuter AVANT tout accès à un chemin userData (donc ici, tout en haut).
const SHARED_DATA_FOLDER = 'CielooPosv2'

function useSharedUserData(): void {
    if (process.platform !== 'win32') return
    // En dev on reste sur %APPDATA% (aucun installeur pour poser l'ACL ProgramData).
    // CIELOO_SHARED_DATA=1 force le comportement partagé pour tester la migration.
    if (!app.isPackaged && process.env.CIELOO_SHARED_DATA !== '1') return
    const programData = process.env.ProgramData ?? process.env.ALLUSERSPROFILE
    if (!programData) return

    const perUser = app.getPath('userData')                   // %APPDATA%\CielooPosv2
    const shared = path.join(programData, SHARED_DATA_FOLDER)  // C:\ProgramData\CielooPosv2

    try { fs.mkdirSync(shared, { recursive: true }) } catch { /* normalement créé par l'installeur */ }

    // Migration one-shot : au 1er lancement après mise à jour, sous le compte qui
    // détient la config (typiquement l'admin d'install), on recopie l'ancienne config
    // par-utilisateur vers le dossier partagé. Les fichiers de config sont légers ; la
    // caisse locale (potentiellement lourde) est DÉPLACÉE si possible plutôt que copiée.
    try {
        const sharedHasConfig = fs.existsSync(path.join(shared, 'config.json'))
        const perUserHasConfig = fs.existsSync(path.join(perUser, 'config.json'))
        if (!sharedHasConfig && perUserHasConfig) {
            const oldLocal = path.join(perUser, 'cieloo-local')
            fs.cpSync(perUser, shared, {
                recursive: true,
                errorOnExist: false,
                force: false,
                filter: (src) => src !== oldLocal,   // exclut la caisse locale de la copie
            })
            // Caisse locale : déplacement instantané si même volume, sinon la synchro
            // cloud la reconstruira au prochain passage en mode local (best-effort).
            const newLocal = path.join(shared, 'cieloo-local')
            if (fs.existsSync(oldLocal) && !fs.existsSync(newLocal)) {
                try { fs.renameSync(oldLocal, newLocal) } catch { /* volume différent → re-seed */ }
            }
        }
    } catch { /* migration best-effort : ne doit jamais empêcher le démarrage */ }

    app.setPath('userData', shared)
}

useSharedUserData()

// ─── Instance unique (une seule caisse par machine) ───────────────────────────
//
// Double-clic répété sur le raccourci, lancement depuis un 2e compte Windows,
// relance pendant que la caisse tourne… : une 2e instance entrerait en conflit sur
// TOUT ce qui est machine-wide — ports du Dolibarr local, serveur d'impression
// (9100), proxy NACEF, serveur de médias, et surtout la config + la caisse locale
// partagées dans C:\ProgramData (cf. useSharedUserData ci-dessus).
//
// Le verrou est posé APRÈS useSharedUserData() : Chromium l'ancre sur le dossier
// userData, il doit donc être définitif au moment de la demande.
const hasSingleInstanceLock = app.requestSingleInstanceLock()

if (!hasSingleInstanceLock) {
    // 2e instance : on rend la main tout de suite. Le process déjà en place est
    // réveillé via 'second-instance' et remet sa fenêtre au premier plan.
    app.quit()
} else {
    app.on('second-instance', () => {
        focusExistingInstance()
    })
}

/** Remet la caisse déjà ouverte au premier plan (relance bloquée par le verrou). */
function focusExistingInstance(): void {
    const win = mainWindow && !mainWindow.isDestroyed()
        ? mainWindow
        : BrowserWindow.getAllWindows().find((w) => !w.isDestroyed()) ?? null
    if (!win) return
    if (win.isMinimized()) win.restore()
    if (!win.isVisible()) win.show()
    win.moveTop()
    win.focus()
}

// Build de démonstration : active le choix « Cloud / Local » au 1er lancement.
// Injecté à la compilation via electron.vite (define process.env.DEMO_MODE).
const IS_DEMO = process.env.DEMO_MODE === '1' || process.env.DEMO_MODE === 'true'

// ─── RustDesk / Dashboard integration ────────────────────────────────────────

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL ?? 'https://monitoring.cieloo.io/'
const TERMINAL_API_KEY = process.env.TERMINAL_API_KEY ?? 'CHANGE_ME'
const RUSTDESK_CONFIG = process.env.RUSTDESK_CONFIG ?? ''
const RUSTDESK_SERVER = process.env.RUSTDESK_SERVER ?? ''
const RUSTDESK_KEY = process.env.RUSTDESK_KEY ?? ''

let _rustdeskIdCache: string | null = null

// PID des process RustDesk (tray/GUI) lancés PAR la caisse : on les termine à la
// fermeture de l'app. Le service Windows RustDesk, lui, n'est jamais arrêté — c'est
// lui qui permet la prise en main à distance quand la caisse est fermée.
const rustdeskChildPids = new Set<number>()

function spawnRustDeskTray(exePath: string): void {
    const child = spawn(exePath, ['--tray'], { detached: true, stdio: 'ignore' })
    if (child.pid !== undefined) {
        const pid = child.pid
        rustdeskChildPids.add(pid)
        child.once('exit', () => rustdeskChildPids.delete(pid))
    }
    child.unref()
}

/** Termine le tray RustDesk lancé par la caisse (arbre de process complet). */
function stopRustDeskTray(): Promise<void> {
    const pids = [...rustdeskChildPids]
    rustdeskChildPids.clear()
    if (pids.length === 0) return Promise.resolve()
    return Promise.all(pids.map((pid) => new Promise<void>((resolve) => {
        exec(`taskkill /F /T /PID ${pid}`, { timeout: 4000 }, () => resolve())
    }))).then(() => undefined)
}

function getRustDeskId(): string | null {
    if (_rustdeskIdCache) return _rustdeskIdCache
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    const candidatePaths = [
        'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config\\RustDesk2.toml',
        'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config\\RustDesk.toml',
        path.join(appData, 'RustDesk', 'config', 'RustDesk2.toml'),
        path.join(appData, 'RustDesk', 'config', 'RustDesk.toml'),
        'C:\\ProgramData\\RustDesk\\config\\RustDesk2.toml',
        'C:\\ProgramData\\RustDesk\\config\\RustDesk.toml',
    ]
    for (const p of candidatePaths) {
        try {
            const content = fs.readFileSync(p, 'utf-8')
            const match = content.match(/^id\s*=\s*['"]?(\d+)['"]?/m)
            if (match?.[1]) { _rustdeskIdCache = match[1]; return match[1] }
        } catch { /* fichier absent */ }
    }
    return null
}

async function getRustDeskIdFromCLI(): Promise<string | null> {
    return new Promise((resolve) => {
        const exePath = getRustDeskExePath()
        if (!exePath) { resolve(null); return }
        exec(`"${exePath}" --get-id`, { timeout: 4000 }, (_err, stdout) => {
            const match = stdout?.match(/(\d[\d\s]{5,}\d)/)
            resolve(match ? match[1].replace(/\s/g, '') : null)
        })
    })
}

// Dossier portable géré par CielooDesk
const RUSTDESK_PORTABLE_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'CielooRustDesk')
const RUSTDESK_SERVICE_FLAG = path.join(RUSTDESK_PORTABLE_DIR, '.service-installed')
const RUSTDESK_PORTABLE_EXE = path.join(RUSTDESK_PORTABLE_DIR, 'rustdesk.exe')

const RUSTDESK_EXE_CANDIDATES = [
    RUSTDESK_PORTABLE_EXE, // priorité : notre portable
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'RustDesk', 'rustdesk.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'RustDesk', 'rustdesk.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'RustDesk', 'rustdesk.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Programs', 'RustDesk', 'rustdesk.exe'),
]

function getRustDeskExePath(): string | null {
    return RUSTDESK_EXE_CANDIDATES.find(p => fs.existsSync(p)) ?? null
}


async function applyRustDeskConfig(): Promise<string> {
    if (!RUSTDESK_SERVER || !RUSTDESK_KEY) return 'RUSTDESK_SERVER ou RUSTDESK_KEY non défini dans le build'
    const exePath = getRustDeskExePath()
    if (!exePath) return `rustdesk.exe introuvable\nChemins vérifiés:\n${RUSTDESK_EXE_CANDIDATES.join('\n')}`

    // 1. Écriture directe du RustDesk2.toml dans l'AppData utilisateur
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    const configDir = path.join(appData, 'RustDesk', 'config')
    const tomlContent = `[options]\ncustom-rendezvous-server = '${RUSTDESK_SERVER}'\nrelay-server = '${RUSTDESK_SERVER}'\nkey = '${RUSTDESK_KEY}'\napi-server = ''\napprove-mode = 'accept'\n`
    try {
        fs.mkdirSync(configDir, { recursive: true })
        fs.writeFileSync(path.join(configDir, 'RustDesk2.toml'), tomlContent, 'utf-8')
        fs.writeFileSync(path.join(configDir, 'RustDesk.toml'), tomlContent, 'utf-8')
    } catch (err: unknown) {
        return `Erreur écriture config: ${err instanceof Error ? err.message : String(err)}`
    }

    // 2. Redémarrer RustDesk : via le service s'il est installé, sinon via le tray
    const serviceInstalled = await new Promise<boolean>(resolve => {
        exec('sc query RustDesk', err => resolve(!err))
    })

    if (serviceInstalled) {
        await new Promise<void>(resolve => exec('sc stop RustDesk', () => resolve()))
        await new Promise(resolve => setTimeout(resolve, 2000))
        exec('sc start RustDesk', () => { })
    } else {
        await new Promise<void>((resolve) => {
            exec('taskkill /F /IM rustdesk.exe /T', () => resolve())
        })
        await new Promise(resolve => setTimeout(resolve, 1500))
        spawnRustDeskTray(exePath)
    }

    return `Config écrite + RustDesk redémarré (${serviceInstalled ? 'service' : 'tray'})\nServeur: ${RUSTDESK_SERVER}\nexe: ${exePath}`
}

function isRustDeskConfigured(): boolean {
    if (!RUSTDESK_SERVER) return false
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming')
    try {
        const content = fs.readFileSync(path.join(appData, 'RustDesk', 'config', 'RustDesk2.toml'), 'utf-8')
        return content.includes(`custom-rendezvous-server = '${RUSTDESK_SERVER}'`) && content.includes(`approve-mode = 'accept'`)
    } catch { return false }
}

function configureRustDeskServer(): void {
    if (!isRustDeskConfigured()) void applyRustDeskConfig()
}

function createRustDeskShortcutIfNeeded(): void {
    const desktopPath = path.join(os.homedir(), 'Desktop')
    const shortcutPath = path.join(desktopPath, 'RustDesk.lnk')
    if (fs.existsSync(shortcutPath)) return
    const exePath = getRustDeskExePath()
    if (!exePath) return
    const ps = `$s=(New-Object -COM WScript.Shell).CreateShortcut('${shortcutPath.replace(/'/g, "''")}');$s.TargetPath='${exePath.replace(/'/g, "''")}';$s.Save()`
    spawn('powershell.exe', ['-NonInteractive', '-Command', ps], { detached: true, stdio: 'ignore' }).unref()
}

async function installRustDeskIfNeeded(): Promise<void> {
    // Copie le portable dans LocalAppData si pas encore présent
    if (!fs.existsSync(RUSTDESK_PORTABLE_EXE)) {
        const srcPath = app.isPackaged
            ? path.join(process.resourcesPath, 'assets', 'RustDesk.exe')
            : path.join(app.getAppPath(), 'assets', 'RustDesk.exe')
        if (fs.existsSync(srcPath)) {
            try {
                fs.mkdirSync(RUSTDESK_PORTABLE_DIR, { recursive: true })
                fs.copyFileSync(srcPath, RUSTDESK_PORTABLE_EXE)
                // Autostart tray en fallback (supprimé si le service s'installe avec succès)
                exec(`reg add "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v RustDesk /t REG_SZ /d "\\"${RUSTDESK_PORTABLE_EXE}\\" --tray" /f`)
            } catch { /* fail silently */ }
        }
    }
    // Installe RustDesk comme service Windows (UAC une seule fois, idempotent via flag file)
    const exePath = getRustDeskExePath()
    if (exePath) await installRustDeskService(exePath)
    configureRustDeskServer()
    createRustDeskShortcutIfNeeded()
    ensureRustDeskRunning()
    // Tente la CLI si les fichiers de config ne sont pas encore lisibles
    if (!getRustDeskId()) {
        const cliId = await getRustDeskIdFromCLI()
        if (cliId) _rustdeskIdCache = cliId
    }
    buildMenu()
}

async function installRustDeskService(exePath: string): Promise<void> {
    if (fs.existsSync(RUSTDESK_SERVICE_FLAG)) return

    const serviceExists = await new Promise<boolean>(resolve => {
        exec('sc query RustDesk', err => resolve(!err))
    })
    if (serviceExists) {
        try { fs.writeFileSync(RUSTDESK_SERVICE_FLAG, new Date().toISOString()) } catch { }
        return
    }

    try { fs.mkdirSync(RUSTDESK_PORTABLE_DIR, { recursive: true }) } catch { }

    // Écrit la config dans un fichier temporaire (évite les problèmes d'échappement dans PS1)
    let tempTomlPath: string | null = null
    const serviceConfigDir = 'C:\\Windows\\ServiceProfiles\\LocalService\\AppData\\Roaming\\RustDesk\\config'
    if (RUSTDESK_SERVER && RUSTDESK_KEY) {
        const toml = `[options]\ncustom-rendezvous-server = '${RUSTDESK_SERVER}'\nrelay-server = '${RUSTDESK_SERVER}'\nkey = '${RUSTDESK_KEY}'\napi-server = ''\napprove-mode = 'accept'\n`
        tempTomlPath = path.join(RUSTDESK_PORTABLE_DIR, 'temp-svc-config.toml')
        fs.writeFileSync(tempTomlPath, toml, 'utf-8')
    }

    const scriptLines = [
        `& "${exePath}" --install-service`,
        `Start-Sleep -Seconds 3`,
    ]
    if (tempTomlPath) {
        scriptLines.push(
            `New-Item -ItemType Directory -Force -Path "${serviceConfigDir}" | Out-Null`,
            `Copy-Item -Path "${tempTomlPath}" -Destination "${serviceConfigDir}\\RustDesk2.toml" -Force`,
            `Copy-Item -Path "${tempTomlPath}" -Destination "${serviceConfigDir}\\RustDesk.toml" -Force`,
        )
    }
    scriptLines.push(`Start-Service RustDesk -ErrorAction SilentlyContinue`)

    const scriptPath = path.join(RUSTDESK_PORTABLE_DIR, 'install-svc.ps1')
    try { fs.writeFileSync(scriptPath, scriptLines.join('\r\n'), 'utf-8') } catch { return }

    // Lance le script en élevé (UAC) — silencieux, attend la fin
    const escapedScript = scriptPath.replace(/\\/g, '\\\\')
    const psCmd = `Start-Process powershell.exe -Verb RunAs -WindowStyle Hidden -Wait -ArgumentList '-NonInteractive -ExecutionPolicy Bypass -File "${escapedScript}"'`

    await new Promise<void>(resolve => {
        exec(`powershell.exe -NonInteractive -Command "${psCmd}"`, { timeout: 30000 }, () => {
            if (tempTomlPath) try { fs.unlinkSync(tempTomlPath) } catch { }
            try { fs.unlinkSync(scriptPath) } catch { }
            // Vérifie si le service a bien été installé (indépendamment du code retour)
            exec('sc query RustDesk', (queryErr) => {
                if (!queryErr) {
                    try { fs.writeFileSync(RUSTDESK_SERVICE_FLAG, new Date().toISOString()) } catch { }
                    // Le service gère le démarrage auto — plus besoin de l'entrée tray dans le registre
                    exec('reg delete "HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Run" /v RustDesk /f', () => { })
                }
                resolve()
            })
        })
    })
}

function ensureRustDeskRunning(): void {
    const exePath = getRustDeskExePath()
    if (!exePath) return
    // Essaie d'abord de démarrer le service Windows (silencieux, pas de fenêtre)
    // Si le service est déjà en cours ou démarre → connexions acceptées sans GUI
    exec('sc start RustDesk', (err) => {
        if (!err) return // service démarré
        // Service déjà actif (code 1056) ou pas de droits : lance le tray comme fallback
        exec('tasklist /FI "IMAGENAME eq rustdesk.exe" /NH', (_e, stdout) => {
            if (stdout.toLowerCase().includes('rustdesk.exe')) return // déjà en cours
            spawnRustDeskTray(exePath)
        })
    })
}

async function reportRustDeskHeartbeat(): Promise<void> {
    let rustdeskId = getRustDeskId()
    // Si pas en cache ni dans les fichiers lisibles, essaie la CLI (service IPC)
    if (!rustdeskId) {
        const cliId = await getRustDeskIdFromCLI()
        if (cliId) {
            _rustdeskIdCache = cliId
            rustdeskId = cliId
            buildMenu() // met à jour le label Support avec le nouvel ID
        }
    }
    if (!rustdeskId) return

    const config = readConfig()
    if (!config.instance) return

    const instanceUrl = config.freeInstance
        ? (() => { try { return new URL(config.instance).hostname } catch { return config.instance } })()
        : `${config.instance}.cieloo.io`

    const { mac, ip } = getNetworkInfo()
    const settings = loadSettings()

    try {
        await fetch(`${DASHBOARD_API_URL}/api/terminals/heartbeat`, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'X-Terminal-Key': TERMINAL_API_KEY,
            },
            body: JSON.stringify({
                instance_url: instanceUrl,
                rustdesk_id: rustdeskId,
                mac,
                ip,
                serial_number: settings.serialNumber || null,
                terminal_name: settings.terminalName || null,
            }),
            signal: AbortSignal.timeout(5000),
        })
    } catch {
        // fail silently — non-critical background task
    }
}

// ─── Instance config ──────────────────────────────────────────────────────────

// Mode de l'ecran de chargement de la caisse locale :
//  - 'prod'  : textes rigolos + barre (par defaut, pour les caissiers)
//  - 'dev'   : textes techniques reels + barre + journal des actions
//  - 'debug' : console temps reel des actions, sans barre ni overlay « joli »
type LoaderMode = 'prod' | 'dev' | 'debug'

interface Config {
    instance?: string
    freeInstance?: boolean
    localOffered?: boolean        // on a deja propose le mode local au 1er lancement
    localEnabled?: boolean        // l'utilisateur a accepte / le pack est installe
    localActive?: boolean         // on tourne actuellement sur la caisse locale
    localLoaderMode?: LoaderMode  // apparence de l'ecran de chargement local
    fullLocal?: boolean           // caisse 100% locale : aucune synchro cloud, aucune instance requise
    offlinePosActive?: boolean    // caisse de secours hors-ligne (SPA pos-offline) affichée
    offlinePosSince?: number      // horodatage (ms) de la bascule hors-ligne — compteur affiché dans la SPA
    offlinePosAutoSync?: boolean  // synchro auto des ventes locales au retour en ligne (désactivée par défaut)
}

type InstanceSource = 'clipboard' | 'exe'

interface InstanceSuggestion {
    instance: string
    source: InstanceSource
}

const INSTANCE_REGEX = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/

function configPath(): string { return path.join(app.getPath('userData'), 'config.json') }

function readConfig(): Config {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Config }
    catch { return {} }
}

function writeConfig(c: Config): void {
    fs.writeFileSync(configPath(), JSON.stringify(c, null, 2))
}

function getLoaderMode(): LoaderMode {
    const m = readConfig().localLoaderMode
    return m === 'dev' || m === 'debug' ? m : 'prod'
}

function setLoaderMode(mode: LoaderMode): void {
    writeConfig({ ...readConfig(), localLoaderMode: mode })
}

function normalizeInstance(value: string): string | null {
    const clean = value.trim().toLowerCase()
    if (!INSTANCE_REGEX.test(clean)) return null
    return clean
}

function extractInstanceFromClipboardText(rawText: string): string | null {
    const lines = rawText
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

    if (lines.length !== 1) return null

    const text = lines[0]
    const taggedMatch = text.match(/^CIELOO_INSTANCE=([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])$/i)
    if (taggedMatch) return normalizeInstance(taggedMatch[1])

    const hostMatch = text.match(/^([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\.cieloo\.io$/i)
    if (hostMatch) return normalizeInstance(hostMatch[1])

    const urlMatch = text.match(/^https?:\/\/([a-z0-9][a-z0-9-]{0,61}[a-z0-9]|[a-z0-9])\.cieloo\.io\/?$/i)
    if (urlMatch) return normalizeInstance(urlMatch[1])

    return null
}

function inferInstanceFromClipboard(): string | null {
    try {
        return extractInstanceFromClipboardText(clipboard.readText('clipboard'))
    } catch {
        return null
    }
}

function inferInstanceFromExecutableName(): string | null {
    const exeBaseName = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
    const match = exeBaseName.match(/^cieloo(?:desk|pos)?[_-]([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)$/)
    if (!match) return null
    return normalizeInstance(match[1])
}

function detectBootstrapInstance(): InstanceSuggestion | null {
    const fromClipboard = inferInstanceFromClipboard()
    if (fromClipboard) return { instance: fromClipboard, source: 'clipboard' }

    const fromExe = inferInstanceFromExecutableName()
    if (fromExe) return { instance: fromExe, source: 'exe' }

    return null
}

function deleteConfig(): void {
    try {
        fs.unlinkSync(configPath())
    } catch {
        // Ignore if the file does not exist or cannot be deleted.
    }
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let lastCielooUrl = ''
let forcedWindowFullscreenForHtml = false
let secondScreenEditorWindow: BrowserWindow | null = null

// Error codes that indicate a genuine network failure (not a server/app error)
const NET_ERROR_CODES = new Set([-21, -100, -101, -102, -105, -106, -109, -118, -137, -138])

const BASE_PAGE_RESET_CSS = 'html,body{margin:0!important;padding:0!important;border:0!important}'
const CIELOO_FULLSCREEN_OVERFLOW_FIX_CSS = 'html,body{max-width:100%!important;overflow-x:hidden!important}'

// Capte le BroadcastChannel 'cieloopos_cart' (déjà émis par le POS pour le second
// écran) et relaie l'état du panier au preload via postMessage → afficheur client.
// Injecté dans le MAIN world via executeJavaScript (donc non bloqué par la CSP).
const CUSTOMER_DISPLAY_CART_HOOK = `(function(){
    if (window.__cielooVfdHook) return; window.__cielooVfdHook = true;
    try {
        var bc = new BroadcastChannel('cieloopos_cart');
        bc.onmessage = function(ev){
            try { window.postMessage({ __cielooVfd: true, cart: ev.data }, '*'); } catch(e){}
        };
    } catch(e){}
})();`

function enforceStableWebViewRendering(wc: Electron.WebContents): void {
    wc.setZoomFactor(1)
    void wc.setVisualZoomLevelLimits(1, 1)
}

function injectRuntimeCss(wc: Electron.WebContents, url: string): void {
    const css = isCielooUrl(url)
        ? `${BASE_PAGE_RESET_CSS}${CIELOO_FULLSCREEN_OVERFLOW_FIX_CSS}`
        : BASE_PAGE_RESET_CSS
    void wc.insertCSS(css)
}

function loadOfflinePage(): void {
    if (!mainWindow) return
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/offline.html`)
    } else {
        void mainWindow.loadFile(path.join(__dirname, '../renderer/offline.html'))
    }
}

// Codes d'erreur reseau = perte de connectivite reelle → page « hors-ligne ».
// (Le reste des erreurs reseau = serveur injoignable/erreur → page d'erreur.)
const OFFLINE_CODES = new Set([-21, -105, -106, -109, -137])

function netErrorMessage(code: number): string {
    switch (code) {
        case -100: return 'La connexion au serveur a été interrompue.'
        case -101: return 'La connexion au serveur a été réinitialisée.'
        case -102: return 'Le serveur a refusé la connexion.'
        case -118: return 'Le serveur n\'a pas répondu à temps (délai dépassé).'
        default: return 'Impossible de charger la page (erreur réseau).'
    }
}

// Page d'erreur generique : titre + message + cause + code, dans la fenetre.
function showErrorPage(opts: { title?: string; message: string; detail?: string; code?: string | number }): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const qs = new URLSearchParams()
    if (opts.title) qs.set('title', opts.title)
    qs.set('message', opts.message)
    if (opts.detail) qs.set('detail', String(opts.detail).slice(0, 1500))
    if (opts.code !== undefined && opts.code !== null && String(opts.code) !== '') qs.set('code', String(opts.code))
    const search = `?${qs.toString()}`
    if (!mainWindow.isVisible()) mainWindow.show()
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/error.html${search}`)
    } else {
        void mainWindow.loadFile(path.join(__dirname, '../renderer/error.html'), { search })
    }
}
let printSettingsWindow: BrowserWindow | null = null
let barcodeSettingsWindow: BrowserWindow | null = null
let balanceSettingsWindow: BrowserWindow | null = null
let secondDisplaySettingsWindow: BrowserWindow | null = null
let loadingOverlayWindow: BrowserWindow | null = null
let loadingOverlayShownAt = 0
let loadingOverlayHideTimer: NodeJS.Timeout | null = null
let loadingOverlayPending = false

const LOADING_OVERLAY_SIZE = 54
const LOADING_OVERLAY_MARGIN = 16
const LOADING_OVERLAY_TOP_OFFSET = 52

// Base URL on which all Cieloo app paths are appended.
// For a free instance the configured URL can include a sub-path
// (ex. http://localhost/cieloo) — that prefix must be preserved, so we keep the
// full configured URL (trailing slash stripped) instead of just the origin.
function resolveCielooBase(): string | null {
    const config = readConfig()

    // En mode caisse locale, tout le POS vit sur le Dolibarr local : « Ouvrir caisse /
    // minipos », le second écran, etc. doivent cibler le serveur local, jamais l'instance
    // cloud. En Mode Full Local on ne retombe JAMAIS sur le cloud (caisse 100% locale) ;
    // en bascule locale classique (miroir d'une instance), on tolère un repli cloud si le
    // serveur local n'est pas (encore) démarré.
    if (config.fullLocal === true) {
        return isLocalPackPresent() ? getLocalBaseUrl() : null
    }
    if (config.localActive === true && isLocalPackPresent()) {
        const localBase = getLocalBaseUrl()
        if (localBase) return localBase
    }

    if (config.instance && config.freeInstance) {
        try { return new URL(config.instance).href.replace(/\/+$/, '') } catch { return null }
    }

    // Hosted instance: prefer the live cieloo.io URL, fall back to config.
    const liveUrl = [mainWindow?.webContents.getURL() ?? '', lastCielooUrl].find(isCielooUrl)
    if (liveUrl) {
        try { return new URL(liveUrl).origin } catch { /* fall through */ }
    }
    if (config.instance) return `https://${config.instance}.cieloo.io`
    return null
}

// Pure origin (scheme + host[:port]) — used for cookie scoping.
function resolveCielooOrigin(): string | null {
    const base = resolveCielooBase()
    if (!base) return null
    try { return new URL(base).origin } catch { return null }
}

function openCielooPath(pathname: string): void {
    const base = resolveCielooBase()
    if (!base) return
    void mainWindow?.loadURL(`${base}${pathname}`)
}

function resolveSecondScreenUrl(): string | null {
    const base = resolveCielooBase()
    if (!base) return null
    return `${base}/custom/cieloopos/secondscreen.php`
}

function resolveSecondScreenEditorUrl(): string | null {
    const base = resolveCielooBase()
    if (!base) return null
    return `${base}/custom/cieloopos/admin/secondscreen_editor.php?focus=1`
}

function openSecondScreenFromMainWindow(): void {
    const targetUrl = resolveSecondScreenUrl()
    if (!targetUrl) {
        void dialog.showMessageBox({
            type: 'warning',
            title: 'Second ecran indisponible',
            message: 'Impossible de determiner la page Cieloo active.',
            detail: 'Ouvrez d abord votre instance Cieloo dans la fenetre principale, puis relancez le second ecran.',
        })
        return
    }

    const secondScreen = startSecondScreen(targetUrl)
    if (secondScreen) return

    void dialog.showMessageBox({
        type: 'info',
        title: 'Second ecran non detecte',
        message: 'Aucun second ecran n a ete detecte pour le moment.',
        detail: 'Branchez un ecran supplementaire et le module reessaiera automatiquement pendant quelques secondes.',
    })
}

function openSecondScreenEditorWindow(): void {
    const targetUrl = resolveSecondScreenEditorUrl()
    if (!targetUrl) {
        void dialog.showMessageBox({
            type: 'warning',
            title: 'Studio d edition indisponible',
            message: 'Impossible de determiner l instance Cieloo active.',
            detail: 'Ouvrez d abord votre instance Cieloo dans la fenetre principale, puis relancez le studio d edition.',
        })
        return
    }

    if (secondScreenEditorWindow && !secondScreenEditorWindow.isDestroyed()) {
        if (secondScreenEditorWindow.webContents.getURL() !== targetUrl) {
            void secondScreenEditorWindow.loadURL(targetUrl)
        }
        if (secondScreenEditorWindow.isMinimized()) secondScreenEditorWindow.restore()
        secondScreenEditorWindow.show()
        secondScreenEditorWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    secondScreenEditorWindow = new BrowserWindow({
        width: 1360,
        height: 880,
        minWidth: 1100,
        minHeight: 720,
        icon: resolveAppIcon(),
        title: 'Studio d edition - CielooPos',
        backgroundColor: '#ffffff',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
        },
    })

    secondScreenEditorWindow.once('ready-to-show', () => {
        secondScreenEditorWindow?.show()
    })
    secondScreenEditorWindow.on('closed', () => {
        secondScreenEditorWindow = null
    })

    void secondScreenEditorWindow.loadURL(targetUrl)
}

async function selectSecondDisplayMediaFolder(): Promise<string | null> {
    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined
    const currentFolder = loadSettings().secondDisplayMediaFolder ?? undefined

    const dialogOptions = {
        title: 'Selectionner le dossier des medias du second afficheur',
        properties: ['openDirectory', 'createDirectory'],
        defaultPath: currentFolder,
        buttonLabel: 'Selectionner ce dossier',
    } satisfies Electron.OpenDialogOptions

    const result = parentWindow
        ? await dialog.showOpenDialog(parentWindow, dialogOptions)
        : await dialog.showOpenDialog(dialogOptions)

    if (result.canceled || result.filePaths.length === 0) return null

    const selectedFolder = result.filePaths[0]
    updateSettings((current) => ({
        ...current,
        secondDisplayMediaFolder: selectedFolder,
    }))

    return selectedFolder
}

function clearSecondDisplayMediaFolder(): void {
    updateSettings((current) => ({
        ...current,
        secondDisplayMediaFolder: null,
    }))
}

function createOverlayHtml(): string {
    return `<!doctype html>
<html>
<head>
<meta charset="UTF-8" />
<style>
    html,body{margin:0;padding:0;background:transparent;overflow:hidden}
    .wrap{width:100vw;height:100vh;display:flex;align-items:center;justify-content:center}
    .badge{width:42px;height:42px;border-radius:9999px;background:rgba(255,255,255,.96);
        box-shadow:0 6px 22px rgba(0,0,0,.28);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);
        display:flex;align-items:center;justify-content:center}
    .ring{width:26px;height:26px;border-radius:50%;border:3px solid rgba(59,130,246,.25);
        border-top-color:#3b82f6;animation:spin .65s linear infinite}
    @keyframes spin{to{transform:rotate(360deg)}}
</style>
</head>
<body>
    <div class="wrap"><div class="badge"><div class="ring"></div></div></div>
</body>
</html>`
}

function getLoadingOverlayPoint(bounds: Electron.Rectangle): { x: number; y: number } {
    const spinnerPosition = loadSettings().spinnerPosition
    const top = spinnerPosition.startsWith('top')
    const left = spinnerPosition.endsWith('left')

    const x = left
        ? bounds.x + LOADING_OVERLAY_MARGIN
        : bounds.x + bounds.width - LOADING_OVERLAY_SIZE - LOADING_OVERLAY_MARGIN

    const y = top
        ? bounds.y + LOADING_OVERLAY_TOP_OFFSET
        : bounds.y + bounds.height - LOADING_OVERLAY_SIZE - LOADING_OVERLAY_MARGIN

    return { x, y }
}

function ensureLoadingOverlay(parent: BrowserWindow): BrowserWindow {
    if (loadingOverlayWindow && !loadingOverlayWindow.isDestroyed()) return loadingOverlayWindow

    loadingOverlayWindow = new BrowserWindow({
        width: LOADING_OVERLAY_SIZE,
        height: LOADING_OVERLAY_SIZE,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        parent,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        }
    })

    loadingOverlayWindow.setIgnoreMouseEvents(true, { forward: true })
    loadingOverlayWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    loadingOverlayWindow.setAlwaysOnTop(true, 'screen-saver')
    loadingOverlayWindow.setMenuBarVisibility(false)
    loadingOverlayWindow.on('closed', () => { loadingOverlayWindow = null })

    void loadingOverlayWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(createOverlayHtml())}`)
    syncLoadingOverlayBounds()

    return loadingOverlayWindow
}

function syncLoadingOverlayBounds(): void {
    if (!mainWindow || !loadingOverlayWindow || loadingOverlayWindow.isDestroyed()) return
    const bounds = mainWindow.getBounds()
    const { x, y } = getLoadingOverlayPoint(bounds)
    loadingOverlayWindow.setBounds({ x, y, width: LOADING_OVERLAY_SIZE, height: LOADING_OVERLAY_SIZE })
}

function hideLoadingOverlayImmediate(): void {
    if (loadingOverlayHideTimer) {
        clearTimeout(loadingOverlayHideTimer)
        loadingOverlayHideTimer = null
    }
    if (loadingOverlayWindow && !loadingOverlayWindow.isDestroyed()) loadingOverlayWindow.hide()
}

function canShowLoadingOverlayNow(): boolean {
    if (!mainWindow) return false
    return mainWindow.isVisible() && !mainWindow.isMinimized()
}

function flushPendingLoadingOverlay(): void {
    if (!mainWindow) return
    if (!loadingOverlayPending) return
    if (!mainWindow.webContents.isLoadingMainFrame()) {
        loadingOverlayPending = false
        return
    }
    showLoadingOverlay()
}

function showLoadingOverlay(): void {
    if (!mainWindow) return

    if (!canShowLoadingOverlayNow()) {
        loadingOverlayPending = true
        return
    }

    loadingOverlayPending = false
    const overlay = ensureLoadingOverlay(mainWindow)

    if (loadingOverlayHideTimer) {
        clearTimeout(loadingOverlayHideTimer)
        loadingOverlayHideTimer = null
    }

    syncLoadingOverlayBounds()
    loadingOverlayShownAt = Date.now()

    if (!overlay.isVisible()) overlay.showInactive()
    overlay.moveTop()
}

function hideLoadingOverlay(): void {
    loadingOverlayPending = false
    if (!loadingOverlayWindow || loadingOverlayWindow.isDestroyed()) return

    if (loadingOverlayHideTimer) {
        clearTimeout(loadingOverlayHideTimer)
        loadingOverlayHideTimer = null
    }

    const minVisibleMs = 550
    const elapsed = Date.now() - loadingOverlayShownAt
    const wait = Math.max(0, minVisibleMs - elapsed)

    loadingOverlayHideTimer = setTimeout(() => {
        if (!loadingOverlayWindow || loadingOverlayWindow.isDestroyed()) return
        loadingOverlayWindow.hide()
        loadingOverlayHideTimer = null
    }, wait)
}

// ─── Toast (overlay flottant, remplace les dialog.showMessageBox non bloquants) ─
// Même patron que l'overlay de chargement ci-dessus : une petite fenêtre
// transparente/frameless posée sur mainWindow, qui flotte peu importe la page
// affichée (POS cloud ou caisse hors-ligne). Sert pour la synchro du snapshot
// et le téléchargement des images (avec barre de progression).

let toastWindow: BrowserWindow | null = null
let toastHideTimer: NodeJS.Timeout | null = null

const TOAST_WIDTH = 360
const TOAST_HEIGHT = 104
const TOAST_MARGIN = 20

interface ToastOptions {
    kind: 'success' | 'error' | 'info'
    title: string
    message?: string
    /** ms avant disparition auto ; 0 = reste affiché (toast de progression, à remplacer/fermer explicitement) */
    duration?: number
    /** 0-100 : affiche une fine barre de progression sous le message */
    progress?: number
}

const TOAST_COLORS: Record<ToastOptions['kind'], { accent: string; soft: string }> = {
    success: { accent: '#16a34a', soft: '#dcfce7' },
    error: { accent: '#dc3545', soft: '#fee2e2' },
    info: { accent: '#2563eb', soft: '#eff6ff' },
}

const TOAST_ICONS: Record<ToastOptions['kind'], string> = {
    success: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    error: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    info: '<svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><line x1="12" y1="11" x2="12" y2="16"/><circle cx="12" cy="7.3" r="0.6" fill="currentColor"/></svg>',
}

function escToastHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

function toastHtml(opts: ToastOptions): string {
    const c = TOAST_COLORS[opts.kind]
    const msgHtml = opts.message ? `<div class="msg">${escToastHtml(opts.message)}</div>` : ''
    const pct = opts.progress !== undefined ? Math.max(0, Math.min(100, opts.progress)) : null
    const barHtml = pct !== null
        ? `<div class="bar-track"><div class="bar-fill" style="width:${pct}%"></div></div>`
        : ''
    return `<!doctype html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;padding:0;background:transparent;overflow:hidden;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif}
.card{position:absolute;left:14px;right:14px;bottom:14px;display:flex;align-items:flex-start;gap:11px;
    background:#fff;border-radius:14px;padding:13px 15px;
    box-shadow:0 12px 28px rgba(15,23,42,.16),0 2px 8px rgba(15,23,42,.08);
    border:1px solid #e2e8f0;border-left:4px solid ${c.accent};
    animation:cieloo-toast-in .22s cubic-bezier(.2,.9,.3,1.2)}
@keyframes cieloo-toast-in{from{opacity:0;transform:translateY(10px) scale(.97)}to{opacity:1;transform:translateY(0) scale(1)}}
.icon{flex-shrink:0;width:26px;height:26px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:${c.soft};color:${c.accent}}
.body{flex:1;min-width:0}
.title{font-size:13.5px;font-weight:800;color:#1e293b;line-height:1.3}
.msg{font-size:12px;color:#64748b;margin-top:2px;line-height:1.4;overflow:hidden;text-overflow:ellipsis;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical}
.bar-track{margin-top:8px;height:5px;border-radius:999px;background:#eef2f7;overflow:hidden}
.bar-fill{height:100%;border-radius:999px;background:${c.accent};transition:width .25s ease}
</style></head><body>
<div class="card">
    <div class="icon">${TOAST_ICONS[opts.kind]}</div>
    <div class="body"><div class="title">${escToastHtml(opts.title)}</div>${msgHtml}${barHtml}</div>
</div>
</body></html>`
}

function getToastPoint(bounds: Electron.Rectangle): { x: number; y: number } {
    return {
        x: bounds.x + bounds.width - TOAST_WIDTH - TOAST_MARGIN,
        y: bounds.y + bounds.height - TOAST_HEIGHT - TOAST_MARGIN,
    }
}

function ensureToastWindow(parent: BrowserWindow): BrowserWindow {
    if (toastWindow && !toastWindow.isDestroyed()) return toastWindow

    toastWindow = new BrowserWindow({
        width: TOAST_WIDTH,
        height: TOAST_HEIGHT,
        show: false,
        frame: false,
        transparent: true,
        resizable: false,
        movable: false,
        minimizable: false,
        maximizable: false,
        closable: false,
        focusable: false,
        skipTaskbar: true,
        hasShadow: false,
        alwaysOnTop: true,
        parent,
        webPreferences: {
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
            spellcheck: false,
        }
    })

    toastWindow.setIgnoreMouseEvents(true, { forward: true })
    toastWindow.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true })
    toastWindow.setAlwaysOnTop(true, 'screen-saver')
    toastWindow.setMenuBarVisibility(false)
    toastWindow.on('closed', () => { toastWindow = null })

    return toastWindow
}

function syncToastBounds(): void {
    if (!mainWindow || !toastWindow || toastWindow.isDestroyed()) return
    const { x, y } = getToastPoint(mainWindow.getBounds())
    toastWindow.setBounds({ x, y, width: TOAST_WIDTH, height: TOAST_HEIGHT })
}

function hideToastImmediate(): void {
    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null }
    if (toastWindow && !toastWindow.isDestroyed()) toastWindow.hide()
}

/**
 * Toast flottant non bloquant — remplace les dialog.showMessageBox pour les
 * actions type synchro (résultat, progression). `duration: 0` le garde affiché
 * (toast de progression) jusqu'au prochain showToast() ou hideToast().
 */
function showToast(opts: ToastOptions): void {
    if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
    const win = ensureToastWindow(mainWindow)
    void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(toastHtml(opts))}`)
    syncToastBounds()
    if (!win.isVisible()) win.showInactive()
    win.moveTop()

    if (toastHideTimer) { clearTimeout(toastHideTimer); toastHideTimer = null }
    const duration = opts.duration ?? (opts.kind === 'error' ? 5500 : 3500)
    if (duration > 0) {
        toastHideTimer = setTimeout(hideToastImmediate, duration)
    }
}

// ─── Splash de transition (bascule caisse en ligne ↔ caisse locale) ─────────
// Page plein écran chargée DANS mainWindow pendant la bascule : évite le gel
// sur la dernière image affichée, et sert d'écran de progression pour la
// synchro des ventes locales lors du retour en ligne.

function transitionSplashHtml(title: string, subtitle: string): string {
    return `<!doctype html><html><head><meta charset="UTF-8"><style>
html,body{margin:0;padding:0;height:100%;background:#f5f8fa;overflow:hidden;
    font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;
    display:flex;align-items:center;justify-content:center}
.card{display:flex;flex-direction:column;align-items:center;gap:16px;max-width:440px;padding:20px}
.spin{width:50px;height:50px;border-radius:50%;border:4px solid #dbeafe;border-top-color:#2563eb;animation:cieloo-spin .8s linear infinite}
@keyframes cieloo-spin{to{transform:rotate(360deg)}}
.title{font-size:19px;font-weight:800;color:#1e293b;text-align:center;letter-spacing:-0.01em}
.subtitle{font-size:13.5px;color:#64748b;text-align:center;line-height:1.5;min-height:20px}
.bar-track{width:280px;height:6px;border-radius:999px;background:#e2e8f0;overflow:hidden;display:none}
.bar-track.show{display:block}
.bar-fill{height:100%;border-radius:999px;background:#2563eb;width:0%;transition:width .2s ease}
</style></head><body>
<div class="card">
    <div class="spin"></div>
    <div class="title">${escToastHtml(title)}</div>
    <div class="subtitle" id="subtitle">${escToastHtml(subtitle)}</div>
    <div class="bar-track" id="barTrack"><div class="bar-fill" id="barFill"></div></div>
</div>
</body></html>`
}

function showTransitionSplash(title: string, subtitle: string): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(transitionSplashHtml(title, subtitle))}`)
}

/** Met à jour le sous-titre / la barre de progression du splash déjà affiché. */
function updateTransitionSplash(subtitle: string, pct: number | null): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const barJs = pct === null
        ? "bt.classList.remove('show');"
        : `bt.classList.add('show'); bf.style.width='${Math.max(0, Math.min(100, pct))}%';`
    const js = `(function(){
        var s=document.getElementById('subtitle'); if(s) s.textContent=${JSON.stringify(subtitle)};
        var bt=document.getElementById('barTrack'), bf=document.getElementById('barFill');
        if (bt && bf) { ${barJs} }
    })();`
    void mainWindow.webContents.executeJavaScript(js).catch(() => { /* page pas encore prête */ })
}

// ─── App icon ─────────────────────────────────────────────────────────────────

function resolveAppIcon(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets', 'img', 'favicon.ico')
    }
    return path.join(app.getAppPath(), 'assets', 'img', 'favicon.ico')
}

// Logo CaisLà inline (base64) pour les ecrans de chargement servis en data: URL
// (pas d'acces fichier depuis ces pages). Lu une seule fois puis mis en cache.
let cachedLogoDataUri: string | null = null
function logoDataUri(): string {
    if (cachedLogoDataUri !== null) return cachedLogoDataUri
    try {
        const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
        const file = path.join(base, 'assets', 'img', 'logo_CaisLa.png')
        cachedLogoDataUri = `data:image/png;base64,${fs.readFileSync(file).toString('base64')}`
    } catch {
        cachedLogoDataUri = ''
    }
    return cachedLogoDataUri
}

function escapeHtml(s: string): string {
    return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

// ─── AnyDesk ─────────────────────────────────────────────────────────────────

function resolveAnyDeskPath(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets', 'AnyDesk.exe')
    }
    return path.join(app.getAppPath(), 'assets', 'AnyDesk.exe')
}

function launchAnyDesk(): void {
    const exePath = resolveAnyDeskPath()
    if (!fs.existsSync(exePath)) {
        void dialog.showErrorBox('AnyDesk introuvable', `Impossible de trouver AnyDesk.exe à l'emplacement :\n${exePath}`)
        return
    }
    spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
}

function toggleFocusedWindowDevTools(): void {
    const focusedWindow = BrowserWindow.getFocusedWindow() ?? mainWindow
    focusedWindow?.webContents.toggleDevTools()
}

// État RGI mis en cache pour le libellé du menu (rafraîchi par un poller léger).
let rgiRunningCache = false

async function refreshRgiStatus(): Promise<void> {
    const running = await isRgiRunning()
    if (running !== rgiRunningCache) {
        rgiRunningCache = running
        buildMenu()
    }
}

/** Affiche un toast flottant dans la fenêtre principale (page caisse). */
function showMainToast(message: string, kind: 'ok' | 'error' = 'ok'): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const accent = kind === 'error' ? '#dc2626' : '#16a34a'
    const js = `(() => { try {
        let t = document.getElementById('_cl_balance_toast');
        if (!t) { t = document.createElement('div'); t.id = '_cl_balance_toast'; document.body.appendChild(t); }
        const s = t.style;
        s.position='fixed'; s.zIndex='2147483647'; s.bottom='26px'; s.left='50%'; s.transform='translateX(-50%) translateY(8px)';
        s.maxWidth='80vw'; s.padding='13px 20px'; s.borderRadius='12px'; s.background='#0f172a'; s.color='#fff';
        s.font='600 14px system-ui,Segoe UI,sans-serif'; s.boxShadow='0 10px 34px rgba(0,0,0,.28)';
        s.borderLeft='4px solid ${accent}'; s.opacity='0'; s.transition='opacity .25s ease, transform .25s ease'; s.pointerEvents='none';
        t.textContent = ${JSON.stringify(message)};
        requestAnimationFrame(() => { s.opacity='1'; s.transform='translateX(-50%) translateY(0)'; });
        clearTimeout(window.__clBalanceToastTimer);
        window.__clBalanceToastTimer = setTimeout(() => { s.opacity='0'; s.transform='translateX(-50%) translateY(8px)'; }, 3400);
    } catch (e) {} })();`
    void mainWindow.webContents.executeJavaScript(js).catch(() => { /* page pas prête */ })
}

async function downloadBalanceFromMenu(): Promise<void> {
    const r = await generateBalanceFile({ force: true })
    if (!r.ok) {
        showMainToast(`Balance — échec : ${r.error ?? 'erreur inconnue'}`, 'error')
        return
    }
    showMainToast(
        r.written
            ? `Balance — ${r.count} article(s) téléchargé(s) ✓`
            : `Balance — déjà à jour (${r.count} article(s))`,
        'ok',
    )
}

async function launchDfsAppFromMenu(appName: DfsApp): Promise<void> {
    let result = await launchDfsApp(appName)

    if (result.status === 'not_found') {
        // Pour RGI, on propose de localiser l'exe (et on mémorise le chemin).
        if (appName === 'RGI' && await selectRgiPath()) {
            result = await launchDfsApp(appName)
        } else {
            await dialog.showMessageBox({
                type: 'warning',
                title: `${appName} introuvable`,
                message: `${appName}.exe n'a pas été trouvé.`,
                detail: `Vérifiez l'installation DFS (par défaut C:\\Program Files (x86)\\DFS\\${appName}\\${appName}.exe).`,
            })
            return
        }
    }

    if (result.status === 'already') {
        await dialog.showMessageBox({ type: 'info', title: appName, message: `${appName} est déjà lancé.` })
    } else if (result.status === 'error') {
        await dialog.showMessageBox({
            type: 'error',
            title: appName,
            message: `Impossible de lancer ${appName}.`,
            detail: result.error ?? '',
        })
    }
    if (appName === 'RGI') void refreshRgiStatus()
}

// Called once on start and whenever shortcuts change
function buildMenu(): void {
    const sc = loadSettings().shortcuts

    const navigationSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Retour',
            accelerator: 'Alt+Left',
            click: () => mainWindow?.webContents.navigationHistory.goBack()
        },
        {
            label: 'Suivant',
            accelerator: 'Alt+Right',
            click: () => mainWindow?.webContents.navigationHistory.goForward()
        },
        { type: 'separator' },
        {
            label: 'Recharger la page',
            accelerator: sc.reload,
            click: () => mainWindow?.webContents.reload()
        },
        {
            label: 'Forcer le rechargement',
            accelerator: sc.hardReload,
            click: () => mainWindow?.webContents.reloadIgnoringCache()
        }
    ]

    const caisseSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Ouvrir caisse',
            click: () => openCielooPath('/custom/cieloopos/index.php')
        },
        {
            label: 'Ouvrir minipos',
            click: () => openCielooPath('/custom/minipos/page/index.php')
        },
        { type: 'separator' },
        {
            label: 'Quitter',
            accelerator: sc.quit,
            click: () => shutdownApp()
        }
    ]

    const affichageSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Plein écran',
            accelerator: sc.fullscreen,
            click: () => { if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen()) }
        },
        { type: 'separator' },
        {
            label: 'Demarrer le second ecran',
            click: () => openSecondScreenFromMainWindow()
        }
    ]

    if (isDev) {
        affichageSubmenu.push(
            { type: 'separator' },
            {
                label: 'Outils développeurs',
                accelerator: sc.devtools,
                click: () => toggleFocusedWindowDevTools()
            }
        )
    }

    const paramsSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Paramètres généraux',
            click: () => openSettingsWindow(isDev, process.env.ELECTRON_RENDERER_URL)
        },
        { type: 'separator' },
        {
            label: 'Imprimantes de Caisses',
            click: () => openPrintSettingsWindow()
        },
        {
            label: 'Imprimantes Codes Barres',
            click: () => openBarcodeSettingsWindow()
        },
        { type: 'separator' },
        {
            label: 'Parametres second afficheur',
            click: () => openSecondDisplaySettingsWindow()
        }
    ]

    // Menu « Balance » (barre du haut) — visible uniquement quand le mode est activé.
    const balanceSubmenu: Electron.MenuItemConstructorOptions[] = [
        { label: 'Synchroniser les produits maintenant', click: () => void downloadBalanceFromMenu() },
        { label: 'Configuration…', click: () => openBalanceSettingsWindow() },
        { type: 'separator' },
        { label: rgiRunningCache ? 'RGI : en cours d\'exécution' : 'RGI : arrêté', enabled: false },
        {
            label: 'Lancer RGI',
            enabled: !rgiRunningCache,
            click: () => void launchDfsAppFromMenu('RGI'),
        },
        { type: 'separator' },
        { label: 'Lancer DGI', click: () => void launchDfsAppFromMenu('DGI') },
        { label: 'Lancer DFS', click: () => void launchDfsAppFromMenu('DFS') },
    ]

    const rustdeskId = getRustDeskId()
    const supportSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: rustdeskId ? `ID RustDesk : ${rustdeskId}` : 'ID RustDesk : non disponible',
            enabled: false,
        },
        { type: 'separator' },
        {
            label: 'Lancer RustDesk',
            click: () => {
                const exePath = getRustDeskExePath()
                if (exePath) spawn(exePath, [], { detached: true, stdio: 'ignore' }).unref()
            }
        },
        {
            label: 'Lancer AnyDesk',
            click: () => launchAnyDesk()
        },
        {
            label: 'Contacter le support',
            click: () => openContactWindow()
        },
        { type: 'separator' },
        {
            label: 'Vérifier les mises à jour',
            click: () => mainWindow?.webContents.send('updater:check-requested')
        }
    ]

    // ── Onglet « Caisse Locale » ──────────────────────────────────────────────
    // Nouvelle caisse de secours hors-ligne (SPA pos-offline + snapshot JSON).
    // L'ancien prototype Dolibarr local complet reste accessible dans un sous-menu.
    const localInstalled = isLocalPackPresent()
    const localActive = readConfig().localActive
    const offlinePosActive = readConfig().offlinePosActive === true
    const offlineMeta = readOfflineSnapshotMeta()
    const snapshotInfoLabel = offlineMeta
        ? `Snapshot : ${offlineMeta.products} produits, ${offlineMeta.customers} clients (${new Date(offlineMeta.fetchedAt).toLocaleString('fr-FR')})`
        : 'Snapshot : jamais téléchargé'

    const legacyLocalSubmenu: Electron.MenuItemConstructorOptions[] = localInstalled
        ? [
            localActive
                ? { label: 'Revenir au mode en ligne', click: () => void switchToCloud() }
                : { label: 'Basculer en caisse locale', click: () => void switchToLocal() },
            { label: 'Synchroniser', click: () => void syncLocalNow() },
            { label: 'Statut du serveur local…', click: () => void showLocalServerStatus() },
            { label: 'Config…', click: () => openLocalConfigWindow() },
            { type: 'separator' },
            {
                label: 'Effacer config',
                click: () => void resetLocalConfig()
            },
            {
                label: 'Désinstaller la caisse locale',
                enabled: !localActive,            // on ne desinstalle pas pendant qu'on l'utilise
                click: () => void uninstallLocal()
            }
        ]
        : [
            { label: 'Installer la caisse locale…', click: () => void switchToLocal() },
            { label: 'Config…', click: () => openLocalConfigWindow() }
        ]

    const offlinePosConfigSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Synchroniser les ventes au retour en ligne',
            type: 'checkbox',
            checked: readConfig().offlinePosAutoSync === true,
            toolTip: 'Au retour en ligne, transmet automatiquement les ventes locales en attente (sinon, seul le bouton « Téléverser » du ticket les synchronise).',
            click: () => void toggleOfflinePosAutoSync()
        },
    ]

    const caisseLocaleSubmenu: Electron.MenuItemConstructorOptions[] = [
        offlinePosActive
            ? { label: 'Revenir en caisse en ligne', click: () => void returnFromOfflinePos() }
            : { label: 'Basculer en caisse locale', click: () => void switchToOfflinePos() },
        { label: 'Mettre à jour le snapshot', click: () => void refreshOfflineSnapshotNow() },
        { label: 'Télécharger les images', click: () => void syncOfflineImagesNow() },
        { label: snapshotInfoLabel, enabled: false },
        { type: 'separator' },
        { label: 'Config', submenu: offlinePosConfigSubmenu },
        { label: 'Ancien prototype (Dolibarr local)', submenu: legacyLocalSubmenu },
    ]

    const devSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Effacer config',
            click: () => {
                deleteConfig()
                loadContent()
            }
        },
        {
            label: 'Passer en mode hors connexion',
            click: () => loadOfflinePage()
        },
        {
            label: 'Mode Full Local',
            type: 'checkbox',
            checked: readConfig().fullLocal === true,
            toolTip: 'Caisse 100% locale : Dolibarr local uniquement, sans instance Cieloo ni synchronisation cloud.',
            click: () => void toggleFullLocal()
        },
        // En Full Local, on peut amorcer/écraser la base locale avec une copie d'une
        // instance Cieloo choisie à la volée (pas d'instance fixe configurée).
        ...(readConfig().fullLocal === true
            ? [{
                label: 'Dupliquer la base…',
                toolTip: 'Copie la base d\'une instance Cieloo (.cieloo.io) dans la base locale.',
                click: () => void duplicateBaseFromInstance()
            }] as Electron.MenuItemConstructorOptions[]
            : []),
        {
            label: 'Synchroniser FTP',
            toolTip: 'Copie tous les fichiers du site cloud (modules, images, médias…) dans la caisse locale, via FTP. Ne touche ni la config locale ni la base.',
            click: () => void syncFtpNow()
        },
        {
            label: 'Ouvrir dossiers locaux',
            toolTip: 'Ouvre dans l\'explorateur les dossiers de l\'installation Dolibarr locale (htdocs, documents, logs).',
            click: () => void openLocalFolders()
        },
        { type: 'separator' },
        {
            label: 'Ouvrir configuration nacef',
            click: () => openTechConfigWindow()
        },
        {
            label: 'Ouvrir config cieloopos',
            click: () => openCielooPathInNewWindow('/custom/cieloopos/admin/setup.php', 'Config CielooPos')
        },
        { type: 'separator' },
        {
            label: 'Forcer config RustDesk',
            click: () => {
                applyRustDeskConfig().then((result) => {
                    dialog.showMessageBox({
                        title: 'Config RustDesk',
                        message: result,
                        detail: `ID actuel: ${getRustDeskId() ?? 'inconnu'}\nConfig baked: ${RUSTDESK_CONFIG ? RUSTDESK_CONFIG.slice(0, 20) + '...' : 'VIDE'}`,
                    })
                })
            }
        },
        {
            label: 'Test heartbeat dashboard',
            click: () => {
                reportRustDeskHeartbeat().then(() => {
                    dialog.showMessageBox({ title: 'Heartbeat', message: `ID: ${getRustDeskId() ?? 'introuvable'}\nURL: ${DASHBOARD_API_URL}\nRequête envoyée — vérifiez les logs du serveur.` })
                })
            }
        },
        { type: 'separator' },
        {
            label: 'Outils développeurs',
            accelerator: sc.devtools,
            click: () => toggleFocusedWindowDevTools()
        }
    ]

    // En-tete : URL de la page. On garde le DEBUT et on coupe la fin (ellipse a droite)
    // pour ne jamais depasser la largeur du plus long autre item du menu.
    const currentPageUrl = mainWindow?.webContents.getURL() ?? ''
    const widestLabel = Math.max(
        ...devSubmenu.map(item => (typeof item.label === 'string' ? item.label.length : 0))
    )
    const maxUrlChars = Math.max(0, widestLabel - 'URL : '.length)
    const shortUrl = currentPageUrl.length > maxUrlChars && maxUrlChars > 1
        ? `${currentPageUrl.slice(0, maxUrlChars - 1)}…`
        : currentPageUrl
    devSubmenu.unshift(
        {
            label: currentPageUrl ? `URL : ${shortUrl}` : 'URL : (aucune page chargée)',
            enabled: !!currentPageUrl,
            toolTip: currentPageUrl || undefined, // URL complete au survol
            click: () => openUrlEditorWindow(),
        },
        { type: 'separator' }
    )

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        { label: 'Caisse', submenu: caisseSubmenu },
        { label: 'Navigation', submenu: navigationSubmenu },
        { label: 'Affichage', submenu: affichageSubmenu },
        { label: 'Paramètres', submenu: paramsSubmenu },
    ]

    // « Caisse Locale » : fonction encore en test, réservée au mode dev.
    if (isDev || loadSettings().devMode) {
        menuTemplate.push({ label: 'Caisse Locale', submenu: caisseLocaleSubmenu })
    }

    // « Balance » juste avant « Support », seulement si le mode est activé.
    if (loadSettings().balance.enabled) {
        menuTemplate.push({ label: 'Balance', submenu: balanceSubmenu })
    }

    menuTemplate.push({ label: 'Support', submenu: supportSubmenu })

    if (isDev || loadSettings().devMode) {
        menuTemplate.push({ label: 'Dev', submenu: devSubmenu })
    }

    Menu.setApplicationMenu(Menu.buildFromTemplate(menuTemplate))
}

function openPrintSettingsWindow(): void {
    if (printSettingsWindow && !printSettingsWindow.isDestroyed()) {
        printSettingsWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    printSettingsWindow = new BrowserWindow({
        width: 760,
        height: 620,
        minWidth: 700,
        minHeight: 560,
        icon: resolveAppIcon(),
        title: 'Imprimantes de Caisses - CielooPos',
        backgroundColor: '#f3f5f8',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            spellcheck: false,
        },
    })

    printSettingsWindow.setMenu(null)
    printSettingsWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            printSettingsWindow?.webContents.toggleDevTools()
        }
    })
    printSettingsWindow.once('ready-to-show', () => {
        printSettingsWindow?.show()
    })
    printSettingsWindow.on('closed', () => {
        printSettingsWindow = null
    })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void printSettingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/print-settings.html`)
    } else {
        void printSettingsWindow.loadFile(path.join(__dirname, '../renderer/print-settings.html'))
    }
}

function openBarcodeSettingsWindow(): void {
    if (barcodeSettingsWindow && !barcodeSettingsWindow.isDestroyed()) {
        barcodeSettingsWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    barcodeSettingsWindow = new BrowserWindow({
        width: 760,
        height: 620,
        minWidth: 700,
        minHeight: 560,
        icon: resolveAppIcon(),
        title: 'Imprimantes Codes Barres - CielooPos',
        backgroundColor: '#f3f5f8',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            spellcheck: false,
        },
    })

    barcodeSettingsWindow.setMenu(null)
    barcodeSettingsWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            barcodeSettingsWindow?.webContents.toggleDevTools()
        }
    })
    barcodeSettingsWindow.once('ready-to-show', () => {
        barcodeSettingsWindow?.show()
    })
    barcodeSettingsWindow.on('closed', () => {
        barcodeSettingsWindow = null
    })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void barcodeSettingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/barcode-settings.html`)
    } else {
        void barcodeSettingsWindow.loadFile(path.join(__dirname, '../renderer/barcode-settings.html'))
    }
}

function openBalanceSettingsWindow(): void {
    if (balanceSettingsWindow && !balanceSettingsWindow.isDestroyed()) {
        balanceSettingsWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    balanceSettingsWindow = new BrowserWindow({
        width: 780,
        height: 680,
        minWidth: 720,
        minHeight: 580,
        icon: resolveAppIcon(),
        title: 'Balance - CielooPos',
        backgroundColor: '#f3f5f8',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            spellcheck: false,
        },
    })

    balanceSettingsWindow.setMenu(null)
    balanceSettingsWindow.webContents.on('before-input-event', (_e, input) => {
        if (input.key === 'F12' && input.type === 'keyDown') {
            balanceSettingsWindow?.webContents.toggleDevTools()
        }
    })
    balanceSettingsWindow.once('ready-to-show', () => {
        balanceSettingsWindow?.show()
    })
    balanceSettingsWindow.on('closed', () => {
        balanceSettingsWindow = null
    })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void balanceSettingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/balance-settings.html`)
    } else {
        void balanceSettingsWindow.loadFile(path.join(__dirname, '../renderer/balance-settings.html'))
    }
}

function openSecondDisplaySettingsWindow(): void {
    if (secondDisplaySettingsWindow && !secondDisplaySettingsWindow.isDestroyed()) {
        secondDisplaySettingsWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    secondDisplaySettingsWindow = new BrowserWindow({
        width: 760,
        height: 620,
        minWidth: 700,
        minHeight: 560,
        icon: resolveAppIcon(),
        title: 'Parametres second afficheur - CielooPos',
        backgroundColor: '#f3f5f8',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            spellcheck: false,
        },
    })

    secondDisplaySettingsWindow.setMenu(null)
    secondDisplaySettingsWindow.once('ready-to-show', () => {
        secondDisplaySettingsWindow?.show()
    })
    secondDisplaySettingsWindow.on('closed', () => {
        secondDisplaySettingsWindow = null
    })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void secondDisplaySettingsWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/second-display-settings.html`)
    } else {
        void secondDisplaySettingsWindow.loadFile(path.join(__dirname, '../renderer/second-display-settings.html'))
    }
}

let contactWindow: BrowserWindow | null = null
let techConfigWindow: BrowserWindow | null = null
let localConfigWindow: BrowserWindow | null = null
let localStatusWindow: BrowserWindow | null = null

// Ouvre un chemin de l'app Cieloo (relatif à la base) dans une nouvelle webview.
function openCielooPathInNewWindow(pathname: string, title: string): void {
    const base = resolveCielooBase()
    if (!base) {
        void dialog.showMessageBox({
            type: 'warning',
            title,
            message: 'Instance Cieloo introuvable.',
            detail: 'Ouvrez d abord votre instance Cieloo dans la fenetre principale, puis relancez.',
        })
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    // Ne jamais depasser la zone utile de l'ecran (barre des taches comprise).
    const workArea = screen.getPrimaryDisplay().workAreaSize
    const width = Math.min(1280, workArea.width)
    const height = Math.min(820, workArea.height)

    const win = new BrowserWindow({
        width,
        height,
        minWidth: Math.min(900, workArea.width),
        minHeight: Math.min(600, workArea.height),
        icon: resolveAppIcon(),
        title: `${title} - CielooPos`,
        backgroundColor: '#ffffff',
        show: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
        },
    })

    win.setMenu(null) // pas de barre de menus en haut
    win.webContents.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
    lockNavigation(win.webContents)
    win.once('ready-to-show', () => {
        win.center()
        win.show()
    })
    void win.loadURL(`${base}${pathname}`)
}

let urlEditorWindow: BrowserWindow | null = null

// Petite fenetre (menu Dev) : input pour voir / modifier / copier l'URL courante.
function openUrlEditorWindow(): void {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''

    if (urlEditorWindow && !urlEditorWindow.isDestroyed()) {
        urlEditorWindow.webContents.send('url-editor:set', currentUrl)
        urlEditorWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    urlEditorWindow = new BrowserWindow({
        width: 560,
        height: 200,
        useContentSize: true, // width/height = zone de contenu (hors barre de titre)
        resizable: false,
        minimizable: false,
        maximizable: false,
        icon: resolveAppIcon(),
        title: 'URL de la page — CielooPos',
        backgroundColor: '#f8fafc',
        show: false,
        parent: parentWindow,
        modal: false,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    urlEditorWindow.setMenu(null)
    urlEditorWindow.once('ready-to-show', () => {
        // Ajuste la hauteur de la fenetre pile sur le contenu (pas de scroll).
        urlEditorWindow?.webContents
            .executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)')
            .then((h: number) => {
                if (urlEditorWindow && !urlEditorWindow.isDestroyed() && h > 0) {
                    urlEditorWindow.setContentSize(560, h)
                }
            })
            .catch(() => { /* garde la taille par defaut */ })
        urlEditorWindow?.show()
    })
    urlEditorWindow.on('closed', () => { urlEditorWindow = null })

    const query = `?url=${encodeURIComponent(currentUrl)}`
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void urlEditorWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/url-editor.html${query}`)
    } else {
        void urlEditorWindow.loadFile(path.join(__dirname, '../renderer/url-editor.html'), { search: query })
    }
}

// ─── Dupliquer la base (menu Dev, Full Local) ────────────────────────────────
// Petite fenetre qui demande l'instance Cieloo source (ex: acme.cieloo.io), puis
// resout la promesse via IPC (submit) ou null (annulation / fermeture).
let duplicateDbWindow: BrowserWindow | null = null
let duplicateDbResolve: ((v: string | null) => void) | null = null

function promptInstanceForDuplicate(): Promise<string | null> {
    if (duplicateDbWindow && !duplicateDbWindow.isDestroyed()) {
        duplicateDbWindow.focus()
        return Promise.resolve(null)
    }

    return new Promise<string | null>((resolve) => {
        duplicateDbResolve = resolve
        const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

        duplicateDbWindow = new BrowserWindow({
            width: 560,
            height: 240,
            useContentSize: true,
            resizable: false,
            minimizable: false,
            maximizable: false,
            icon: resolveAppIcon(),
            title: 'Dupliquer la base — CielooPos',
            backgroundColor: '#f8fafc',
            show: false,
            parent: parentWindow,
            modal: true,
            webPreferences: {
                preload: path.join(__dirname, '../preload/index.js'),
                contextIsolation: true,
                sandbox: false,
                nodeIntegration: false,
            }
        })

        duplicateDbWindow.setMenu(null)
        duplicateDbWindow.once('ready-to-show', () => {
            duplicateDbWindow?.webContents
                .executeJavaScript('Math.ceil(document.body.getBoundingClientRect().height)')
                .then((h: number) => {
                    if (duplicateDbWindow && !duplicateDbWindow.isDestroyed() && h > 0) {
                        duplicateDbWindow.setContentSize(560, h)
                    }
                })
                .catch(() => { /* garde la taille par defaut */ })
            duplicateDbWindow?.show()
        })
        // Fermeture (croix / annulation) → on resout null si personne n'a deja repondu.
        duplicateDbWindow.on('closed', () => {
            duplicateDbWindow = null
            if (duplicateDbResolve) { duplicateDbResolve(null); duplicateDbResolve = null }
        })

        if (isDev && process.env.ELECTRON_RENDERER_URL) {
            void duplicateDbWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/duplicate-db.html`)
        } else {
            void duplicateDbWindow.loadFile(path.join(__dirname, '../renderer/duplicate-db.html'))
        }
    })
}

// Normalise la saisie utilisateur en hostname d'instance (acme.cieloo.io) :
// enleve le protocole/chemin, et complete « acme » → « acme.cieloo.io ».
function normalizeInstanceUrl(input: string): string | null {
    let s = (input ?? '').trim()
    if (!s) return null
    s = s.replace(/^https?:\/\//i, '')     // sans protocole
    s = s.split('/')[0].trim()             // sans chemin / query
    s = s.replace(/\/+$/, '')
    if (!s) return null
    if (!s.includes('.')) s = `${s}.cieloo.io`  // nom court → domaine Cieloo
    return s.toLowerCase()
}

// « Dupliquer la base… » (menu Dev, Full Local) : demande une instance Cieloo puis
// remplace la base locale par une copie complete de celle du cloud (seed). C'est
// destructif : la base locale actuelle est ecrasee.
async function duplicateBaseFromInstance(): Promise<void> {
    if (!mainWindow) return
    if (readConfig().fullLocal !== true) return   // reserve au Mode Full Local
    if (!isLocalPackPresent()) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Dupliquer la base',
            message: 'La caisse locale n\'est pas installée.',
            detail: 'Activez d\'abord le Mode Full Local pour installer la caisse locale.',
        })
        return
    }

    const raw = await promptInstanceForDuplicate()
    if (raw === null) return                       // annulation
    const instanceUrl = normalizeInstanceUrl(raw)
    if (!instanceUrl) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Dupliquer la base',
            message: 'Instance invalide.',
            detail: 'Saisissez le lien de l\'instance, par exemple : acme.cieloo.io',
        })
        return
    }

    const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Dupliquer', 'Annuler'],
        defaultId: 1,
        cancelId: 1,
        title: 'Dupliquer la base',
        message: `Remplacer la base locale par une copie de ${instanceUrl} ?`,
        detail: 'La base locale actuelle sera définitivement écrasée par les données de cette instance.',
    })
    if (confirm.response !== 0) return

    await runDuplicateBase(instanceUrl)
}

// Cœur de la duplication (réutilisé par le menu Dev et par le setup « Mode Local ») :
// (re)démarre le moteur local, refuse une version Dolibarr incompatible, remplace la base
// locale par une copie complète du cloud (seed = base + fichiers du site), puis recharge
// le POS. `instanceUrl` = hostname (acme.cieloo.io) ou URL d'une instance libre.
// Renvoie true si la duplication a réussi.
async function runDuplicateBase(instanceUrl: string): Promise<boolean> {
    if (!mainWindow) return false

    renderLocalShell(false, `Duplication depuis ${instanceUrl}`)
    pushLocalProgress({ phase: 'sync-check', message: 'Préparation de la duplication…' })

    const deps: SyncDeps = { dashboardUrl: DASHBOARD_API_URL, terminalKey: TERMINAL_API_KEY, instanceUrl }
    let localUrl: string | null = null
    try {
        // Le moteur local doit tourner pour recréer/importer la base (idempotent).
        localUrl = await startLocalDolibarr((info) => pushLocalProgress(info))

        // Refuse une instance dont la version Dolibarr diffère de celle du pack local.
        pushLocalProgress({ phase: 'sync-check', message: 'Vérification de l\'instance…' })
        const info = await fetchSyncInfo(deps)
        if (!isVersionCompatible(info.dolibarr_version)) {
            const err = new Error(
                `Cette instance est en Dolibarr ${info.dolibarr_version}. `
                + `La caisse locale nécessite la version ${EXPECTED_DOLIBARR_LABEL}.`
            ) as Error & { code?: string }
            err.code = 'VERSION_MISMATCH'
            throw err
        }

        await seedLocalFromCloud(deps, (info) => pushLocalProgress(info))

        if (localUrl) await mainWindow.loadURL(localUrl)   // POS rechargé sur la base copiée
        await dialog.showMessageBox(mainWindow, {
            type: 'info',
            title: 'Dupliquer la base',
            message: `Base dupliquée depuis ${instanceUrl}.`,
            detail: 'La base locale est désormais une copie de cette instance.',
        })
        return true
    } catch (err) {
        const e = err as Error & { code?: string }
        if (localUrl) await mainWindow.loadURL(localUrl).catch(() => { /* repli silencieux */ })
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Dupliquer la base',
            message: e.code === 'VERSION_MISMATCH'
                ? 'Cette instance n\'est pas compatible avec la caisse locale.'
                : 'La duplication a échoué.',
            detail: e.message,
        })
        return false
    }
}

function openContactWindow(): void {
    if (contactWindow && !contactWindow.isDestroyed()) { contactWindow.focus(); return }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    contactWindow = new BrowserWindow({
        width: 480,
        height: 580,
        minWidth: 420,
        minHeight: 500,
        icon: resolveAppIcon(),
        title: 'Contacter le support — CielooPos',
        backgroundColor: '#f0f4ff',
        show: false,
        resizable: true,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    contactWindow.setMenu(null)
    contactWindow.once('ready-to-show', () => contactWindow?.show())
    contactWindow.on('closed', () => { contactWindow = null })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void contactWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/contact.html`)
    } else {
        void contactWindow.loadFile(path.join(__dirname, '../renderer/contact.html'))
    }
}

function openTechConfigWindow(): void {
    if (techConfigWindow && !techConfigWindow.isDestroyed()) {
        techConfigWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    techConfigWindow = new BrowserWindow({
        width: 620,
        height: 500,
        icon: resolveAppIcon(),
        title: 'Configuration technique — CielooPos',
        backgroundColor: '#f8fafc',
        show: false,
        resizable: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    techConfigWindow.setMenu(null)
    techConfigWindow.once('ready-to-show', () => techConfigWindow?.show())
    techConfigWindow.on('closed', () => { techConfigWindow = null })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void techConfigWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/tech-config.html`)
    } else {
        void techConfigWindow.loadFile(path.join(__dirname, '../renderer/tech-config.html'))
    }
}

// Fenetre « Config » de la caisse locale (pour l'instant : mode de l'ecran de chargement).
function openLocalConfigWindow(): void {
    if (localConfigWindow && !localConfigWindow.isDestroyed()) {
        localConfigWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    localConfigWindow = new BrowserWindow({
        width: 820,
        height: 600,
        useContentSize: true,
        icon: resolveAppIcon(),
        title: 'Caisse locale — Configuration',
        backgroundColor: '#ffffff',
        show: false,
        resizable: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    localConfigWindow.setMenu(null)
    localConfigWindow.once('ready-to-show', () => localConfigWindow?.show())
    localConfigWindow.on('closed', () => { localConfigWindow = null })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void localConfigWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/local-config.html`)
    } else {
        void localConfigWindow.loadFile(path.join(__dirname, '../renderer/local-config.html'))
    }
}

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isCielooUrl(url: string): boolean {
    try { return new URL(url).hostname.endsWith('.cieloo.io') } catch { return false }
}

function isFreeInstanceUrl(url: string): boolean {
    const config = readConfig()
    if (!config.freeInstance || !config.instance) return false
    try { return new URL(url).origin === new URL(config.instance).origin } catch { return false }
}

function isLocalUrl(url: string): boolean {
    return url.startsWith('file://')
        || url.startsWith('http://localhost:')
        || url.startsWith('http://127.0.0.1:')
        || url.startsWith('http://[::1]:')
}

function isExternalContactLink(url: string): boolean {
    return url.startsWith('mailto:') || url.startsWith('tel:')
}

// Enforce navigation lock on any webContents (main + popups)
function lockNavigation(wc: Electron.WebContents): void {
    // En mode caisse locale, tout le POS (et le wizard d'install Dolibarr) vit sur
    // http://127.0.0.1:<port>. La navigation locale doit donc être autorisée dès que
    // le mode local est actif — pas seulement en dev — sinon chaque « Étape suivante »
    // de l'install est bloquée et l'utilisateur reste coincé sur /install/index.php.
    const allowLocalNav = (url: string): boolean =>
        isLocalUrl(url) && (isDev || readConfig().localActive === true)
    wc.on('will-navigate', (event, url) => {
        if (allowLocalNav(url)) return
        if (isExternalContactLink(url)) {
            event.preventDefault()
            void shell.openExternal(url)
            return
        }
        if (isCielooUrl(url) || isFreeInstanceUrl(url)) return
        event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
        if (allowLocalNav(url)) return
        if (isCielooUrl(url) || isFreeInstanceUrl(url)) return
        event.preventDefault()
    })
}

// ─── New-window handler ───────────────────────────────────────────────────────
// Returns the Electron handler response based on the current setting.
function handleWindowOpen(url: string): Electron.WindowOpenHandlerResponse {
    const mode = loadSettings().newWindowMode

    if (isExternalContactLink(url)) {
        void shell.openExternal(url)
        return { action: 'deny' }
    }

    // Never open non-cieloo URLs
    if (!isCielooUrl(url) && !isFreeInstanceUrl(url)) return { action: 'deny' }

    if (mode === 'main') {
        // Navigate the main window instead of opening a popup
        void mainWindow?.loadURL(url)
        return { action: 'deny' }
    }

    // mode === 'popup' → let Electron open a real window with our preload
    return {
        action: 'allow',
        overrideBrowserWindowOptions: {
            width: 1280,
            height: 820,
            backgroundColor: '#ffffff',
            title: 'CielooPos',
            webPreferences: {
                preload: path.join(__dirname, '../preload/index.js'),
                contextIsolation: true,
                sandbox: false,
                nodeIntegration: false,
                webSecurity: true,
            }
        }
    }
}

// ─── Mode caisse LOCAL ─────────────────────────────────────────────────────

// Ecran de chargement « sexy » partage (caisse locale + retour en ligne).
// `mode`  : 'local' → barre de progression determinee ; 'cloud' → barre indeterminee.
// `steps` : affiche le compteur d'etapes 1..5 — UNIQUEMENT pendant l'installation
//           (1er lancement). Pour un simple demarrage (caisse deja installee), on
//           ne montre que la barre, les « etapes » n'auraient aucun sens.
function progressHtml(opts: { title: string; subtitle?: string; message: string; mode: 'local' | 'cloud'; steps?: boolean; badge?: string; log?: boolean }): string {
    const logo = logoDataUri()
    const isCloud = opts.mode === 'cloud'
    const showSteps = opts.steps === true
    const segs = showSteps
        ? Array.from({ length: 5 }, (_, i) => `<span class="seg" data-i="${i + 1}"></span>`).join('')
        : ''
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{height:100%}
      body{font-family:'Segoe UI',system-ui,-apple-system,sans-serif;color:#fff;overflow:hidden;
        background:
          radial-gradient(900px 520px at 12% -12%, rgba(255,159,67,.22), transparent 68%),
          radial-gradient(760px 520px at 105% 118%, rgba(255,107,0,.16), transparent 70%),
          linear-gradient(160deg,#1d2747 0%,#121b35 58%,#0b1226 100%);
        display:flex;align-items:center;justify-content:center}
      .card{width:min(460px,86vw);text-align:center;padding:10px;animation:rise .45s cubic-bezier(.22,1,.36,1) both}
      .logo{width:88px;height:88px;border-radius:24px;object-fit:cover;
        box-shadow:0 16px 44px rgba(255,127,23,.38);
        animation:pop .55s cubic-bezier(.22,1,.36,1) both, float 3.6s ease-in-out .6s infinite}
      h1{margin:20px 0 4px;font-size:21px;font-weight:800;letter-spacing:-.02em}
      .accent{color:#ff8a1f}
      .sub{font-size:12.5px;color:#8ea0bd;letter-spacing:.02em;margin-bottom:14px;min-height:15px}
      #msg{font-size:15px;line-height:1.5;color:#d7e0f0;min-height:46px;padding:0 6px;
        display:flex;align-items:center;justify-content:center;transition:opacity .25s;will-change:opacity}
      .bar{height:11px;border-radius:99px;background:rgba(255,255,255,.10);overflow:hidden;position:relative;
        box-shadow:inset 0 1px 3px rgba(0,0,0,.35)}
      #fill{height:100%;width:0%;border-radius:99px;position:relative;overflow:hidden;
        background:linear-gradient(90deg,#ff7a00,#ffb24d);
        box-shadow:0 0 16px rgba(255,138,31,.65);transition:width .5s cubic-bezier(.4,0,.2,1)}
      #fill::after{content:'';position:absolute;inset:0;border-radius:99px;
        background:linear-gradient(90deg,transparent,rgba(255,255,255,.45),transparent);
        transform:translateX(-100%);animation:shine 1.7s ease-in-out infinite}
      .bar.indet #fill{width:36%;animation:indet 1.25s ease-in-out infinite}
      .bar.indet #fill::after{display:none}
      .steps{display:flex;gap:8px;justify-content:center;margin-top:18px}
      .seg{height:6px;width:30px;border-radius:99px;background:rgba(255,255,255,.16);transition:.4s}
      .seg.on{background:linear-gradient(90deg,#ff7a00,#ffb24d);box-shadow:0 0 12px rgba(255,138,31,.55)}
      #stepLabel{margin-top:13px;font-size:12px;letter-spacing:.06em;color:#7e90ad;min-height:15px}
      #stepLabel b{color:#ff8a1f;font-weight:700;font-size:13px}
      .badge{position:fixed;top:16px;right:16px;font-size:10.5px;font-weight:800;letter-spacing:.1em;
        padding:5px 10px;border-radius:99px;color:#ffb24d;background:rgba(255,138,31,.12);
        border:1px solid rgba(255,138,31,.4)}
      #devlog{margin-top:18px;max-height:148px;overflow-y:auto;text-align:left;
        font-family:'Cascadia Code',Consolas,monospace;font-size:11px;line-height:1.55;
        color:#9fb0cc;background:rgba(0,0,0,.28);border:1px solid rgba(255,255,255,.07);
        border-radius:10px;padding:10px 12px}
      #devlog .ln{white-space:pre-wrap;word-break:break-word}
      #devlog .ph{color:#ff8a1f}
      #devlog::-webkit-scrollbar{width:7px}
      #devlog::-webkit-scrollbar-thumb{background:rgba(255,255,255,.14);border-radius:99px}
      @keyframes rise{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}
      @keyframes pop{from{opacity:0;transform:scale(.82)}to{opacity:1;transform:scale(1)}}
      @keyframes float{0%,100%{transform:translateY(0)}50%{transform:translateY(-7px)}}
      @keyframes shine{0%{transform:translateX(-100%)}60%,100%{transform:translateX(100%)}}
      @keyframes indet{0%{margin-left:-36%}100%{margin-left:100%}}
    </style></head><body>
      ${opts.badge ? `<div class="badge">${escapeHtml(opts.badge)}</div>` : ''}
      <div class="card">
        ${logo ? `<img class="logo" src="${logo}" alt="CaisLà">` : ''}
        <h1>${opts.title}</h1>
        <div class="sub">${opts.subtitle ? escapeHtml(opts.subtitle) : ''}</div>
        <div id="msg">${escapeHtml(opts.message)}</div>
        <div class="bar ${isCloud ? 'indet' : ''}"><div id="fill"></div></div>
        ${showSteps ? `<div class="steps">${segs}</div><div id="stepLabel"></div>` : ''}
        ${opts.log ? `<div id="devlog"></div>` : ''}
      </div>
    </body></html>`
}

// Etape « humaine » (1 a 5) deduite de la phase technique. Les phases de
// telechargement/extraction (1er install) restent en « preparation » (0).
function phaseToStep(phase?: string): number {
    switch (phase) {
        case 'db': return 1
        case 'web': return 2
        case 'install-config': return 3
        case 'install-db': return 4
        case 'install-admin':
        case 'ready': return 5
        default: return 0
    }
}

// Textes « rigolos » du mode prod, par phase. Le module local emet des messages
// techniques (verite affichee telle quelle en dev/debug) ; ici on les habille.
const FUNNY_BY_PHASE: Record<string, string> = {
    'intro-install': 'On prépare votre caisse…',
    'intro-start': 'On rallume votre caisse…',
    'download': 'On va chercher votre caisse… (le temps d\'un café ☕)',
    'extract': 'On déplie les cartons… 📦',
    'done': 'Caisse déballée, presque prête !',
    'db': 'On réveille la caisse en douceur…',
    'web': 'On déroule le tapis du comptoir…',
    'install-config': 'On installe le tiroir-caisse…',
    'install-db': 'On remplit les rayons…',
    'install-admin': 'On accroche l\'enseigne…',
    'ready': 'C\'est prêt, à vous de jouer ! 🎉',
    'uninstall': 'On remballe la caisse locale…',
    'reset': 'On fait le ménage dans la caisse…',
    'sync-check': 'On regarde si tu as du nouveau dans le cloud…',
    'sync-seed': 'On rapatrie ta caisse depuis le cloud… ☁️',
    'sync-import': 'On range tes données dans la caisse…',
    'sync-changes': 'On récupère tes dernières ventes…',
    'sync-done': 'Caisse synchronisée ! ✨',
}

// Mode actif fige au demarrage d'un flux local (pour rester coherent du debut a la fin).
let activeLoaderMode: LoaderMode = 'prod'
// Dernière phase affichée : on ne « fond » le texte qu'au CHANGEMENT de phase
// (sinon les mises à jour rapides — % de téléchargement — font clignoter le texte).
let lastProgressPhase = ''

// Console temps reel du mode DEBUG (page sombre facon terminal).
function progressConsoleHtml(title: string): string {
    const logo = logoDataUri()
    return `<!doctype html><html lang="fr"><head><meta charset="utf-8"><style>
      *{box-sizing:border-box;margin:0;padding:0}
      html,body{height:100%}
      body{font-family:'Cascadia Code',Consolas,'Courier New',monospace;background:#0b0f1a;color:#cdd6e6;
        display:flex;flex-direction:column;height:100vh}
      header{display:flex;align-items:center;gap:10px;padding:12px 16px;border-bottom:1px solid #1c2640;background:#0e1424}
      header img{width:24px;height:24px;border-radius:6px}
      header .t{font-size:13px;font-weight:700;color:#e6edf7}
      header .tag{margin-left:auto;font-size:10px;font-weight:800;letter-spacing:.12em;color:#ff8a1f;
        border:1px solid rgba(255,138,31,.45);border-radius:99px;padding:3px 9px}
      #log{flex:1;overflow-y:auto;padding:12px 16px;font-size:12.5px;line-height:1.7}
      #log .ln{white-space:pre-wrap;word-break:break-word}
      #log .ts{color:#5f6f8c}
      #log .ph{color:#ff8a1f;font-weight:700}
      #log .pct{color:#6ee7a8}
      #log .ln.done{color:#6ee7a8}
      #log::-webkit-scrollbar{width:9px}
      #log::-webkit-scrollbar-thumb{background:#27324f;border-radius:99px}
    </style></head><body>
      <header>
        ${logo ? `<img src="${logo}" alt="">` : ''}
        <span class="t">${escapeHtml(title)}</span>
        <span class="tag">DÉBOGAGE</span>
      </header>
      <div id="log"></div>
    </body></html>`
}

// Rend la coquille de l'ecran selon le mode actif. `steps` → compteur d'etapes.
// `subtitle` decrit l'operation en cours (installation, demarrage, desinstallation…).
function renderLocalShell(steps: boolean, subtitle: string): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    activeLoaderMode = getLoaderMode()
    lastProgressPhase = ''   // nouvelle coquille → la 1re phase doit faire son fondu

    let html: string
    if (activeLoaderMode === 'debug') {
        html = progressConsoleHtml('Caisse locale — actions de paramétrage')
    } else {
        const dev = activeLoaderMode === 'dev'
        html = progressHtml({
            title: 'Caisse <span class="accent">locale</span>',
            subtitle,
            message: '',
            mode: 'local',
            steps,
            badge: dev ? 'MODE DEV' : undefined,
            log: dev,
        })
    }
    void mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    if (!mainWindow.isVisible()) mainWindow.show()
}

// Demarre un flux d'install/demarrage local (avec message d'intro).
function beginLocalProgress(installing: boolean): void {
    renderLocalShell(installing, installing ? 'Installation de votre caisse hors-ligne' : 'Démarrage de votre caisse hors-ligne')
    pushLocalProgress({
        phase: installing ? 'intro-install' : 'intro-start',
        message: installing ? 'Préparation de l\'installation locale…' : 'Démarrage de la caisse locale…',
    })
}

// Operation ponctuelle (desinstallation / effacement) : pas d'etapes, message unique.
function showLocalBusy(phase: 'uninstall' | 'reset', subtitle: string, message: string): void {
    renderLocalShell(false, subtitle)
    pushLocalProgress({ phase, message })
}

function jsStr(s: string): string {
    return s.replace(/\\/g, '\\\\').replace(/'/g, "\\'").replace(/[\r\n]+/g, ' ')
}

// Pousse une etape de progression vers l'ecran actif (prod/dev = carte, debug = console).
function pushLocalProgress(p: { phase?: string; message?: string; pct?: number }): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const phase = p.phase ?? ''
    const tech = p.message ?? ''
    const step = phaseToStep(p.phase)

    let js: string
    if (activeLoaderMode === 'debug') {
        const ts = new Date().toLocaleTimeString('fr-FR', { hour12: false })
        const pct = p.pct !== undefined ? ` <span class="pct">${Math.max(0, Math.min(100, p.pct))}%</span>` : ''
        const done = phase === 'ready' || phase === 'done'
        js = `(()=>{const L=document.getElementById('log');if(!L)return;`
            + `const d=document.createElement('div');d.className='ln${done ? ' done' : ''}';`
            + `d.innerHTML='<span class="ts">[${ts}]</span> ${phase ? `<span class="ph">${jsStr(phase)}</span> ` : ''}${jsStr(tech)}${pct}';`
            + `L.appendChild(d);L.scrollTop=L.scrollHeight;})()`
    } else {
        // Carte prod/dev : prod habille le message, dev montre le texte technique.
        const display = activeLoaderMode === 'prod' ? (FUNNY_BY_PHASE[phase] ?? tech) : tech
        const msg = jsStr(display)
        const fade = display !== '' && phase !== lastProgressPhase   // pas de fondu sur les % rapides
        js = `(()=>{const m=document.getElementById('msg');const f=document.getElementById('fill');`
            + (display
                ? (fade
                    ? `if(m){m.style.opacity='0';setTimeout(()=>{m.textContent='${msg}';m.style.opacity='1'},150);}`
                    : `if(m){m.textContent='${msg}';m.style.opacity='1';}`)
                : '')
            + (p.pct !== undefined ? `if(f)f.style.width='${Math.max(0, Math.min(100, p.pct))}%';` : '')
            + (step > 0
                ? `document.querySelectorAll('.seg').forEach(s=>{s.classList.toggle('on',Number(s.dataset.i)<=${step})});`
                + `var L=document.getElementById('stepLabel');if(L)L.innerHTML='Étape <b>${step}</b> / 5';`
                : '')
            // En mode dev, on journalise aussi le texte technique brut sous la carte.
            + (activeLoaderMode === 'dev'
                ? `var G=document.getElementById('devlog');if(G){var d=document.createElement('div');d.className='ln';`
                + `d.innerHTML='${phase ? `<span class="ph">${jsStr(phase)}</span> ` : ''}${jsStr(tech)}';`
                + `G.appendChild(d);G.scrollTop=G.scrollHeight;}`
                : '')
            + `})()`
    }
    lastProgressPhase = phase
    void mainWindow.webContents.executeJavaScript(js).catch(() => { /* page pas encore prete */ })
}

// Demarre le pack local et charge l'URL (POS ou wizard d'install au 1er run).
// En cas d'echec, on retombe sur le cloud sans bloquer la caisse.
async function loadLocalContent(): Promise<void> {
    if (!mainWindow) return
    try {
        // Compteur d'etapes seulement si Dolibarr n'est pas encore installe (1er run).
        const installing = !getLocalStatus().installed
        beginLocalProgress(installing)
        const url = await startLocalDolibarr((info) => pushLocalProgress(info))

        // Synchro Cloud → Local (seed au 1er run, sinon incrémental). Bloque le mode
        // local si la version Dolibarr de l'instance est incompatible avec le pack.
        const blocked = await syncLocalFromCloud()
        if (blocked) return   // message + retour cloud déjà gérés

        await mainWindow.loadURL(url)
    } catch (err) {
        writeConfig({ ...readConfig(), localActive: false })
        buildMenu()
        showErrorPage({
            title: 'Caisse locale indisponible',
            message: 'Impossible de démarrer la caisse locale. « Réessayer » repassera en mode en ligne.',
            detail: String((err as Error)?.message ?? err),
        })
    }
}

// URL d'instance (acme.cieloo.io) pour identifier la caisse auprès du dashboard.
function currentInstanceUrl(): string | null {
    const cfg = readConfig()
    if (!cfg.instance) return null
    if (cfg.freeInstance) {
        try { return new URL(cfg.instance).hostname } catch { return cfg.instance }
    }
    return `${cfg.instance}.cieloo.io`
}

// Lance la synchro cloud→local pendant l'écran de chargement.
// Renvoie true si le mode local a été BLOQUÉ (version incompatible) → l'appelant stoppe.
async function syncLocalFromCloud(): Promise<boolean> {
    // Mode Full Local : aucune synchronisation cloud, on démarre tel quel.
    if (readConfig().fullLocal === true) return false

    const instanceUrl = currentInstanceUrl()
    if (!instanceUrl) {
        // Sans instance, aucune synchro possible : on refuse de démarrer sur une base
        // vierge si la caisse n'a jamais été synchronisée.
        if (!getSyncState().seeded) {
            await blockLocalNoSync('Aucune instance Cieloo n\'est configurée pour la synchronisation.')
            return true
        }
        return false
    }

    const deps: SyncDeps = { dashboardUrl: DASHBOARD_API_URL, terminalKey: TERMINAL_API_KEY, instanceUrl }
    try {
        await runCloudSync(deps, (info) => pushLocalProgress(info))
    } catch (err) {
        const e = err as Error & { code?: string }
        if (e.code === 'VERSION_MISMATCH') {
            writeConfig({ ...readConfig(), localActive: false })
            buildMenu()
            await stopLocalDolibarr()
            if (mainWindow && !mainWindow.isDestroyed()) {
                await dialog.showMessageBox(mainWindow, {
                    type: 'warning',
                    title: 'Caisse locale indisponible',
                    message: 'Cette instance n\'est pas compatible avec la caisse locale.',
                    detail: `${e.message}\n\nLa caisse reste en mode en ligne.`,
                })
            }
            loadCloudContent()
            return true
        }
        // Erreur de synchro non bloquante : on démarre quand même la caisse locale…
        console.error('[cloud-sync] échec non bloquant :', e.message)
    }

    // …SAUF si la caisse n'a jamais été synchronisée (cloud injoignable au 1er seed) :
    // on n'ouvre pas un Dolibarr vierge, on repasse en ligne.
    if (!getSyncState().seeded) {
        await blockLocalNoSync('Le cloud est injoignable : la première synchronisation n\'a pas pu être réalisée.')
        return true
    }
    return false
}

// Repasse en mode en ligne quand la caisse locale ne peut pas démarrer faute de
// première synchronisation. Coupe le moteur local et affiche un message explicite.
async function blockLocalNoSync(reason: string): Promise<void> {
    writeConfig({ ...readConfig(), localActive: false })
    buildMenu()
    await stopLocalDolibarr()
    if (mainWindow && !mainWindow.isDestroyed()) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Caisse locale indisponible',
            message: 'La caisse locale n\'a jamais été synchronisée avec le cloud.',
            detail: `${reason}\n\nLa caisse reste en mode en ligne.`,
        })
    }
    loadCloudContent()
}

// Determine d'où télécharger le pack : un LOCAL_PACK_URL valide (dev) sinon le
// pack hébergé sur le dashboard (téléchargeable depuis n'importe quelle machine).
function localPackUrlUsable(u?: string): boolean {
    if (!u) return false
    if (/^https?:\/\//i.test(u)) return true
    try {
        let p = u
        if (/^file:\/\//i.test(u)) p = decodeURIComponent(new URL(u).pathname.replace(/^\/([A-Za-z]:)/, '$1'))
        return fs.existsSync(p)
    } catch { return false }
}

async function resolvePackSource(): Promise<{ url: string; sha?: string }> {
    const envUrl = process.env.LOCAL_PACK_URL
    if (localPackUrlUsable(envUrl)) return { url: envUrl as string }
    // Pack hébergé sur le dashboard (endpoint public /api/packs).
    const latest = await fetchLatestPack(DASHBOARD_API_URL)
    const base = DASHBOARD_API_URL.replace(/\/$/, '')
    return { url: `${base}/api/packs/${encodeURIComponent(latest.version)}/download`, sha: latest.sha256 }
}

// Throttle la progression (le téléchargement du pack émet par paquet réseau :
// sans throttle, des milliers d'executeJavaScript inondent le process → crash).
function throttleProgress(
    fn: (i: { phase?: string; pct?: number; message?: string }) => void,
    everyMs: number,
): (i: { phase?: string; pct?: number; message?: string }) => void {
    let last = 0
    return (i) => {
        const now = Date.now()
        if (now - last >= everyMs || i.pct === 100 || i.phase === 'done' || i.phase === 'ready') {
            last = now
            fn(i)
        }
    }
}

// Telecharge le pack puis (optionnellement) bascule en local.
async function installLocalPack(activateAfter: boolean): Promise<boolean> {
    try {
        beginLocalProgress(true)
        const pack = await resolvePackSource()
        const onProg = throttleProgress((info) => pushLocalProgress(info), 200)
        await ensureLocalPack({ url: pack.url, expectedSha256: pack.sha, onProgress: onProg })
        writeConfig({ ...readConfig(), localEnabled: true })
        buildMenu()   // l'onglet « Caisse Locale » reflete maintenant l'etat installe
        if (activateAfter) {
            writeConfig({ ...readConfig(), localActive: true })
            buildMenu()
            await loadLocalContent()
        }
        return true
    } catch (err) {
        writeConfig({ ...readConfig(), localActive: false })
        buildMenu()
        showErrorPage({
            title: 'Échec de l\'installation de la caisse locale',
            message: 'Le téléchargement ou l\'installation du pack a échoué.',
            detail: String((err as Error)?.message ?? err),
        })
        return false
    }
}

// Bascule manuelle vers la caisse locale (installe le pack si absent).
async function switchToLocal(): Promise<void> {
    if (!isLocalPackPresent()) {
        await installLocalPack(true)
        return
    }
    // La caisse locale ne doit JAMAIS s'ouvrir sur un Dolibarr vierge : on exige
    // qu'une première synchronisation cloud→local ait déjà eu lieu.
    // Exception : en Mode Full Local, la base locale vierge EST le but recherché.
    if (readConfig().fullLocal !== true && !getSyncState().seeded) {
        const proceed = await promptFirstSyncRequired()
        if (!proceed) return   // « Retour en ligne » → on reste sur le cloud
    }
    writeConfig({ ...readConfig(), localActive: true })
    buildMenu()
    await loadLocalContent()
}

// Bascule « Mode Full Local » (menu Dev) : caisse 100% locale, sans instance Cieloo
// ni synchronisation cloud. À l'activation, on installe le pack au besoin et on
// démarre directement le Dolibarr local. À la désactivation, on repasse en ligne.
async function toggleFullLocal(): Promise<void> {
    const enabling = readConfig().fullLocal !== true
    if (enabling) {
        writeConfig({ ...readConfig(), fullLocal: true })
        buildMenu()
        await switchToLocal()   // installe le pack si absent puis démarre en local
    } else {
        writeConfig({ ...readConfig(), fullLocal: false })
        buildMenu()
        await switchToCloud()
    }
    buildMenu()
}

// Aucune synchro n'a encore été faite : on prévient l'utilisateur et on lui laisse
// le choix. Renvoie true s'il veut synchroniser maintenant (→ on bascule en local et
// la synchro/seed se fera pendant l'écran de chargement), false pour rester en ligne.
async function promptFirstSyncRequired(): Promise<boolean> {
    if (!mainWindow) return false
    const res = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Synchroniser maintenant', 'Retour en ligne'],
        defaultId: 0,
        cancelId: 1,
        title: 'Caisse Locale',
        message: 'Désolé, la synchronisation n\'a pas encore été faite.',
        detail: 'La caisse locale n\'a jamais été synchronisée avec le cloud : elle ne peut '
            + 'pas démarrer sur une base vide.\n\n'
            + 'Synchronisez-la maintenant (connexion Internet requise) ou revenez en mode en ligne.',
    })
    return res.response === 0
}

// Action manuelle « Synchroniser » du menu Caisse Locale : lance une synchro
// cloud→local maintenant. Démarre le moteur local au besoin (s'il n'est pas déjà
// actif), puis le coupe et revient au cloud si on n'était pas en mode local.
async function syncLocalNow(): Promise<void> {
    if (!mainWindow) return
    if (!isLocalPackPresent()) return

    const instanceUrl = currentInstanceUrl()
    if (!instanceUrl) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Synchronisation',
            message: 'Aucune instance Cieloo configurée.',
            detail: 'Impossible de synchroniser la caisse locale sans instance Cieloo.',
        })
        return
    }

    const wasActive = Boolean(readConfig().localActive)
    renderLocalShell(false, 'Synchronisation avec le cloud')
    pushLocalProgress({ phase: 'sync-check', message: 'Préparation de la synchronisation…' })

    const deps: SyncDeps = { dashboardUrl: DASHBOARD_API_URL, terminalKey: TERMINAL_API_KEY, instanceUrl }
    let localUrl: string | null = null
    try {
        // Le moteur local doit tourner pour importer (démarrage idempotent).
        localUrl = await startLocalDolibarr((info) => pushLocalProgress(info))
        const result = await runCloudSync(deps, (info) => pushLocalProgress(info))

        if (wasActive && localUrl) {
            await mainWindow.loadURL(localUrl)        // on reste en local, POS rechargé à jour
        } else {
            await stopLocalDolibarr()                  // on était en ligne → on recoupe le moteur
            loadCloudContent()
        }

        await dialog.showMessageBox(mainWindow, {
            type: result.status === 'offline' ? 'warning' : 'info',
            title: 'Synchronisation',
            message: result.status === 'offline'
                ? 'Le cloud est injoignable : la synchronisation n\'a pas pu être réalisée.'
                : result.status === 'seeded'
                    ? 'Première synchronisation réussie : la base locale est désormais une copie du cloud.'
                    : 'Caisse locale synchronisée avec le cloud.',
        })
    } catch (err) {
        const e = err as Error & { code?: string }
        if (wasActive && localUrl) {
            await mainWindow.loadURL(localUrl).catch(() => { /* repli silencieux */ })
        } else {
            await stopLocalDolibarr().catch(() => { /* déjà arrêté */ })
            loadCloudContent()
        }
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Synchronisation',
            message: e.code === 'VERSION_MISMATCH'
                ? 'Cette instance n\'est pas compatible avec la caisse locale.'
                : 'La synchronisation a échoué.',
            detail: e.message,
        })
    }
}

// Action « Synchroniser FTP » (menu Dev) : rapatrie TOUT le site cloud (htdocs +
// documents : modules, images, médias, fichiers remplacés par des modules…) par-dessus
// l'install locale, via FTP. Ne touche NI la config locale (conf.php) NI la base — c'est
// le complément « fichiers » de la synchro de base.
async function syncFtpNow(): Promise<void> {
    if (!mainWindow) return
    if (!isLocalPackPresent()) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Synchroniser FTP',
            message: 'La caisse locale n\'est pas installée.',
            detail: 'Activez le Mode Full Local (ou installez la caisse locale) avant de synchroniser les fichiers.',
        })
        return
    }

    const instanceUrl = currentInstanceUrl()
    if (!instanceUrl) {
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Synchroniser FTP',
            message: 'Aucune instance Cieloo configurée.',
            detail: 'Impossible de synchroniser les fichiers sans instance Cieloo.',
        })
        return
    }

    const confirm = await dialog.showMessageBox(mainWindow, {
        type: 'question',
        buttons: ['Synchroniser', 'Annuler'],
        defaultId: 0,
        cancelId: 1,
        title: 'Synchroniser FTP',
        message: `Copier tous les fichiers du site ${instanceUrl} en local ?`,
        detail: 'Le site cloud (modules, images, médias…) sera copié par-dessus la caisse locale. '
            + 'La configuration locale (conf.php) et la base de données ne sont pas touchées.',
    })
    if (confirm.response !== 0) return

    const wasActive = Boolean(readConfig().localActive)
    renderLocalShell(false, `Synchronisation FTP depuis ${instanceUrl}`)
    pushLocalProgress({ phase: 'sync-files', message: 'Préparation de la synchronisation…' })

    const deps: SyncDeps = { dashboardUrl: DASHBOARD_API_URL, terminalKey: TERMINAL_API_KEY, instanceUrl }
    let localUrl: string | null = null
    try {
        // Le moteur local doit tourner pour recharger le POS à jour ensuite (idempotent).
        localUrl = await startLocalDolibarr((info) => pushLocalProgress(info))
        const ok = await syncSiteFilesFromCloud(deps, (info) => pushLocalProgress(info))

        if (wasActive && localUrl) {
            await mainWindow.loadURL(localUrl)          // on reste en local, POS rechargé
        } else {
            await stopLocalDolibarr()                    // on était en ligne → on recoupe le moteur
            loadCloudContent()
        }

        await dialog.showMessageBox(mainWindow, {
            type: ok ? 'info' : 'warning',
            title: 'Synchroniser FTP',
            message: ok
                ? 'Fichiers du site synchronisés.'
                : 'Aucun fichier n\'a été synchronisé.',
            detail: ok
                ? 'Les modules, images et médias du cloud ont été copiés dans la caisse locale.'
                : 'Vérifiez que l\'instance et le FTP du dashboard sont accessibles.',
        })
    } catch (err) {
        if (wasActive && localUrl) {
            await mainWindow.loadURL(localUrl).catch(() => { /* repli silencieux */ })
        } else {
            await stopLocalDolibarr().catch(() => { /* déjà arrêté */ })
            loadCloudContent()
        }
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Synchroniser FTP',
            message: 'La synchronisation FTP a échoué.',
            detail: String((err as Error)?.message ?? err),
        })
    }
}

// Action « Ouvrir dossiers locaux » (menu Dev) : ouvre dans l'explorateur Windows la
// racine de l'install locale (contient documents/, logs, php-errors.log, state.json) et
// le htdocs Dolibarr (custom/, core/, conf/…), utiles pour diagnostiquer une page blanche.
async function openLocalFolders(): Promise<void> {
    if (!isLocalPackPresent()) {
        if (mainWindow) {
            await dialog.showMessageBox(mainWindow, {
                type: 'warning',
                title: 'Dossiers locaux',
                message: 'La caisse locale n\'est pas installée.',
                detail: 'Aucun dossier Dolibarr local à ouvrir pour le moment.',
            })
        }
        return
    }
    const folders = getLocalFolders()
    await shell.openPath(folders.root)
    await shell.openPath(folders.htdocs)
}

// ─── Ecran de transition « retour en ligne » ────────────────────────────────
// Fenetre enfant qui recouvre la fenetre principale pendant qu'on coupe la caisse
// locale et qu'on recharge le cloud, jusqu'a ce que la page distante soit prete.
let cloudLoaderWindow: BrowserWindow | null = null

function syncCloudLoaderBounds(): void {
    if (!mainWindow || !cloudLoaderWindow || cloudLoaderWindow.isDestroyed()) return
    cloudLoaderWindow.setBounds(mainWindow.getContentBounds())
}

function showCloudLoader(): void {
    if (!mainWindow || mainWindow.isDestroyed()) return
    const html = progressHtml({
        title: 'Mode <span class="accent">en ligne</span>',
        subtitle: 'Reconnexion à votre caisse Cieloo',
        message: 'On vous rebranche au cloud… ⚡',
        mode: 'cloud',
    })
    if (!cloudLoaderWindow || cloudLoaderWindow.isDestroyed()) {
        cloudLoaderWindow = new BrowserWindow({
            parent: mainWindow,
            show: false,
            frame: false,
            resizable: false,
            movable: false,
            minimizable: false,
            maximizable: false,
            closable: false,
            skipTaskbar: true,
            hasShadow: false,
            backgroundColor: '#121b35',
            webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, spellcheck: false },
        })
        cloudLoaderWindow.setMenuBarVisibility(false)
        cloudLoaderWindow.on('closed', () => { cloudLoaderWindow = null })
    }
    syncCloudLoaderBounds()
    void cloudLoaderWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`)
    cloudLoaderWindow.showInactive()
    cloudLoaderWindow.moveTop()
}

function hideCloudLoader(): void {
    if (cloudLoaderWindow && !cloudLoaderWindow.isDestroyed()) cloudLoaderWindow.destroy()
    cloudLoaderWindow = null
}

// Retour au mode en ligne (cloud) : on affiche l'ecran de chargement et on le garde
// jusqu'a ce que la page cloud (ou la page hors-ligne de secours) ait fini de charger.
async function switchToCloud(): Promise<void> {
    writeConfig({ ...readConfig(), localActive: false })
    buildMenu()
    showCloudLoader()
    await stopLocalDolibarr()

    if (mainWindow && !mainWindow.isDestroyed()) {
        const wc = mainWindow.webContents
        let settled = false
        const dismiss = (): void => {
            if (settled) return
            settled = true
            clearTimeout(safety)
            wc.off('did-finish-load', dismiss)
            hideCloudLoader()
        }
        // did-finish-load couvre le succes ET le repli hors-ligne (offline.html charge
        // par le handler did-fail-load declenche lui aussi un did-finish-load).
        const safety = setTimeout(dismiss, 20000)
        wc.once('did-finish-load', dismiss)
    }

    loadCloudContent()
}

// Fenetre « Statut du serveur » : etat des serveurs PHP/Dolibarr + MariaDB, ports,
// URL, identifiants base, avec actions (ouvrir le POS / l'explorateur de base dans
// le navigateur, dossier des logs, copier les identifiants…).
function showLocalServerStatus(): void {
    if (localStatusWindow && !localStatusWindow.isDestroyed()) {
        localStatusWindow.webContents.send('local-status:refresh')
        localStatusWindow.focus()
        return
    }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? mainWindow ?? undefined

    localStatusWindow = new BrowserWindow({
        width: 640,
        height: 760,
        useContentSize: true,
        icon: resolveAppIcon(),
        title: 'Statut du serveur — Caisse locale',
        backgroundColor: '#f4f6fb',
        show: false,
        resizable: false,
        parent: parentWindow,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    localStatusWindow.setMenu(null)
    localStatusWindow.once('ready-to-show', () => localStatusWindow?.show())
    localStatusWindow.on('closed', () => { localStatusWindow = null })

    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void localStatusWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/local-status.html`)
    } else {
        void localStatusWindow.loadFile(path.join(__dirname, '../renderer/local-status.html'))
    }
}

// Desinstalle la caisse locale (apres confirmation) et revient au cloud.
async function uninstallLocal(): Promise<void> {
    if (!mainWindow) return
    const res = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Désinstaller', 'Annuler'],
        defaultId: 1,
        cancelId: 1,
        title: 'Caisse Locale',
        message: 'Désinstaller la caisse locale ?',
        detail: 'Le serveur local, sa base de données et toutes les données encaissées en local seront définitivement supprimés de ce poste. Cette action est irréversible.',
    })
    if (res.response !== 0) return

    // Si on est en local, repasse au cloud d'abord.
    if (readConfig().localActive) {
        writeConfig({ ...readConfig(), localActive: false })
        loadCloudContent()
    }
    try {
        showLocalBusy('uninstall', 'Désinstallation de la caisse locale', 'Désinstallation de la caisse locale…')
        await uninstallLocalDolibarr()
        writeConfig({ ...readConfig(), localActive: false, localEnabled: false })
        loadCloudContent()
        buildMenu()
        dialog.showMessageBox(mainWindow, { type: 'info', title: 'Caisse Locale', message: 'La caisse locale a été désinstallée.' })
    } catch (err) {
        dialog.showErrorBox('Caisse Locale', `Échec de la désinstallation :\n${String(err)}`)
        loadCloudContent()
        buildMenu()
    }
}

// Efface la config locale (base, install Dolibarr, etat) en gardant le pack telecharge.
// La prochaine bascule en caisse locale relance une installation Dolibarr vierge.
async function resetLocalConfig(): Promise<void> {
    if (!mainWindow) return
    const res = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        buttons: ['Effacer', 'Annuler'],
        defaultId: 1,
        cancelId: 1,
        title: 'Caisse Locale',
        message: 'Effacer la configuration locale ?',
        detail: 'La base de données, la configuration Dolibarr et toutes les données encaissées en local seront définitivement supprimées. '
            + 'Le pack local (PHP/MariaDB/Dolibarr) est conservé : la prochaine bascule en caisse locale relancera une installation vierge. '
            + 'Cette action est irréversible.',
    })
    if (res.response !== 0) return

    // Si on est en local, repasse au cloud d'abord (on ne peut pas effacer en cours d'usage).
    if (readConfig().localActive) {
        writeConfig({ ...readConfig(), localActive: false })
        loadCloudContent()
    }
    try {
        showLocalBusy('reset', 'Effacement de la configuration locale', 'Effacement de la configuration locale…')
        await resetLocalConfigDolibarr()
        loadCloudContent()
        buildMenu()
        dialog.showMessageBox(mainWindow, { type: 'info', title: 'Caisse Locale', message: 'La configuration locale a été effacée.' })
    } catch (err) {
        dialog.showErrorBox('Caisse Locale', `Échec de l'effacement :\n${String(err)}`)
        loadCloudContent()
        buildMenu()
    }
}

// ─── Caisse de secours hors-ligne (SPA pos-offline) ──────────────────────────
// Remplace l'ancien prototype « Dolibarr local complet » : bundle statique +
// snapshot JSON (produits, catégories, clients, dernières ventes) rafraîchi en
// tâche de fond tant que le réseau est là. Bascule instantanée, zéro serveur.

// URL de base de l'instance cloud (avec schéma), pour appeler l'API du module.
function cloudBaseUrl(): string | null {
    const cfg = readConfig()
    if (!cfg.instance) return null
    if (cfg.freeInstance) return cfg.instance
    return `https://${cfg.instance}.cieloo.io`
}

async function switchToOfflinePos(): Promise<void> {
    if (!mainWindow || mainWindow.isDestroyed()) return
    if (!isOfflinePosBundlePresent()) {
        await dialog.showMessageBox(mainWindow, {
            type: 'error',
            title: 'Caisse Locale',
            message: 'Le bundle pos-offline est introuvable.',
            detail: 'Lancez « npm run build » dans pos-offline/ (dev) ou réinstallez l\'application.',
        })
        return
    }

    showTransitionSplash('Passage en mode local', 'Préparation de la caisse hors-ligne…')

    // Best-effort : on tente un snapshot tout frais si le cloud répond encore.
    // En cas d'échec (wifi coupée : le cas nominal), le dernier snapshot suffit.
    const base = cloudBaseUrl()
    if (base) {
        try { await fetchOfflineSnapshot(base) }
        catch (err) { console.warn('[offline-pos] snapshot frais impossible, on garde le dernier :', (err as Error).message) }
    }

    if (!hasOfflineSnapshot()) {
        loadCloudContent() // le splash a remplacé l'affichage : il faut revenir sur quelque chose
        await dialog.showMessageBox(mainWindow, {
            type: 'warning',
            title: 'Caisse Locale',
            message: 'Aucun snapshot de la base n\'est disponible sur cette machine.',
            detail: 'La caisse doit avoir été connectée au POS au moins une fois avec du réseau '
                + 'pour que le snapshot (produits, catégories, clients…) soit téléchargé.',
        })
        return
    }

    writeConfig({ ...readConfig(), offlinePosActive: true, offlinePosSince: Date.now() })
    buildMenu()
    await mainWindow.loadFile(offlinePosIndexHtml())
}

// La caisse s'ouvre TOUJOURS directement sur le POS (index.php du module),
// jamais sur la racine Dolibarr. Si l'utilisateur n'est pas connecté, Dolibarr
// affiche le login puis redirige vers cette URL.
function cloudPosUrl(base: string): string {
    return `${base.replace(/\/$/, '')}/custom/cieloopos/index.php`
}

async function returnFromOfflinePos(): Promise<void> {
    writeConfig({ ...readConfig(), offlinePosActive: false, offlinePosSince: undefined })
    buildMenu()

    // Synchro auto désactivée par défaut (menu Caisse Locale → Config) : pour
    // l'instant, seul le bouton "Téléverser" du ticket transmet une vente.
    // Le splash de retour en ligne sert d'écran de synchro des ventes locales
    // en attente — best-effort : un échec réseau ne bloque jamais le retour
    // en ligne, les ventes restent en attente et se re-tentent plus tard.
    const base = cloudBaseUrl()
    if (base && readConfig().offlinePosAutoSync === true) {
        showTransitionSplash('Retour en ligne', 'Synchronisation des ventes locales…')
        try {
            const report = await syncAllOfflinePendingSales(base, (done, total) => {
                updateTransitionSplash(`${done} / ${total} vente(s) synchronisée(s)`, total > 0 ? (done / total) * 100 : 100)
            })
            if (report.total > 0) {
                updateTransitionSplash(
                    report.failed > 0
                        ? `${report.synced}/${report.total} synchronisées, ${report.failed} en attente`
                        : `${report.synced} vente(s) synchronisée(s)`,
                    100
                )
                await new Promise((r) => setTimeout(r, report.failed > 0 ? 1800 : 900))
            }
        } catch (err) {
            console.warn('[offline-pos] synchro des ventes locales échouée :', (err as Error).message)
        }
    }

    loadCloudContent()
}

/** Menu Caisse Locale → Config → coche/décoche la synchro auto des ventes au retour en ligne. */
function toggleOfflinePosAutoSync(): void {
    writeConfig({ ...readConfig(), offlinePosAutoSync: readConfig().offlinePosAutoSync !== true })
    buildMenu()
}

// Action « Mettre à jour le snapshot » du menu : fetch immédiat + toast de résultat.
async function refreshOfflineSnapshotNow(): Promise<void> {
    if (!mainWindow) return
    const base = cloudBaseUrl()
    if (!base) {
        showToast({ kind: 'error', title: 'Caisse Locale', message: 'Aucune instance Cieloo configurée.' })
        return
    }
    showToast({ kind: 'info', title: 'Synchronisation…', message: 'Mise à jour du snapshot en cours', duration: 0 })
    try {
        const meta = await fetchOfflineSnapshot(base)
        showToast({
            kind: 'success',
            title: 'Snapshot mis à jour',
            message: `${meta.products} produits, ${meta.categories} catégories, ${meta.customers} clients, `
                + `${meta.sales} ventes récentes (${Math.round(meta.bytes / 1024)} ko)`,
        })
    } catch (err) {
        showToast({
            kind: 'error',
            title: 'Échec de la mise à jour du snapshot',
            message: `${(err as Error).message} — session POS active et réseau requis.`,
            duration: 6000,
        })
    }
}

// Throttle : le téléchargement des images progresse par petits paquets ;
// sans throttle, des dizaines de loadURL par seconde saturent le process.
function throttleToastProgress(fn: (done: number, total: number) => void, everyMs: number): (done: number, total: number) => void {
    let last = 0
    return (done, total) => {
        const now = Date.now()
        if (now - last >= everyMs || done === total) {
            last = now
            fn(done, total)
        }
    }
}

// Action « Télécharger les images » du menu : purge les marqueurs « sans photo »
// (pour tout re-vérifier), lance la synchro avec toast de progression, puis
// toast de résultat final.
async function syncOfflineImagesNow(): Promise<void> {
    if (!mainWindow) return
    const base = cloudBaseUrl()
    if (!base) {
        showToast({ kind: 'error', title: 'Caisse Locale', message: 'Aucune instance Cieloo configurée.' })
        return
    }
    clearOfflineImageMissMarkers()
    showToast({ kind: 'info', title: 'Téléchargement des images…', message: 'Préparation…', progress: 0, duration: 0 })

    const onProgress = throttleToastProgress((done, total) => {
        showToast({
            kind: 'info',
            title: 'Téléchargement des images…',
            message: `${done} / ${total} vérifiée(s)`,
            progress: total > 0 ? Math.round((done / total) * 100) : 100,
            duration: 0,
        })
    }, 200)

    const report = await syncOfflineImages(base, onProgress)

    if (report.checked === 0) {
        showToast({ kind: 'success', title: 'Images déjà à jour', message: 'Aucune nouvelle image à télécharger.' })
        return
    }
    const parts = [`${report.downloaded} téléchargée(s)`, `${report.withoutPhoto} sans photo`, `${report.alreadyCached} déjà en cache`]
    if (report.errors > 0) parts.push(`${report.errors} erreur(s)`)
    showToast({
        kind: report.errors > 0 && report.downloaded === 0 ? 'error' : 'success',
        title: report.errors > 0 && report.downloaded === 0 ? 'Échec du téléchargement des images' : 'Images synchronisées',
        message: parts.join(' · ') + (report.firstError ? ` — ${report.firstError}` : ''),
        duration: report.errors > 0 ? 6500 : 4000,
    })
}

// ─── Main window ──────────────────────────────────────────────────────────────

// Point d'entree unique : route vers la caisse hors-ligne, la caisse locale
// (ancien prototype) ou le cloud selon la config.
function loadContent(): void {
    const config = readConfig()
    if (config.offlinePosActive && isOfflinePosBundlePresent() && hasOfflineSnapshot()) {
        void mainWindow?.loadFile(offlinePosIndexHtml())
        return
    }
    if (config.localActive && isLocalPackPresent()) {
        void loadLocalContent()
        return
    }
    loadCloudContent()
}

function loadCloudContent(): void {
    if (!mainWindow) return
    const config = readConfig()

    if (config.instance) {
        if (config.freeInstance) {
            void mainWindow.loadURL(cloudPosUrl(config.instance))
        } else {
            void mainWindow.loadURL(cloudPosUrl(`https://${config.instance}.cieloo.io`))
        }
        return
    }

    const suggested = detectBootstrapInstance()
    if (suggested) {
        writeConfig({ ...config, instance: suggested.instance })
        void mainWindow.loadURL(cloudPosUrl(`https://${suggested.instance}.cieloo.io`))
        return
    } else if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
        void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
}

function createMainWindow(): void {
    const display = screen.getPrimaryDisplay()
    const workArea = display.workAreaSize
    const initialWidth = Math.min(1400, workArea.width)
    const initialHeight = Math.min(900, workArea.height)
    const minWidth = Math.min(1100, workArea.width)
    const minHeight = Math.min(700, workArea.height)

    const mainWindowOptions: Electron.BrowserWindowConstructorOptions = {
        width: initialWidth,
        height: initialHeight,
        minWidth,
        minHeight,
        show: false,
        icon: resolveAppIcon(),
        backgroundColor: '#ffffff',
        title: 'CielooPos',
        webPreferences: {
            session: session.defaultSession,
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false,
        }
    }

    mainWindow = new BrowserWindow(mainWindowOptions)

    enforceStableWebViewRendering(mainWindow.webContents)

    let bootSettingsApplied = false
    let showFallbackTimer: NodeJS.Timeout | null = null

    const syncSecondScreenWhenMainIsVisible = (forceReload = false): void => {
        if (!mainWindow || mainWindow.isDestroyed() || !mainWindow.isVisible()) return
        const secondScreenUrl = resolveSecondScreenUrl()
        if (secondScreenUrl) syncSecondScreen(secondScreenUrl, { forceReload })
    }

    const showMainWindow = (): void => {
        if (!mainWindow || mainWindow.isDestroyed()) return
        if (showFallbackTimer) {
            clearTimeout(showFallbackTimer)
            showFallbackTimer = null
        }

        if (!mainWindow.isVisible()) mainWindow.show()

        if (!bootSettingsApplied) {
            bootSettingsApplied = true
            applyBootSettings(mainWindow)
        }

        flushPendingLoadingOverlay()
        syncSecondScreenWhenMainIsVisible()
    }

    mainWindow.once('ready-to-show', () => {
        showMainWindow()
    })

    showFallbackTimer = setTimeout(showMainWindow, 2500)

    mainWindow.on('move', syncLoadingOverlayBounds)
    mainWindow.on('resize', syncLoadingOverlayBounds)
    mainWindow.on('enter-full-screen', syncLoadingOverlayBounds)
    mainWindow.on('leave-full-screen', syncLoadingOverlayBounds)
    mainWindow.on('show', flushPendingLoadingOverlay)
    mainWindow.on('restore', flushPendingLoadingOverlay)
    mainWindow.on('minimize', hideLoadingOverlayImmediate)
    mainWindow.on('hide', hideLoadingOverlayImmediate)
    mainWindow.on('move', syncToastBounds)
    mainWindow.on('resize', syncToastBounds)
    mainWindow.on('enter-full-screen', syncToastBounds)
    mainWindow.on('leave-full-screen', syncToastBounds)
    mainWindow.on('minimize', hideToastImmediate)
    mainWindow.on('hide', hideToastImmediate)
    // Fermer la fenêtre principale = quitter la caisse : second écran, fenêtres de
    // réglages et services annexes sont fermés dans la foulée.
    mainWindow.on('close', () => shutdownApp(mainWindow))
    mainWindow.on('closed', () => {
        if (showFallbackTimer) {
            clearTimeout(showFallbackTimer)
            showFallbackTimer = null
        }
        loadingOverlayPending = false
        if (loadingOverlayHideTimer) {
            clearTimeout(loadingOverlayHideTimer)
            loadingOverlayHideTimer = null
        }
        if (loadingOverlayWindow && !loadingOverlayWindow.isDestroyed()) loadingOverlayWindow.close()
        loadingOverlayWindow = null
        if (toastHideTimer) {
            clearTimeout(toastHideTimer)
            toastHideTimer = null
        }
        if (toastWindow && !toastWindow.isDestroyed()) toastWindow.close()
        toastWindow = null
    })

    mainWindow.webContents.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
    lockNavigation(mainWindow.webContents)

    // ── Impression silencieuse des tickets thermiques ─────────────────────────
    // did-frame-navigate se déclenche quand la navigation est committée dans le
    // renderer, AVANT le parsing HTML → on injecte window.print() override avant
    // que PrintTicket() soit appelé par le script inline de receipt_designer.php.
    mainWindow.webContents.on('did-frame-navigate', (_event, url, _code, _text, isMainFrame, frameProcessId, frameRoutingId) => {
        if (isMainFrame || !url.includes('receipt_designer')) return

        const findFrame = (root: Electron.WebFrameMain): Electron.WebFrameMain | undefined => {
            if (root.processId === frameProcessId && root.routingId === frameRoutingId) return root
            for (const child of root.frames) {
                const found = findFrame(child)
                if (found) return found
            }
            return undefined
        }

        const frame = mainWindow ? findFrame(mainWindow.webContents.mainFrame) : undefined
        frame?.executeJavaScript(`(function(){
if(window.__cp__)return;window.__cp__=1;
var _o=window.print.bind(window);
window.print=function(){
  fetch('http://127.0.0.1:9100/print-window',{
    method:'POST',
    headers:{'Content-Type':'application/json'},
    body:JSON.stringify({url:window.location.href})
  }).catch(function(){_o();}).finally(function(){
    window.dispatchEvent(new Event('afterprint'));
  });
};
})()`).catch(() => { })
    })

    // Loading indicator — taskbar progress bar only (no title pollution)
    mainWindow.webContents.on('did-start-loading', () => {
        mainWindow?.setProgressBar(2, { mode: 'indeterminate' })
        showLoadingOverlay()
    })
    mainWindow.webContents.on('did-stop-loading', () => {
        mainWindow?.setProgressBar(-1)
        hideLoadingOverlay()
    })

    // Keep rendering stable on POS displays (fixed zoom + anti horizontal overflow).
    mainWindow.webContents.on('did-finish-load', () => {
        if (!mainWindow) return
        const currentUrl = mainWindow.webContents.getURL()
        showMainWindow()
        enforceStableWebViewRendering(mainWindow.webContents)
        injectRuntimeCss(mainWindow.webContents, currentUrl)
        syncSecondScreenWhenMainIsVisible(true)
        if (isCielooUrl(currentUrl) || isFreeInstanceUrl(currentUrl)) {
            void mainWindow.webContents.executeJavaScript(CUSTOMER_DISPLAY_CART_HOOK)
        }
    })

    mainWindow.webContents.on('did-navigate', (_e, url) => {
        if (!mainWindow) return
        enforceStableWebViewRendering(mainWindow.webContents)
        injectRuntimeCss(mainWindow.webContents, url)
        // Track last known good cieloo URL for offline recovery
        if (isCielooUrl(url) || isFreeInstanceUrl(url)) lastCielooUrl = url
        syncSecondScreenWhenMainIsVisible()
        if (isDev || loadSettings().devMode) buildMenu() // refresh Dev > URL label
    })

    mainWindow.webContents.on('did-navigate-in-page', (_e, url) => {
        if (!mainWindow) return
        enforceStableWebViewRendering(mainWindow.webContents)
        injectRuntimeCss(mainWindow.webContents, url)
        if (isCielooUrl(url) || isFreeInstanceUrl(url)) lastCielooUrl = url
        syncSecondScreenWhenMainIsVisible()
        if (isDev || loadSettings().devMode) buildMenu() // refresh Dev > URL label
    })

    // Some pages use HTML5 fullscreen (requestFullscreen). On small POS displays,
    // we mirror it to native window fullscreen to avoid right-side clipping.
    mainWindow.webContents.on('enter-html-full-screen', () => {
        if (!mainWindow) return
        if (mainWindow.isFullScreen()) return
        forcedWindowFullscreenForHtml = true
        mainWindow.setFullScreen(true)
    })

    mainWindow.webContents.on('leave-html-full-screen', () => {
        if (!mainWindow) return
        if (!forcedWindowFullscreenForHtml) return
        forcedWindowFullscreenForHtml = false
        if (!loadSettings().fullscreen) mainWindow.setFullScreen(false)
    })

    // ── Offline: intercept renderer-initiated navigation while offline ─────────
    // Fires for location.href changes, form submits, location.reload(), etc.
    // Prevents the PHP page from being destroyed when network is lost.
    mainWindow.webContents.on('will-navigate', (event, url) => {
        if (!isCielooUrl(url)) return
        if (net.isOnline()) return
        event.preventDefault()
        mainWindow?.webContents.send('net:offline')
    })

    // ── Offline: fallback when navigation already started and failed ───────────
    // At this point the PHP page is gone — load a nice local offline page
    // instead of leaving the window blank.
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, desc, url, isMainFrame) => {
        if (!isMainFrame) return
        if (errorCode === -3) return   // ERR_ABORTED : navigation interrompue normale, on ignore
        const isAppUrl = isCielooUrl(url) || /^https?:\/\/(127\.0\.0\.1|localhost)/i.test(url)
        if (!isAppUrl) return
        // Vraie perte de connectivité → page hors-ligne. Sinon → page d'erreur détaillée.
        if (OFFLINE_CODES.has(errorCode)) {
            showMainWindow()
            loadOfflinePage()
        } else if (NET_ERROR_CODES.has(errorCode)) {
            showErrorPage({
                title: 'Connexion au serveur impossible',
                message: netErrorMessage(errorCode),
                detail: `${desc ? desc + '\n' : ''}${url}`,
                code: errorCode,
            })
        }
    })

    // Au lancement, on démarre en mode en ligne (cloud) par défaut ; l'utilisateur
    // bascule ensuite manuellement en caisse locale via le menu.
    // Exception : en Mode Full Local (caisse 100% locale), on redémarre directement
    // sur le Dolibarr local, sans instance Cieloo ni synchronisation cloud.
    if (readConfig().fullLocal === true && isLocalPackPresent()) {
        writeConfig({ ...readConfig(), localActive: true })
    } else {
        writeConfig({ ...readConfig(), localActive: false })
    }
    loadContent()
}

// Apply navigation lock + new-window handler to any popup Electron creates
app.on('web-contents-created', (_e, wc) => {
    lockNavigation(wc)
    wc.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
    enforceStableWebViewRendering(wc)

    wc.on('did-finish-load', () => {
        const currentUrl = wc.getURL()
        enforceStableWebViewRendering(wc)
        injectRuntimeCss(wc, currentUrl)
    })

    wc.on('did-navigate', (_evt, url) => {
        enforceStableWebViewRendering(wc)
        injectRuntimeCss(wc, url)
    })

    wc.on('did-navigate-in-page', (_evt, url) => {
        enforceStableWebViewRendering(wc)
        injectRuntimeCss(wc, url)
    })
})

// ─── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc(): void {
    ipcMain.handle('config:get', () => readConfig())

    ipcMain.handle('config:get-bootstrap-instance', () => detectBootstrapInstance())

    // Build de démonstration : le renderer de config affiche alors le choix Cloud / Local.
    ipcMain.handle('config:is-demo', () => IS_DEMO)

    // Normalise + enregistre l'instance saisie au 1er lancement. Renvoie le nom nettoyé.
    function saveInstanceFromInput(instance: string): string {
        const existing = readConfig()
        if (existing.freeInstance) {
            let href: string
            try { href = new URL(instance).href } catch { throw new Error('URL d\'instance invalide') }
            writeConfig({ ...existing, instance: href })
            return href
        }
        const clean = normalizeInstance(instance)
        if (!clean) throw new Error('Nom d\'instance invalide')
        writeConfig({ ...existing, instance: clean })
        return clean
    }

    // Setup 1er lancement (build démo) : enregistre l'instance puis démarre en Cloud ou
    // en Mode Full Local selon le choix de l'utilisateur.
    ipcMain.handle('config:setup', async (_e, instance: string, mode: 'cloud' | 'local') => {
        const saved = saveInstanceFromInput(instance)

        if (mode === 'local') {
            // Caisse 100% locale : on garde le nom d'instance saisi (identification
            // dashboard + duplication ci-dessous), sans synchro cloud automatique ensuite.
            writeConfig({ ...readConfig(), fullLocal: true })
            buildMenu()
            void reportRustDeskHeartbeat()

            // Installe le pack au besoin SANS charger un POS vierge (évite la page blanche).
            if (!isLocalPackPresent()) {
                const installed = await installLocalPack(false)   // page d'erreur déjà gérée si échec
                if (!installed) return
            }
            writeConfig({ ...readConfig(), localActive: true })
            buildMenu()

            // Puis on duplique automatiquement la base (+ fichiers du site) de l'instance
            // saisie : sans ça, la caisse locale démarrerait sur une base Dolibarr vierge
            // (modules absents → pages blanches type /custom/cieloopos/index.php).
            const instUrl = currentInstanceUrl()
            if (instUrl) await runDuplicateBase(instUrl)
            else await loadLocalContent()
            return
        }

        // Mode Cloud (défaut)
        writeConfig({ ...readConfig(), fullLocal: false })
        void reportRustDeskHeartbeat()
        if (readConfig().freeInstance) void mainWindow?.loadURL(saved)
        else void mainWindow?.loadURL(`https://${saved}.cieloo.io`)
    })

    ipcMain.handle('config:save-instance', (_e, instance: string) => {
        const existing = readConfig()
        if (existing.freeInstance) {
            try {
                const url = new URL(instance)
                writeConfig({ ...existing, instance: url.href })
                void mainWindow?.loadURL(url.href)
            } catch {
                throw new Error('URL d\'instance invalide')
            }
        } else {
            const clean = normalizeInstance(instance)
            if (!clean) throw new Error('Nom d\'instance invalide')
            writeConfig({ ...existing, instance: clean })
            void mainWindow?.loadURL(`https://${clean}.cieloo.io`)
        }
        // Heartbeat immédiat après configuration de l'instance
        void reportRustDeskHeartbeat()
    })

    ipcMain.handle('local:status', () => getLocalStatus())
    ipcMain.handle('local:switch', (_e, target: 'local' | 'cloud') =>
        target === 'local' ? switchToLocal() : switchToCloud())

    ipcMain.handle('config:toggle-free-instance', () => {
        const config = readConfig()
        const newState = !config.freeInstance
        writeConfig({ ...config, freeInstance: newState })
        return newState
    })

    ipcMain.handle('config:clear', () => {
        const config = readConfig()
        writeConfig(config.freeInstance ? { freeInstance: true } : {})
        if (isDev && process.env.ELECTRON_RENDERER_URL) {
            void mainWindow?.loadURL(process.env.ELECTRON_RENDERER_URL)
        } else {
            void mainWindow?.loadFile(path.join(__dirname, '../renderer/index.html'))
        }
        mainWindow?.show()
        mainWindow?.focus()
    })

    // Config caisse locale : mode de l'ecran de chargement (prod / dev / debug).
    ipcMain.handle('local:get-loader-mode', (): LoaderMode => getLoaderMode())
    ipcMain.handle('local:set-loader-mode', (_e, mode: LoaderMode) => {
        setLoaderMode(mode === 'dev' || mode === 'debug' ? mode : 'prod')
        return getLoaderMode()
    })

    // Fenetre « Config » → onglet Pack & serveur : état du pack, chemin, source, URL.
    ipcMain.handle('local:get-pack-info', async () => {
        const dbg = getLocalDebugInfo()
        const configuredUrl = process.env.LOCAL_PACK_URL || null
        const usingDashboard = !localPackUrlUsable(configuredUrl ?? undefined)
        let cloud: { version: string; size: number } | null = null
        let cloudError: string | null = null
        try {
            const latest = await fetchLatestPack(DASHBOARD_API_URL)
            cloud = { version: latest.version, size: latest.size }
        } catch (e) { cloudError = (e as Error).message }
        const base = DASHBOARD_API_URL.replace(/\/$/, '')
        const effectiveUrl = !usingDashboard
            ? configuredUrl
            : cloud ? `${base}/api/packs/${encodeURIComponent(cloud.version)}/download` : null
        return {
            present: dbg.packPresent,
            version: dbg.packVersion,
            paths: dbg.paths,
            baseUrl: dbg.baseUrl,
            dbAdminUrl: getDbAdminUrl(),
            configuredUrl,
            usingDashboard,
            effectiveUrl,
            cloud,
            cloudError,
        }
    })

    // Fenetre « Statut du serveur » : infos + actions.
    ipcMain.handle('local:get-debug-info', () => ({ ...getLocalDebugInfo(), dbAdminUrl: getDbAdminUrl() }))
    ipcMain.handle('local:open-external', (_e, url: string) => {
        if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?(\/|$)/i.test(url)) void shell.openExternal(url)
    })
    ipcMain.handle('local:open-path', (_e, target: string) => { void shell.openPath(target) })
    ipcMain.handle('local:copy', (_e, text: string) => clipboard.writeText(text))
    ipcMain.handle('local:open-db-admin', () => {
        const url = getDbAdminUrl()
        if (url) void shell.openExternal(url)
        return url
    })

    ipcMain.handle('dev:reset-config', () => {
        if (!isDev) return
        deleteConfig()
        loadContent()
    })

    ipcMain.handle('dev:show-offline', () => {
        if (!isDev) return
        loadOfflinePage()
    })

    // Bouton « Réessayer » de la page d'erreur → recharge le mode courant (local/cloud).
    ipcMain.handle('error:retry', () => { loadContent() })

    registerAutoLoginIpc()
    registerSettingsIpc(isDev, process.env.ELECTRON_RENDERER_URL, () => mainWindow)
    registerCustomerDisplayIpc()
    registerBalanceIpc(buildMenu)
    ipcMain.handle('balance:open-settings', () => openBalanceSettingsWindow())
    onRebuildMenu(buildMenu)

    // ── Impression (CielooPrint local server) ───────────────────────────────
    ipcMain.handle('print:get-printers', async () => {
        return getSystemPrinters(mainWindow)
    })

    ipcMain.handle('print:get-config', () => {
        return loadSettings().print
    })

    ipcMain.handle('print:get-status', () => {
        return getPrintServerStatus()
    })

    ipcMain.handle('print:save-config', async (_e, payload: Partial<PrintSettings>) => {
        const updated = setPrintSettings(payload)
        const status = await applyPrintSettings(updated.print)
        mainWindow?.webContents.send('print:config-updated')
        return { config: updated.print, status }
    })

    ipcMain.handle('print:printer-check', async () => {
        const settings = loadSettings()
        const printerList = settings.print.printers

        const configured = printerList.some(p => p.defaultPrinter !== null)
        if (!configured) return { configured: false, connected: false }

        let connected = false
        try {
            const PRINTER_STATUS_OFFLINE = 0x80
            const sysPrinters = mainWindow && !mainWindow.isDestroyed()
                ? await mainWindow.webContents.getPrintersAsync()
                : (await getSystemPrinters(null)).map(p => ({ name: p.name, status: 0 }))

            connected = printerList.some(cp => {
                if (!cp.defaultPrinter) return false
                const match = sysPrinters.find(p => p.name === cp.defaultPrinter)
                return match !== undefined && (match.status & PRINTER_STATUS_OFFLINE) === 0
            })
        } catch {
            connected = printerList.some(p => p.defaultPrinter !== null)
        }

        return { configured, connected }
    })

    ipcMain.handle('print:print-test', async (_e, config) => {
        try {
            await printTestPage(config)
            return { success: true }
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : 'Erreur inconnue' }
        }
    })

    ipcMain.handle('print:print-barcode-test', async (_e, config, mode: BarcodeTestMode) => {
        try {
            await printBarcodeTestPage(config, mode === 'sheet' ? 'sheet' : 'label')
            return { success: true }
        } catch (error) {
            return { success: false, message: error instanceof Error ? error.message : 'Erreur inconnue' }
        }
    })

    ipcMain.handle('print:open-settings', () => openPrintSettingsWindow())

    ipcMain.handle('print:open-barcode-settings', () => openBarcodeSettingsWindow())

    // Téléchargement d'un driver d'imprimante depuis une URL (ouvre le navigateur → DL)
    ipcMain.handle('print:download-driver', async (_e, url: string) => {
        if (typeof url !== 'string' || !/^https:\/\//i.test(url)) {
            return { launched: false, reason: 'invalid_url' }
        }
        try {
            await shell.openExternal(url)
            return { launched: true }
        } catch (error) {
            return { launched: false, reason: error instanceof Error ? error.message : 'error' }
        }
    })

    ipcMain.handle('print:open-printer-properties', (_e, printerName: string) => {
        if (!printerName) return
        const { execFile } = require('node:child_process') as typeof import('node:child_process')
        execFile('rundll32.exe', ['printui.dll,PrintUIEntry', '/p', '/n', printerName])
    })

    ipcMain.handle('print:open-printer-options', (_e, printerName: string) => {
        if (!printerName) return
        const { execFile } = require('node:child_process') as typeof import('node:child_process')
        execFile('rundll32.exe', ['printui.dll,PrintUIEntry', '/e', '/n', printerName])
    })

    ipcMain.handle('print:install-driver', async () => {
        const base = app.isPackaged ? process.resourcesPath : app.getAppPath()
        const assetsDir = path.join(base, 'assets')
        let driverExe: string | null = null
        try {
            const files = fs.readdirSync(assetsDir)
            const match = files.find(f => /driver.*\.exe$/i.test(f) || /\.driver\./i.test(f))
            if (match) driverExe = path.join(assetsDir, match)
        } catch { /* assets dir not found */ }
        if (!driverExe) return { launched: false, reason: 'not_found' }
        const err = await shell.openPath(driverExe)
        return err ? { launched: false, reason: err } : { launched: true }
    })

    // ── MultiPrint API ────────────────────────────────────────────────────────

    async function multiprintCookieHeader(origin: string): Promise<string> {
        const cookies = await session.defaultSession.cookies.get({ url: origin })
        const header = cookies.map(c => `${c.name}=${c.value}`).join('; ')
        return header
    }

    ipcMain.handle('multiprint:get-sections', async (): Promise<{ sections: unknown[] | null; error?: string }> => {
        const base = resolveCielooBase()
        const origin = resolveCielooOrigin()
        if (!base || !origin) {
            return { sections: null, error: 'Instance Dolibarr non détectée' }
        }
        const url = `${base}/custom/cieloopos/api/multiprint_api.php`
        const cookieHeader = await multiprintCookieHeader(origin)
        return new Promise((resolve) => {
            const req = net.request({ method: 'GET', url })
            if (cookieHeader) req.setHeader('Cookie', cookieHeader)
            let body = ''
            req.on('response', (res) => {
                res.on('data', (chunk) => { body += chunk.toString() })
                res.on('end', () => {
                    try {
                        const parsed = JSON.parse(body) as { sections?: unknown[] }
                        if (res.statusCode !== 200) {
                            resolve({ sections: null, error: `Erreur API HTTP ${res.statusCode}` })
                        } else {
                            resolve({ sections: parsed.sections ?? null })
                        }
                    } catch {
                        resolve({ sections: null, error: `Réponse non-JSON (HTTP ${res.statusCode}): ${body.slice(0, 150)}` })
                    }
                })
            })
            req.on('error', (e: Error) => {
                resolve({ sections: null, error: e.message })
            })
            req.end()
        })
    })


    // ── Réseau ────────────────────────────────────────────────────────────────
    // Called by the offline page or preload to reload the last known cieloo URL
    ipcMain.handle('net:reload-last', () => {
        const url = lastCielooUrl || (() => {
            const config = readConfig()
            if (!config.instance) return null
            if (config.freeInstance) return config.instance
            return `https://${config.instance}.cieloo.io`
        })()
        if (!url) return
        void mainWindow?.loadURL(url)
    })

    // Real connectivity check from the main process (avoids false positives from
    // the renderer pinging its own local origin when on the offline fallback page).
    ipcMain.handle('net:check', (): Promise<boolean> => {
        // Quick OS-level check first
        if (!net.isOnline()) return Promise.resolve(false)

        const instance = readConfig().instance
        if (!instance) return Promise.resolve(false)

        const base = lastCielooUrl || `https://${instance}.cieloo.io`
        const checkUrl = `${base}/favicon.ico`

        return new Promise<boolean>((resolve) => {
            const req = net.request({ method: 'HEAD', url: checkUrl })
            const tid = setTimeout(() => { req.abort(); resolve(false) }, 5000)
            req.on('response', () => { clearTimeout(tid); resolve(true) })
            req.on('error', () => { clearTimeout(tid); resolve(false) })
            req.end()
        })
    })

    // ── Navigation ────────────────────────────────────────────────────────────
    ipcMain.handle('nav:go-back', () => mainWindow?.webContents.navigationHistory.goBack())
    ipcMain.handle('nav:go-forward', () => mainWindow?.webContents.navigationHistory.goForward())
    ipcMain.handle('nav:can-go-back', () => mainWindow?.webContents.navigationHistory.canGoBack() ?? false)
    ipcMain.handle('nav:can-go-forward', () => mainWindow?.webContents.navigationHistory.canGoForward() ?? false)
    ipcMain.handle('loading:is-active', (e) => e.sender.isLoadingMainFrame())

    ipcMain.handle('app:version', () => app.getVersion())
    ipcMain.handle('app:is-dev', () => isDev)

    // ── Editeur d'URL (menu Dev) ────────────────────────────────────────────────
    ipcMain.handle('dev:copy-text', (_e, text: string) => clipboard.writeText(text ?? ''))
    ipcMain.handle('dev:navigate', (_e, url: string) => {
        if (url) void mainWindow?.loadURL(url)
        if (urlEditorWindow && !urlEditorWindow.isDestroyed()) urlEditorWindow.close()
    })
    ipcMain.handle('dev:close-url-editor', () => {
        if (urlEditorWindow && !urlEditorWindow.isDestroyed()) urlEditorWindow.close()
    })

    // ── Dupliquer la base (menu Dev, Full Local) ────────────────────────────────
    ipcMain.handle('dev:duplicate-db-submit', (_e, instance: string) => {
        const r = duplicateDbResolve
        duplicateDbResolve = null                 // évite la double-résolution via 'closed'
        if (duplicateDbWindow && !duplicateDbWindow.isDestroyed()) duplicateDbWindow.close()
        r?.(instance ?? '')
    })
    ipcMain.handle('dev:duplicate-db-cancel', () => {
        if (duplicateDbWindow && !duplicateDbWindow.isDestroyed()) duplicateDbWindow.close()
    })

    const TECH_PORTS = [10004, 10006]
    type PortInfo = { port: number; pid: number | null; processName: string | null; listening: boolean }

    ipcMain.handle('tech:get-port-info', (): Promise<PortInfo[]> => {
        return new Promise((resolve) => {
            exec('netstat -ano', { windowsHide: true }, (err, stdout) => {
                const results: PortInfo[] = TECH_PORTS.map(port => ({ port, pid: null, processName: null, listening: false }))
                if (err) { resolve(results); return }

                for (const result of results) {
                    const match = stdout.match(new RegExp(`TCP\\s+[\\d.*]+:${result.port}\\s+\\S+\\s+LISTENING\\s+(\\d+)`, 'i'))
                    if (match) { result.listening = true; result.pid = parseInt(match[1]) }
                }

                const pids = results.filter(r => r.pid !== null).map(r => r.pid!)
                if (pids.length === 0) { resolve(results); return }

                const psCmd = `powershell -NoProfile -NonInteractive -Command "Get-Process -Id ${pids.join(',')} -ErrorAction SilentlyContinue | Select-Object Id,Name | ConvertTo-Json -Compress"`
                exec(psCmd, { windowsHide: true }, (_e2, out2) => {
                    try {
                        const raw = JSON.parse(out2.trim()) as unknown
                        const list: Array<{ Id: number; Name: string }> = Array.isArray(raw) ? raw as Array<{ Id: number; Name: string }> : [raw as { Id: number; Name: string }]
                        for (const result of results) {
                            const entry = list.find(p => p.Id === result.pid)
                            if (entry) result.processName = entry.Name
                        }
                    } catch { /* processName reste null */ }
                    resolve(results)
                })
            })
        })
    })

    ipcMain.handle('tech:ping-nacef', (_e, port: number): Promise<{ available: boolean; statusCode?: number; error?: string }> => {
        return new Promise((resolve) => {
            const req = http.get({ hostname: '127.0.0.1', port, path: '/', timeout: 3000 }, (res) => {
                res.resume()
                resolve({ available: true, statusCode: res.statusCode })
            })
            req.on('timeout', () => { req.destroy(); resolve({ available: false, error: 'timeout' }) })
            req.on('error', (err) => resolve({ available: false, error: err.message }))
        })
    })

    let splashClaimed = false
    ipcMain.handle('app:claim-splash', () => {
        if (splashClaimed) return false
        splashClaimed = true
        return true
    })
    ipcMain.handle('second-display:open-settings', () => {
        openSecondDisplaySettingsWindow()
    })
    ipcMain.handle('second-display:open-editor', () => {
        openSecondScreenEditorWindow()
    })
    ipcMain.handle('second-display:select-media-folder', () => {
        return selectSecondDisplayMediaFolder()
    })
    ipcMain.handle('second-display:clear-media-folder', () => {
        clearSecondDisplayMediaFolder()
    })
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

app.whenReady().then(async () => {
    // Instance déjà en cours : app.quit() est en route, on ne démarre rien.
    if (!hasSingleInstanceLock) return
    // Session Dolibarr conservée entre les relances (cookies de session → persistants).
    startSessionCookiePersistence()
    await startLocalMediaServer()
    void startPrintServer(loadSettings().print)
    startBalance({ resolveBase: resolveCielooBase, resolveOrigin: resolveCielooOrigin })
    // Statut RGI dans le menu Balance : 1ère vérif + rafraîchissement périodique.
    if (loadSettings().balance.enabled) void refreshRgiStatus()
    setInterval(() => { if (loadSettings().balance.enabled) void refreshRgiStatus() }, 12_000)

    // Mode NACEF : proxy CORS S-MDF tout de suite, réparation des routes en tâche de
    // fond (UAC ponctuelle uniquement si une route persistante manque encore).
    if (loadSettings().nacef.enabled) {
        startNacefProxy()
        void ensureNacefRoutes()
    }

    buildMenu()
    registerIpc()
    registerNacefIpc()
    registerUpdaterIpc()
    registerOfflinePosIpc({
        returnOnline: () => returnFromOfflinePos(),
        refreshBaseUrl: () => cloudBaseUrl(),
        getOfflineSince: () => readConfig().offlinePosSince ?? null,
    })
    // Snapshot hors-ligne rafraîchi en tâche de fond tant qu'on est sur le cloud
    // (session POS requise) ; suspendu en mode hors-ligne ou ancien proto local.
    startSnapshotAutoRefresh(() => {
        const cfg = readConfig()
        if (cfg.offlinePosActive === true || cfg.localActive === true) return null
        return cloudBaseUrl()
    })
    createMainWindow()
    initAutoUpdater(() => mainWindow)

    // Affiche le texte par défaut sur l'afficheur client (si activé)
    void pushIdleText()

    installRustDeskIfNeeded().then(async () => {
        // Essaie immédiatement, puis toutes les 15s jusqu'à obtenir l'ID, ensuite toutes les 60s
        let found = false
        const tryHeartbeat = async (): Promise<void> => {
            await reportRustDeskHeartbeat()
            found = !!getRustDeskId()
        }
        await tryHeartbeat()
        if (!found) {
            // Retry rapide pendant 2 minutes le temps que le service RustDesk redémarre
            const retryInterval = setInterval(async () => {
                await tryHeartbeat()
                if (found) clearInterval(retryInterval)
            }, 15_000)
            setTimeout(() => clearInterval(retryInterval), 2 * 60 * 1000)
        }
    })
    setInterval(() => void reportRustDeskHeartbeat(), 60_000)

    // Alt+Enter as secondary fullscreen shortcut (not expressible as a single menu accelerator)
    globalShortcut.register('Alt+Return', () => {
        if (mainWindow) mainWindow.setFullScreen(!mainWindow.isFullScreen())
    })

    app.on('activate', () => {
        if (BrowserWindow.getAllWindows().length === 0) createMainWindow()
    })
})

// ─── Arrêt de l'application ──────────────────────────────────────────────────
//
// Fermer la caisse doit TOUT fermer : les fenêtres annexes (second écran, réglages,
// studio d'édition, éditeur d'URL, contact…) et les process/serveurs lancés par
// l'app (tray RustDesk, Dolibarr local, serveur d'impression, proxy NACEF…).
// Sinon l'app reste vivante dans le gestionnaire de tâches (fenêtre annexe encore
// ouverte) et le verrou d'instance unique empêche de la relancer.

/** Délai max accordé à l'arrêt des services avant sortie forcée. */
const SHUTDOWN_TIMEOUT_MS = 10_000

let isShuttingDown = false
let shutdownStarted = false

/**
 * Ferme toutes les fenêtres puis demande la sortie.
 * `except` : fenêtre déjà en cours de fermeture (on la laisse finir elle-même).
 */
function shutdownApp(except?: BrowserWindow | null): void {
    if (isShuttingDown) return
    isShuttingDown = true

    // Avant la boucle : neutralise les relances auto du second écran (retry de
    // démarrage / branchement d'écran) qui rouvriraient une fenêtre après coup.
    stopSecondScreen()

    // destroy() plutôt que close() : ne peut être annulé ni par un handler
    // 'close', ni par un beforeunload de la page distante (POS Dolibarr).
    for (const win of BrowserWindow.getAllWindows()) {
        if (win === except || win.isDestroyed()) continue
        win.destroy()
    }

    app.quit()
}

/** Arrêt idempotent de tout ce que l'app a démarré (serveurs + process enfants). */
async function stopEverything(): Promise<void> {
    stopSecondScreen()   // idempotent : couvre les sorties qui ne passent pas par shutdownApp()
    globalShortcut.unregisterAll()
    stopBalance()
    stopNacefProxy()
    await Promise.allSettled([
        stopRustDeskTray(),
        stopPrintServer(),
        stopLocalMediaServer(),
        stopLocalDolibarr(),
        app.isReady() ? session.defaultSession.cookies.flushStore() : Promise.resolve(),
    ])
}

app.on('before-quit', (event) => {
    // 2e instance refusée par le verrou : elle n'a rien démarré, on la laisse sortir.
    if (!hasSingleInstanceLock) return

    isShuttingDown = true
    if (shutdownStarted) return
    shutdownStarted = true

    // On diffère la sortie le temps de couper proprement MariaDB/PHP : sans ça le
    // process Electron meurt avant et laisse mariadbd orphelin (base verrouillée au
    // prochain démarrage).
    event.preventDefault()
    void (async () => {
        try {
            await Promise.race([
                stopEverything(),
                new Promise((resolve) => setTimeout(resolve, SHUTDOWN_TIMEOUT_MS)),
            ])
        } finally {
            app.exit(0)
        }
    })()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
