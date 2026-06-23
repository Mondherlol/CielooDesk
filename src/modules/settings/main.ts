import { ipcMain, BrowserWindow, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'
import os from 'node:os'

// ─── Types ────────────────────────────────────────────────────────────────────

export type SpinnerPosition = 'bottom-left' | 'bottom-right' | 'top-left' | 'top-right'
export type NewWindowMode = 'main' | 'popup'

export interface PrinterConfig {
    id: string
    label: string
    defaultPrinter: string | null
    paperWidth: number
    paperHeight: number
    copies: number
}

export interface PrintSettings {
    enabled: boolean
    port: number
    printers: PrinterConfig[]
    /** Imprimante d'étiquettes code-barres (rouleau, ex. 40×30 mm) */
    barcodePrinter: PrinterConfig
    /** Imprimante de planches de codes-barres (feuille A4) */
    barcodeSheetPrinter: PrinterConfig
}

export const BARCODE_PRINTER_ID = 'printer-barcode'
export const BARCODE_SHEET_PRINTER_ID = 'printer-barcode-sheet'

// Dimensions par défaut (mm) pour chaque type d'imprimante
const DEFAULT_POS_DIMS = { w: 63.5, h: 297 }
const DEFAULT_BARCODE_LABEL_DIMS = { w: 40, h: 30 }
const DEFAULT_BARCODE_SHEET_DIMS = { w: 210, h: 297 }

export interface ShortcutMap {
    reload: string
    hardReload: string
    fullscreen: string
    quit: string
    devtools: string
}

/** Afficheur client VFD (pole display 2x20, ex. SAGA) piloté en série (COM). */
export type CustomerDisplayProtocol = 'cd5220' | 'esc-pos' | 'plain'

export interface CustomerDisplaySettings {
    enabled: boolean
    /** Chemin du port série, ex. "COM3" ('' si non configuré) */
    port: string
    baudRate: number
    protocol: CustomerDisplayProtocol
    /** Nombre de caractères par ligne (typiquement 20) */
    columns: number
    /** Texte affiché par défaut (au repos) */
    line1: string
    line2: string
}

export interface AppSettings {
    autoLogin: boolean
    fullscreen: boolean
    launchAtStartup: boolean
    secondDisplayAutoStart: boolean
    secondDisplayMediaFolder: string | null
    newWindowMode: NewWindowMode
    spinnerPosition: SpinnerPosition
    shortcuts: ShortcutMap
    print: PrintSettings
    customerDisplay: CustomerDisplaySettings
    requirePrinter: boolean
    serialNumber: string
    terminalName: string
    devMode: boolean
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
    secondDisplayAutoStart: true,
    secondDisplayMediaFolder: null,
    newWindowMode: 'main',
    spinnerPosition: 'bottom-left',
    shortcuts: { ...DEFAULT_SHORTCUTS },
    requirePrinter: false,
    serialNumber: '',
    terminalName: '',
    devMode: false,
    customerDisplay: {
        enabled: false,
        port: '',
        baudRate: 9600,
        protocol: 'cd5220',
        columns: 20,
        line1: 'Bienvenue',
        line2: 'Powered by CaisLà',
    },
    print: {
        enabled: true,
        port: 9100,
        printers: [{
            id: 'printer-default',
            label: 'Imprimante 1',
            defaultPrinter: null,
            paperWidth: 63.5,
            paperHeight: 297,
            copies: 1,
        }],
        barcodePrinter: {
            id: BARCODE_PRINTER_ID,
            label: 'Étiquettes',
            defaultPrinter: null,
            paperWidth: DEFAULT_BARCODE_LABEL_DIMS.w,
            paperHeight: DEFAULT_BARCODE_LABEL_DIMS.h,
            copies: 1,
        },
        barcodeSheetPrinter: {
            id: BARCODE_SHEET_PRINTER_ID,
            label: 'Planche A4',
            defaultPrinter: null,
            paperWidth: DEFAULT_BARCODE_SHEET_DIMS.w,
            paperHeight: DEFAULT_BARCODE_SHEET_DIMS.h,
            copies: 1,
        },
    },
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number.parseInt(String(value), 10)
    if (Number.isNaN(parsed)) return fallback
    return Math.min(Math.max(parsed, min), max)
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
    const parsed = Number.parseFloat(String(value))
    if (Number.isNaN(parsed)) return fallback
    return Math.min(Math.max(parsed, min), max)
}

function normalizePrinterConfig(
    value: Partial<PrinterConfig> | undefined,
    index: number,
    dimFallback: { w: number; h: number } = DEFAULT_POS_DIMS,
): PrinterConfig {
    return {
        id: typeof value?.id === 'string' && value.id.trim() ? value.id.trim() : `printer-${Date.now()}-${index}`,
        label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 64) : `Imprimante ${index + 1}`,
        defaultPrinter: typeof value?.defaultPrinter === 'string' && value.defaultPrinter.trim()
            ? value.defaultPrinter.trim().slice(0, 256)
            : null,
        paperWidth: clampNum(value?.paperWidth, 1, 1000, dimFallback.w),
        paperHeight: clampNum(value?.paperHeight, 1, 2000, dimFallback.h),
        copies: clampInt(value?.copies, 1, 99, 1),
    }
}

function normalizeBarcodePrinter(value: Partial<PrinterConfig> | undefined): PrinterConfig {
    const base = normalizePrinterConfig(value, 0, DEFAULT_BARCODE_LABEL_DIMS)
    return {
        ...base,
        id: BARCODE_PRINTER_ID,
        label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 64) : 'Étiquettes',
    }
}

function normalizeBarcodeSheetPrinter(value: Partial<PrinterConfig> | undefined): PrinterConfig {
    const base = normalizePrinterConfig(value, 0, DEFAULT_BARCODE_SHEET_DIMS)
    return {
        ...base,
        id: BARCODE_SHEET_PRINTER_ID,
        label: typeof value?.label === 'string' && value.label.trim() ? value.label.trim().slice(0, 64) : 'Planche A4',
    }
}

export function normalizePrintSettings(value: Partial<PrintSettings> | undefined): PrintSettings {
    const raw = value as Record<string, unknown> | undefined
    const barcodePrinter = normalizeBarcodePrinter(raw?.barcodePrinter as Partial<PrinterConfig> | undefined)
    const barcodeSheetPrinter = normalizeBarcodeSheetPrinter(raw?.barcodeSheetPrinter as Partial<PrinterConfig> | undefined)

    // Migration: old flat format has `defaultPrinter` directly (no `printers` array)
    if (raw && !Array.isArray(raw.printers) && typeof raw.defaultPrinter === 'string') {
        return {
            enabled: true,
            port: 9100,
            printers: [normalizePrinterConfig({
                id: 'printer-default',
                label: 'Imprimante 1',
                defaultPrinter: raw.defaultPrinter || null,
                paperWidth: typeof raw.paperWidth === 'number' ? raw.paperWidth : undefined,
                paperHeight: typeof raw.paperHeight === 'number' ? raw.paperHeight : undefined,
                copies: typeof raw.copies === 'number' ? raw.copies : undefined,
            }, 0)],
            barcodePrinter,
            barcodeSheetPrinter,
        }
    }

    const rawPrinters = Array.isArray(raw?.printers) ? raw.printers as Partial<PrinterConfig>[] : []
    const printers = rawPrinters.length > 0
        ? rawPrinters.map((p, i) => normalizePrinterConfig(p, i))
        : [normalizePrinterConfig(undefined, 0)]

    return {
        enabled: true,
        port: 9100,
        printers,
        barcodePrinter,
        barcodeSheetPrinter,
    }
}

const CUSTOMER_DISPLAY_PROTOCOLS: CustomerDisplayProtocol[] = ['cd5220', 'esc-pos', 'plain']

export function normalizeCustomerDisplay(value: Partial<CustomerDisplaySettings> | undefined): CustomerDisplaySettings {
    const protocol = CUSTOMER_DISPLAY_PROTOCOLS.includes(value?.protocol as CustomerDisplayProtocol)
        ? value!.protocol as CustomerDisplayProtocol
        : 'cd5220'
    return {
        enabled: value?.enabled === true,
        port: typeof value?.port === 'string' ? value.port.trim().slice(0, 64) : '',
        baudRate: clampInt(value?.baudRate, 300, 921600, 9600),
        protocol,
        columns: clampInt(value?.columns, 8, 40, 20),
        line1: typeof value?.line1 === 'string' ? value.line1.slice(0, 40) : '',
        line2: typeof value?.line2 === 'string' ? value.line2.slice(0, 40) : '',
    }
}

function mergeWithDefaults(parsed: Partial<AppSettings> & { secondScreen?: unknown }): AppSettings {
    const { secondScreen: _legacySecondScreen, ...rest } = parsed
    const rawMediaFolder = rest.secondDisplayMediaFolder

    return {
        ...DEFAULTS,
        ...rest,
        secondDisplayAutoStart: rest.secondDisplayAutoStart !== false,
        secondDisplayMediaFolder: typeof rawMediaFolder === 'string' && rawMediaFolder.trim()
            ? rawMediaFolder.trim()
            : null,
        shortcuts: { ...DEFAULT_SHORTCUTS, ...(rest.shortcuts ?? {}) },
        print: normalizePrintSettings(rest.print),
        customerDisplay: normalizeCustomerDisplay(rest.customerDisplay),
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

export function setCustomerDisplaySettings(cd: Partial<CustomerDisplaySettings>): AppSettings {
    return updateSettings((current) => ({
        ...current,
        customerDisplay: normalizeCustomerDisplay({ ...current.customerDisplay, ...cd }),
    }))
}

// ─── Device info ─────────────────────────────────────────────────────────────

export function getNetworkInfo(): { mac: string; ip: string } {
    const ifaces = os.networkInterfaces()
    let mac = '—'
    let ip = '—'

    // Ethernet interface names on Windows: "Ethernet", "Local Area Connection", etc.
    const isEthernet = (name: string) => /^(ethernet|local area connection|eth\d*)/i.test(name)

    const entries = Object.entries(ifaces)
    // Prioritise Ethernet interfaces, then fall back to any non-internal interface
    const sorted = [
        ...entries.filter(([name]) => isEthernet(name)),
        ...entries.filter(([name]) => !isEthernet(name)),
    ]

    for (const [, addrs] of sorted) {
        if (!addrs) continue
        for (const addr of addrs) {
            if (addr.internal) continue
            if (mac === '—' && addr.mac && addr.mac !== '00:00:00:00:00:00') {
                mac = addr.mac
            }
            if (ip === '—' && addr.family === 'IPv4') {
                ip = addr.address
            }
        }
        if (mac !== '—' && ip !== '—') break
    }

    return { mac, ip }
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

    const icon = app.isPackaged
        ? path.join(process.resourcesPath, 'assets', 'img', 'favicon.ico')
        : path.join(app.getAppPath(), 'assets', 'img', 'favicon.ico')

    settingsWin = new BrowserWindow({
        width: 720,
        height: 540,
        minWidth: 640,
        minHeight: 460,
        title: 'Configuration — CielooPos',
        backgroundColor: '#f2f3f5',
        show: false,
        icon,
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

        if (key === 'launchAtStartup') app.setLoginItemSettings({ openAtLogin: Boolean(value), name: 'CielooPos' })
        if (key === 'fullscreen') getMainWindow()?.setFullScreen(Boolean(value))
        if (key === 'devMode') _rebuildMenuCallback?.()

        getMainWindow()?.webContents.send('settings:updated')
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

    ipcMain.handle('device:get-network-info', () => getNetworkInfo())
}

// ─── Boot ─────────────────────────────────────────────────────────────────────

export function applyBootSettings(mainWindow: BrowserWindow): void {
    if (loadSettings().fullscreen) mainWindow.setFullScreen(true)
}
