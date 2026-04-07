import { app, BrowserWindow, ipcMain, Menu, globalShortcut, net } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { registerAutoLoginIpc } from '../modules/auto-login/main'
import {
    registerSettingsIpc, applyBootSettings, openSettingsWindow,
    loadSettings, onRebuildMenu, applyHeaderTheme, setPrintSettings, type PrintSettings
} from '../modules/settings/main'
import {
    applyPrintSettings,
    getPrintServerStatus,
    getSystemPrinters,
    startPrintServer,
    stopPrintServer,
} from '../modules/print-server/main'

const isDev = !app.isPackaged

// ─── Instance config ──────────────────────────────────────────────────────────

interface Config { instance?: string }

function configPath(): string { return path.join(app.getPath('userData'), 'config.json') }

function readConfig(): Config {
    try { return JSON.parse(fs.readFileSync(configPath(), 'utf-8')) as Config }
    catch { return {} }
}

function writeConfig(c: Config): void {
    fs.writeFileSync(configPath(), JSON.stringify(c, null, 2))
}

// ─── Window ───────────────────────────────────────────────────────────────────

let mainWindow: BrowserWindow | null = null
let lastCielooUrl = ''

// Error codes that indicate a genuine network failure (not a server/app error)
const NET_ERROR_CODES = new Set([-21, -100, -101, -102, -105, -106, -109, -118, -137, -138])

function loadOfflinePage(): void {
    if (!mainWindow) return
    if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(`${process.env.ELECTRON_RENDERER_URL}/offline.html`)
    } else {
        void mainWindow.loadFile(path.join(__dirname, '../renderer/offline.html'))
    }
}
let printSettingsWindow: BrowserWindow | null = null
let loadingOverlayWindow: BrowserWindow | null = null
let loadingOverlayShownAt = 0
let loadingOverlayHideTimer: NodeJS.Timeout | null = null
let loadingOverlayPending = false

const LOADING_OVERLAY_SIZE = 54
const LOADING_OVERLAY_MARGIN = 16
const LOADING_OVERLAY_TOP_OFFSET = 52

function resolveCielooOrigin(): string | null {
    const currentUrl = mainWindow?.webContents.getURL() ?? ''
    if (isCielooUrl(currentUrl)) {
        try {
            return new URL(currentUrl).origin
        } catch {
            return null
        }
    }

    const instance = readConfig().instance
    if (!instance) return null
    return `https://${instance}.cieloo.io`
}

function openCielooPath(pathname: string): void {
    const origin = resolveCielooOrigin()
    if (!origin) return
    void mainWindow?.loadURL(`${origin}${pathname}`)
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
            label: 'Recharger la caisse',
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
        }
    ]

    if (isDev) {
        affichageSubmenu.push(
            { type: 'separator' },
            {
                label: 'Outils développeurs',
                accelerator: sc.devtools,
                click: () => mainWindow?.webContents.toggleDevTools()
            }
        )
    }

    const paramsSubmenu: Electron.MenuItemConstructorOptions[] = [
        {
            label: 'Paramètres généraux',
            click: () => openSettingsWindow(isDev, process.env.ELECTRON_RENDERER_URL)
        },
        {
            label: 'Paramètres d\'impression',
            click: () => openPrintSettingsWindow()
        }
    ]

    const menuTemplate: Electron.MenuItemConstructorOptions[] = [
        { label: 'Caisse', submenu: caisseSubmenu },
        { label: 'Navigation', submenu: navigationSubmenu },
        { label: 'Affichage', submenu: affichageSubmenu },
        { label: 'Paramètres', submenu: paramsSubmenu }
    ]

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
        title: 'Parametres d\'impression - CielooDesk',
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

// ─── URL helpers ──────────────────────────────────────────────────────────────

function isCielooUrl(url: string): boolean {
    try { return new URL(url).hostname.endsWith('.cieloo.io') } catch { return false }
}

function isLocalUrl(url: string): boolean {
    return url.startsWith('file://') || url.startsWith('http://localhost:')
}

// Enforce navigation lock on any webContents (main + popups)
function lockNavigation(wc: Electron.WebContents): void {
    wc.on('will-navigate', (event, url) => {
        if (isDev && isLocalUrl(url)) return
        if (isCielooUrl(url)) return
        event.preventDefault()
    })
    wc.on('will-redirect', (event, url) => {
        if (isDev && isLocalUrl(url)) return
        if (isCielooUrl(url)) return
        event.preventDefault()
    })
}

// ─── New-window handler ───────────────────────────────────────────────────────
// Returns the Electron handler response based on the current setting.
function handleWindowOpen(url: string): Electron.WindowOpenHandlerResponse {
    const mode = loadSettings().newWindowMode

    // Never open non-cieloo URLs
    if (!isCielooUrl(url)) return { action: 'deny' }

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
            title: 'CielooDesk',
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
        void mainWindow.loadURL(`https://${config.instance}.cieloo.io`)
    } else if (isDev && process.env.ELECTRON_RENDERER_URL) {
        void mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL)
    } else {
        void mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'))
    }
}

function createMainWindow(): void {
    const settings = loadSettings()
    const mainWindowOptions: Electron.BrowserWindowConstructorOptions = {
        width: 1400,
        height: 900,
        minWidth: 1100,
        minHeight: 700,
        show: false,
        backgroundColor: '#ffffff',
        title: 'CielooDesk',
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
            webSecurity: true,
            spellcheck: false
        }
    }

    if (process.platform === 'darwin') {
        mainWindowOptions.titleBarStyle = 'hiddenInset'
    }

    mainWindow = new BrowserWindow(mainWindowOptions)

    applyHeaderTheme(mainWindow, settings.headerTheme)

    mainWindow.once('ready-to-show', () => {
        mainWindow?.show()
        applyBootSettings(mainWindow!)
        flushPendingLoadingOverlay()
    })

    mainWindow.on('move', syncLoadingOverlayBounds)
    mainWindow.on('resize', syncLoadingOverlayBounds)
    mainWindow.on('enter-full-screen', syncLoadingOverlayBounds)
    mainWindow.on('leave-full-screen', syncLoadingOverlayBounds)
    mainWindow.on('show', flushPendingLoadingOverlay)
    mainWindow.on('restore', flushPendingLoadingOverlay)
    mainWindow.on('minimize', hideLoadingOverlayImmediate)
    mainWindow.on('hide', hideLoadingOverlayImmediate)
    mainWindow.on('closed', () => {
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

    // Loading indicator — taskbar progress bar only (no title pollution)
    mainWindow.webContents.on('did-start-loading', () => {
        mainWindow?.setProgressBar(2, { mode: 'indeterminate' })
        showLoadingOverlay()
    })
    mainWindow.webContents.on('did-stop-loading', () => {
        mainWindow?.setProgressBar(-1)
        hideLoadingOverlay()
    })

    // Gap fix: inject CSS on every page load to remove stray top margins
    mainWindow.webContents.on('did-navigate', (_e, url) => {
        void mainWindow?.webContents.insertCSS(
            'html,body{margin:0!important;padding:0!important;border:0!important}'
        )
        // Track last known good cieloo URL for offline recovery
        if (isCielooUrl(url)) lastCielooUrl = url
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
        loadOfflinePage()
    })

    loadContent()
}

// Apply navigation lock + new-window handler to any popup Electron creates
app.on('web-contents-created', (_e, wc) => {
    lockNavigation(wc)
    wc.setWindowOpenHandler(({ url }) => handleWindowOpen(url))
})

// ─── IPC ─────────────────────────────────────────────────────────────────────

function registerIpc(): void {
    ipcMain.handle('config:get', () => readConfig())

    ipcMain.handle('config:save-instance', (_e, instance: string) => {
        const clean = instance.trim().toLowerCase().replace(/[^a-z0-9-]/g, '')
        if (!clean) throw new Error('Nom d\'instance invalide')
        writeConfig({ instance: clean })
        void mainWindow?.loadURL(`https://${clean}.cieloo.io`)
    })

    ipcMain.handle('config:clear', () => {
        writeConfig({})
        if (isDev && process.env.ELECTRON_RENDERER_URL) {
            void mainWindow?.loadURL(process.env.ELECTRON_RENDERER_URL)
        } else {
            void mainWindow?.loadFile(path.join(__dirname, '../renderer/index.html'))
        }
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
        return { config: updated.print, status }
    })

    // ── Réseau ────────────────────────────────────────────────────────────────
    // Called by the offline page or preload to reload the last known cieloo URL
    ipcMain.handle('net:reload-last', () => {
        const url = lastCielooUrl || (() => {
            const instance = readConfig().instance
            return instance ? `https://${instance}.cieloo.io` : null
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
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

app.whenReady().then(() => {
    void startPrintServer(loadSettings().print)

    buildMenu()
    registerIpc()
    createMainWindow()

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

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
})
