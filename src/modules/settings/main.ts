import { ipcMain, BrowserWindow, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpinnerPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
export type NewWindowMode = 'main' | 'popup'
<<<<<<< HEAD
=======
export type HeaderTheme = 'system' | 'light' | 'sky-blue'
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be

export interface PrintSettings {
    enabled: boolean
    port: number
    defaultPrinter: string | null
    paperWidth: number
    paperHeight: number
    orientation: 'portrait' | 'landscape'
    margins: number
    scale: 'noscale' | 'shrink' | 'fit'
    copies: number
    color: boolean
}

export interface ShortcutMap {
    reload: string
    hardReload: string
    fullscreen: string
    quit: string
    devtools: string
}

export interface AppSettings {
    autoLogin: boolean
    fullscreen: boolean
    launchAtStartup: boolean
    newWindowMode: NewWindowMode
    spinnerPosition: SpinnerPosition
<<<<<<< HEAD
=======
    headerTheme: HeaderTheme
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    shortcuts: ShortcutMap
    print: PrintSettings
}

export const DEFAULT_SHORTCUTS: ShortcutMap = {
    reload: 'F5',
    hardReload: 'CmdOrCtrl+F5',
    fullscreen: 'F11',
    quit: 'Alt+F4',
    devtools: 'F12',
}

const DEFAULTS: AppSettings = {
    autoLogin: false,
    fullscreen: false,
    launchAtStartup: false,
    newWindowMode: 'main',
    spinnerPosition: 'bottom-left',
<<<<<<< HEAD
=======
    headerTheme: 'system',
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    shortcuts: { ...DEFAULT_SHORTCUTS },
    print: {
        enabled: true,
        port: 9100,
        defaultPrinter: null,
        paperWidth: 80,
        paperHeight: 297,
        orientation: 'portrait',
        margins: 2,
        scale: 'noscale',
        copies: 1,
        color: false,
    },
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10)
    if (Number.isNaN(parsed)) return fallback
    return Math.min(Math.max(parsed, min), max)
}

export function normalizePrintSettings(value: Partial<PrintSettings> | undefined): PrintSettings {
    return {
        // CielooPrint is intentionally always active on a fixed local port.
        enabled: true,
        port: 9100,
        defaultPrinter: typeof value?.defaultPrinter === 'string' && value.defaultPrinter.trim()
            ? value.defaultPrinter.trim().slice(0, 256)
            : null,
        paperWidth: clampInt(value?.paperWidth, 1, 1000, 80),
        paperHeight: clampInt(value?.paperHeight, 1, 2000, 297),
        orientation: value?.orientation === 'landscape' ? 'landscape' : 'portrait',
        margins: clampInt(value?.margins, 0, 50, 2),
        scale: value?.scale === 'shrink' || value?.scale === 'fit' ? value.scale : 'noscale',
        copies: clampInt(value?.copies, 1, 99, 1),
        color: Boolean(value?.color),
    }
}

function mergeWithDefaults(parsed: Partial<AppSettings>): AppSettings {
    return {
        ...DEFAULTS,
        ...parsed,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(parsed.shortcuts ?? {}) },
        print: normalizePrintSettings(parsed.print),
    }
}

// ─── Persistence ──────────────────────────────────────────────────────────────

let _cache: AppSettings | null = null

function settingsPath(): string {
    return path.join(app.getPath('userData'), 'settings.json')
}

export function loadSettings(): AppSettings {
    if (_cache) return _cache
    try {
        const parsed = JSON.parse(fs.readFileSync(settingsPath(), 'utf-8')) as Partial<AppSettings>
        _cache = mergeWithDefaults(parsed)
    } catch {
        _cache = mergeWithDefaults({})
    }
    return _cache
}

function persist(s: AppSettings): void {
    const normalized = mergeWithDefaults(s)
    _cache = normalized
    fs.writeFileSync(settingsPath(), JSON.stringify(normalized, null, 2))
}

export function updateSettings(mutator: (current: AppSettings) => AppSettings): AppSettings {
    const next = mutator(loadSettings())
    persist(next)
    return loadSettings()
}

export function setPrintSettings(print: Partial<PrintSettings>): AppSettings {
    return updateSettings((current) => ({
        ...current,
        print: normalizePrintSettings({ ...current.print, ...print }),
    }))
}

// ─── Settings window ──────────────────────────────────────────────────────────

let settingsWin: BrowserWindow | null = null

function centerOverParent(child: BrowserWindow, parent: BrowserWindow): void {
    const parentBounds = parent.getBounds()
    const [childWidth, childHeight] = child.getSize()
    const x = Math.round(parentBounds.x + (parentBounds.width - childWidth) / 2)
    const y = Math.round(parentBounds.y + (parentBounds.height - childHeight) / 2)
    child.setPosition(x, y)
}

export function openSettingsWindow(isDev: boolean, rendererUrl?: string): void {
    if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.focus(); return }

    const parentWindow = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0] ?? null

<<<<<<< HEAD
    const icon = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'img', 'favicon.ico')
        : path.join(app.getAppPath(), 'assets', 'img', 'favicon.ico')

=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    settingsWin = new BrowserWindow({
        width: 720,
        height: 540,
        minWidth: 640,
        minHeight: 460,
<<<<<<< HEAD
        title: 'Configuration — CielooPos',
        backgroundColor: '#f2f3f5',
        show: false,
        icon,
=======
        title: 'Configuration — CielooDesk',
        backgroundColor: '#f2f3f5',
        show: false,
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
        parent: parentWindow ?? undefined,
        webPreferences: {
            preload: path.join(__dirname, '../preload/index.js'),
            contextIsolation: true,
            sandbox: false,
            nodeIntegration: false,
        }
    })

    settingsWin.setMenu(null)
    settingsWin.once('ready-to-show', () => {
        if (!settingsWin) return
        if (parentWindow && !parentWindow.isDestroyed()) {
            centerOverParent(settingsWin, parentWindow)
        } else {
            settingsWin.center()
        }
        settingsWin.show()
    })
    settingsWin.on('closed', () => { settingsWin = null })

    if (isDev && rendererUrl) {
        void settingsWin.loadURL(`${rendererUrl}/settings.html`)
    } else {
        void settingsWin.loadFile(path.join(__dirname, '../renderer/settings.html'))
    }
}

<<<<<<< HEAD
=======
export function applyHeaderTheme(mainWindow: BrowserWindow, theme: HeaderTheme): void {
    if (process.platform !== 'win32') return

    // Keep native Windows title bar/buttons intact.
    // Overlay theming on this app shell removes native title content and looks broken.
    void mainWindow
    void theme
}

>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
// ─── IPC ─────────────────────────────────────────────────────────────────────

// Callback so main/index.ts can rebuild the menu after shortcut changes
let _rebuildMenuCallback: (() => void) | null = null
export function onRebuildMenu(cb: () => void): void { _rebuildMenuCallback = cb }

export function registerSettingsIpc(
    isDev: boolean,
    rendererUrl: string | undefined,
    getMainWindow: () => BrowserWindow | null
): void {
    ipcMain.handle('settings:get', () => loadSettings())

    /** Set a single top-level setting */
    ipcMain.handle('settings:set', (_e, key: keyof AppSettings, value: boolean | string): AppSettings => {
        const updated = updateSettings((current) => ({ ...current, [key]: value as never }))

<<<<<<< HEAD
        if (key === 'launchAtStartup') app.setLoginItemSettings({ openAtLogin: Boolean(value), name: 'CielooPos' })
        if (key === 'fullscreen') getMainWindow()?.setFullScreen(Boolean(value))
=======
        if (key === 'launchAtStartup') app.setLoginItemSettings({ openAtLogin: Boolean(value), name: 'CielooDesk' })
        if (key === 'fullscreen') getMainWindow()?.setFullScreen(Boolean(value))
        if (key === 'headerTheme') {
            const mainWindow = getMainWindow()
            if (mainWindow) applyHeaderTheme(mainWindow, value as HeaderTheme)
        }
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be

        return updated
    })

    /** Update the full shortcuts map and rebuild the native menu */
    ipcMain.handle('settings:set-shortcuts', (_e, shortcuts: ShortcutMap): AppSettings => {
        const updated = updateSettings((current) => ({ ...current, shortcuts }))
        _rebuildMenuCallback?.()
        return updated
    })

    /** Reset shortcuts to defaults */
    ipcMain.handle('settings:reset-shortcuts', (): AppSettings => {
        const updated = updateSettings((current) => ({ ...current, shortcuts: { ...DEFAULT_SHORTCUTS } }))
        _rebuildMenuCallback?.()
        return updated
    })

    ipcMain.handle('settings:open', () => openSettingsWindow(isDev, rendererUrl))
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export function applyBootSettings(mainWindow: BrowserWindow): void {
    if (loadSettings().fullscreen) mainWindow.setFullScreen(true)
}
