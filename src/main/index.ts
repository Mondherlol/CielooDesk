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
import { startSecondScreen, syncSecondScreen } from '../modules/second-screen/main'
import { initAutoUpdater, registerUpdaterIpc } from '../modules/updater/main'

const isDev = !app.isPackaged

// ─── RustDesk / Dashboard integration ────────────────────────────────────────

const DASHBOARD_API_URL = process.env.DASHBOARD_API_URL ?? 'http://102.204.206.120'
const TERMINAL_API_KEY = process.env.TERMINAL_API_KEY ?? 'CHANGE_ME'
const RUSTDESK_CONFIG = process.env.RUSTDESK_CONFIG ?? ''
const RUSTDESK_SERVER = process.env.RUSTDESK_SERVER ?? ''
const RUSTDESK_KEY = process.env.RUSTDESK_KEY ?? ''

let _rustdeskIdCache: string | null = null

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
        spawn(exePath, ['--tray'], { detached: true, stdio: 'ignore' }).unref()
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
            spawn(exePath, ['--tray'], { detached: true, stdio: 'ignore' }).unref()
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

interface Config { instance?: string; freeInstance?: boolean }

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
let printSettingsWindow: BrowserWindow | null = null
let barcodeSettingsWindow: BrowserWindow | null = null
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

// ─── App icon ─────────────────────────────────────────────────────────────────

function resolveAppIcon(): string {
    if (app.isPackaged) {
        return path.join(process.resourcesPath, 'assets', 'img', 'favicon.ico')
    }
    return path.join(app.getAppPath(), 'assets', 'img', 'favicon.ico')
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
            click: () => app.quit()
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

    // En-tete : URL de la page (cliquer pour copier). On la tronque au milieu pour
    // ne jamais depasser la largeur du plus long autre item du menu.
    const currentPageUrl = mainWindow?.webContents.getURL() ?? ''
    const widestLabel = Math.max(
        ...devSubmenu.map(item => (typeof item.label === 'string' ? item.label.length : 0))
    )
    const maxUrlChars = Math.max(0, widestLabel - 'URL : '.length)
    const shortUrl = currentPageUrl.length > maxUrlChars && maxUrlChars > 3
        ? `${currentPageUrl.slice(0, Math.ceil((maxUrlChars - 1) / 2))}…${currentPageUrl.slice(-Math.floor((maxUrlChars - 1) / 2))}`
        : currentPageUrl
    devSubmenu.unshift(
        {
            label: currentPageUrl ? `URL : ${shortUrl}` : 'URL : (aucune page chargée)',
            enabled: false, // item passif/grise (pas un bouton)
            toolTip: currentPageUrl || undefined, // URL complete au survol
        },
        { type: 'separator' }
    )

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        { label: 'Caisse', submenu: caisseSubmenu },
        { label: 'Navigation', submenu: navigationSubmenu },
        { label: 'Affichage', submenu: affichageSubmenu },
        { label: 'Paramètres', submenu: paramsSubmenu },
        { label: 'Support', submenu: supportSubmenu }
    ]

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

    const win = new BrowserWindow({
        width: 1280,
        height: 820,
        minWidth: 900,
        minHeight: 600,
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

    win.webContents.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
    lockNavigation(win.webContents)
    win.once('ready-to-show', () => win.show())
    void win.loadURL(`${base}${pathname}`)
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
    return url.startsWith('file://') || url.startsWith('http://localhost:')
}

function isExternalContactLink(url: string): boolean {
    return url.startsWith('mailto:') || url.startsWith('tel:')
}

// Enforce navigation lock on any webContents (main + popups)
function lockNavigation(wc: Electron.WebContents): void {
    wc.on('will-navigate', (event, url) => {
        if (isDev && isLocalUrl(url)) return
        if (isExternalContactLink(url)) {
            event.preventDefault()
            void shell.openExternal(url)
            return
        }
        if (isCielooUrl(url) || isFreeInstanceUrl(url)) return
        event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
        if (isDev && isLocalUrl(url)) return
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

// ─── Main window ──────────────────────────────────────────────────────────────

function loadContent(): void {
    if (!mainWindow) return
    const config = readConfig()

    if (config.instance) {
        if (config.freeInstance) {
            void mainWindow.loadURL(config.instance)
        } else {
            void mainWindow.loadURL(`https://${config.instance}.cieloo.io`)
        }
        return
    }

    const suggested = detectBootstrapInstance()
    if (suggested) {
        writeConfig({ ...config, instance: suggested.instance })
        void mainWindow.loadURL(`https://${suggested.instance}.cieloo.io`)
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
    mainWindow.webContents.on('did-fail-load', (_e, errorCode, _desc, url, isMainFrame) => {
        if (!isMainFrame) return
        if (!isCielooUrl(url)) return
        if (!NET_ERROR_CODES.has(errorCode)) return
        showMainWindow()
        loadOfflinePage()
    })

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

    ipcMain.handle('dev:reset-config', () => {
        if (!isDev) return
        deleteConfig()
        loadContent()
    })

    ipcMain.handle('dev:show-offline', () => {
        if (!isDev) return
        loadOfflinePage()
    })

    registerAutoLoginIpc()
    registerSettingsIpc(isDev, process.env.ELECTRON_RENDERER_URL, () => mainWindow)
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
    await startLocalMediaServer()
    void startPrintServer(loadSettings().print)

    buildMenu()
    registerIpc()
    registerUpdaterIpc()
    createMainWindow()
    initAutoUpdater(() => mainWindow)

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

app.on('will-quit', () => {
    globalShortcut.unregisterAll()
    void stopPrintServer()
})

app.on('before-quit', () => {
    void stopLocalMediaServer()
})

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
