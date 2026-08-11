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
const DEFAULT_POS_DIMS = { w: 64, h: 297 }
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

/** Mode d'affichage pendant une vente. */
export type CustomerDisplayCartMode =
    | 'total'     // ligne 1 = libellé, ligne 2 = total (comme avant)
    | 'detailed'  // ligne 1 = dernier article + prix unitaire, ligne 2 = total

export interface CustomerDisplaySettings {
    enabled: boolean
    /** Chemin du port série, ex. "COM3" ('' si non configuré) */
    port: string
    baudRate: number
    protocol: CustomerDisplayProtocol
    /** Nombre de caractères par ligne (typiquement 20) */
    columns: number
    /** Message d'accueil affiché quand le panier est vide */
    line1: string
    line2: string
    /** Mode d'affichage pendant une vente */
    cartMode: CustomerDisplayCartMode
    /** Libellé du total (ligne 1 en mode "total", préfixe du total en mode "detailed") */
    totalLabel: string
    /** En mode "detailed" : afficher le libellé devant le total (ex. "TOTAL : 12,500") */
    showTotalLabel: boolean
    /** Défilement du nom (mode "detailed") quand il est trop long */
    scrollStartPauseSec: number  // pause d'immobilité au début (secondes)
    scrollStepMs: number         // cadence du défilement (ms par pas) — plus petit = plus rapide
    scrollInstant: boolean       // true = bascule début↔fin (instantané) au lieu d'un défilement fluide
    /** Message de fin de vente (affiché quelques secondes après l'encaissement) */
    thankYouEnabled: boolean
    thankYouLine1: string
    thankYouLine2: string
    thankYouDurationSec: number
}

/** Valeurs par défaut des textes (source unique, réutilisée par le bouton "Remettre par défaut"). */
export const CUSTOMER_DISPLAY_TEXT_DEFAULTS = {
    line1: 'Bienvenue !',
    line2: 'Ravi de vous voir',
    totalLabel: 'TOTAL',
    thankYouLine1: 'Merci !',
    thankYouLine2: 'A bientot :)',
} as const

/** Correspondance taux TVA (du produit) → ID TVA interne de la balance Dibal. */
export interface BalanceTvaMapping {
    /** Taux TVA tel que stocké dans Dolibarr (ex. 5.5, 10, 20) */
    taux: number
    /** ID TVA interne attendu par la balance (col. 4 du fichier LinéoSoft) */
    id: number
}

/**
 * Mode balance (Dibal / profil LinéoSoft via DFS+RGI).
 * CielooDesk génère un Articles.txt (TAB, Windows-1252) déposé dans le dossier
 * surveillé par RGI, qui l'envoie à la balance.
 */
export interface BalanceSettings {
    enabled: boolean
    /** Dossier surveillé par RGI où déposer Articles.txt (ex. C:\Joolan\Balance\plu) */
    exportFolder: string | null
    /** Nom du fichier généré (RGI attend "Articles.txt" par défaut) */
    fileName: string
    /** Type d'article envoyé (2 = pesé/KG, 1 = unité) */
    defaultType: number
    /** Nombre de décimales du prix (TND = 3 / millimes) */
    priceDecimals: number
    /** Longueur max du libellé (le champ LinéoSoft fait 30) */
    nameMaxLength: number
    /** Table de correspondance taux TVA → ID TVA balance */
    tvaMap: BalanceTvaMapping[]
    /** ID TVA de repli si le taux n'est pas dans la table */
    defaultTvaId: number
    /** Intervalle de rafraîchissement auto en minutes (0 = désactivé) */
    refreshIntervalMin: number
    /** Port du webhook loopback déclenché par le trigger Dolibarr (0 = désactivé) */
    webhookPort: number
    /** Token API Dolibarr (auth headless, sinon on tente la session ouverte) */
    apiKey: string
    /** Chemin de RGI.exe (vide = auto-détection dans Program Files) */
    rgiPath: string
}

/**
 * Mode NACEF (fiscalisation tunisienne S-MDF).
 * À l'activation, l'app :
 *  1. ajoute des routes statiques persistantes vers les serveurs fiscaux via une
 *     passerelle dédiée (élévation UAC ponctuelle, seulement si elles manquent) ;
 *  2. démarre un proxy CORS local (127.0.0.1:proxyPort → proxyTarget) qui rend le
 *     boîtier S-MDF lisible depuis la page Dolibarr cloud.
 */
export interface NacefSettings {
    enabled: boolean
    /** Port d'écoute du proxy CORS local (défaut 10007) */
    proxyPort: number
    /** Cible relayée par le proxy — le boîtier S-MDF (défaut http://localhost:10006) */
    proxyTarget: string
    /** Valeur de l'en-tête Access-Control-Allow-Origin ('*' ou un domaine précis) */
    origin: string
    /** Passerelle (next hop) des routes fiscales, ex. 192.168.1.253 */
    gateway: string
    /** IP publiques des serveurs fiscaux à router via la passerelle (masque /32) */
    destinations: string[]
}

export interface AppSettings {
    autoLogin: boolean
    fullscreen: boolean
    launchAtStartup: boolean
    /** Vérification des mises à jour au démarrage (le bouton Support reste toujours dispo) */
    autoUpdateCheck: boolean
    secondDisplayAutoStart: boolean
    secondDisplayMediaFolder: string | null
    newWindowMode: NewWindowMode
    spinnerPosition: SpinnerPosition
    shortcuts: ShortcutMap
    print: PrintSettings
    customerDisplay: CustomerDisplaySettings
    balance: BalanceSettings
    nacef: NacefSettings
    requirePrinter: boolean
    serialNumber: string
    terminalName: string
    devMode: boolean
}

/** IPv4 stricte — indispensable : ces valeurs partent dans un PowerShell élevé (route add). */
const IPV4_RE = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/

export const DEFAULT_NACEF: NacefSettings = {
    enabled: false,
    proxyPort: 10007,
    proxyTarget: 'http://localhost:10006',
    origin: '*',
    gateway: '192.168.1.253',
    destinations: ['196.203.237.115', '196.203.237.116'],
}

export const DEFAULT_BALANCE_TVA_MAP: BalanceTvaMapping[] = [
    { taux: 5.5, id: 1 },
    { taux: 10, id: 3 },
    { taux: 20, id: 2 },
]

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
    autoUpdateCheck: true,
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
        line1: 'Bienvenue !',
        line2: 'Ravi de vous voir',
        cartMode: 'detailed',
        totalLabel: 'TOTAL',
        showTotalLabel: true,
        scrollStartPauseSec: 0.5,
        scrollStepMs: 450,
        scrollInstant: false,
        thankYouEnabled: true,
        thankYouLine1: 'Merci !',
        thankYouLine2: 'A bientot :)',
        thankYouDurationSec: 5,
    },
    balance: {
        enabled: false,
        exportFolder: null,
        fileName: 'Articles.txt',
        defaultType: 2,
        priceDecimals: 3,
        nameMaxLength: 30,
        tvaMap: [...DEFAULT_BALANCE_TVA_MAP],
        defaultTvaId: 1,
        refreshIntervalMin: 5,
        webhookPort: 9110,
        apiKey: '',
        rgiPath: '',
    },
    nacef: { ...DEFAULT_NACEF, destinations: [...DEFAULT_NACEF.destinations] },
    print: {
        enabled: true,
        port: 9100,
        printers: [{
            id: 'printer-default',
            label: 'Imprimante 1',
            defaultPrinter: null,
            paperWidth: DEFAULT_POS_DIMS.w,
            paperHeight: DEFAULT_POS_DIMS.h,
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
    const str = (v: unknown, fallback: string): string =>
        typeof v === 'string' ? v.slice(0, 40) : fallback
    const cartMode: CustomerDisplayCartMode = value?.cartMode === 'total' ? 'total' : 'detailed'
    const D = CUSTOMER_DISPLAY_TEXT_DEFAULTS
    return {
        enabled: value?.enabled === true,
        port: typeof value?.port === 'string' ? value.port.trim().slice(0, 64) : '',
        baudRate: clampInt(value?.baudRate, 300, 921600, 9600),
        protocol,
        columns: clampInt(value?.columns, 8, 40, 20),
        line1: str(value?.line1, D.line1),
        line2: str(value?.line2, D.line2),
        cartMode,
        totalLabel: str(value?.totalLabel, D.totalLabel),
        showTotalLabel: value?.showTotalLabel !== false,
        scrollStartPauseSec: clampNum(value?.scrollStartPauseSec, 0, 10, 0.5),
        scrollStepMs: clampInt(value?.scrollStepMs, 50, 2000, 450),
        scrollInstant: value?.scrollInstant === true,
        thankYouEnabled: value?.thankYouEnabled !== false,
        thankYouLine1: str(value?.thankYouLine1, D.thankYouLine1),
        thankYouLine2: str(value?.thankYouLine2, D.thankYouLine2),
        thankYouDurationSec: clampInt(value?.thankYouDurationSec, 1, 60, 5),
    }
}

export function normalizeBalance(value: Partial<BalanceSettings> | undefined): BalanceSettings {
    const raw = value as Record<string, unknown> | undefined

    let tvaMap: BalanceTvaMapping[] = DEFAULT_BALANCE_TVA_MAP
    if (Array.isArray(raw?.tvaMap)) {
        const cleaned = (raw!.tvaMap as Array<Partial<BalanceTvaMapping>>)
            .map((m) => ({ taux: Number(m?.taux), id: Number(m?.id) }))
            .filter((m) => Number.isFinite(m.taux) && Number.isInteger(m.id) && m.id >= 0)
        if (cleaned.length > 0) tvaMap = cleaned
    }

    const fileNameRaw = typeof raw?.fileName === 'string' ? raw.fileName.trim() : ''
    // Empêche tout séparateur de chemin dans le nom de fichier
    const fileName = fileNameRaw && !/[\\/]/.test(fileNameRaw) ? fileNameRaw.slice(0, 128) : 'Articles.txt'

    return {
        enabled: raw?.enabled === true,
        exportFolder: typeof raw?.exportFolder === 'string' && raw.exportFolder.trim()
            ? raw.exportFolder.trim()
            : null,
        fileName,
        defaultType: raw?.defaultType === 1 ? 1 : 2,
        priceDecimals: clampInt(raw?.priceDecimals, 0, 3, 3),
        nameMaxLength: clampInt(raw?.nameMaxLength, 1, 30, 30),
        tvaMap,
        defaultTvaId: clampInt(raw?.defaultTvaId, 0, 99, 1),
        refreshIntervalMin: clampInt(raw?.refreshIntervalMin, 0, 1440, 5),
        webhookPort: clampInt(raw?.webhookPort, 0, 65535, 9110),
        apiKey: typeof raw?.apiKey === 'string' ? raw.apiKey.trim().slice(0, 128) : '',
        rgiPath: typeof raw?.rgiPath === 'string' ? raw.rgiPath.trim().slice(0, 512) : '',
    }
}

export function normalizeNacef(value: Partial<NacefSettings> | undefined): NacefSettings {
    const raw = value as Record<string, unknown> | undefined
    const isIpv4 = (s: unknown): s is string => typeof s === 'string' && IPV4_RE.test(s.trim())

    // Cible du proxy : doit être une URL http(s) valide, sinon on retombe sur le défaut.
    let proxyTarget = typeof raw?.proxyTarget === 'string' ? raw.proxyTarget.trim() : ''
    try {
        const u = new URL(proxyTarget)
        if (u.protocol !== 'http:' && u.protocol !== 'https:') proxyTarget = ''
    } catch { proxyTarget = '' }

    const destinations = Array.isArray(raw?.destinations)
        ? (raw!.destinations as unknown[]).map((d) => String(d).trim()).filter((d) => IPV4_RE.test(d))
        : []

    return {
        enabled: raw?.enabled === true,
        proxyPort: clampInt(raw?.proxyPort, 1, 65535, DEFAULT_NACEF.proxyPort),
        proxyTarget: proxyTarget || DEFAULT_NACEF.proxyTarget,
        origin: typeof raw?.origin === 'string' && raw.origin.trim()
            ? raw.origin.trim().slice(0, 256)
            : DEFAULT_NACEF.origin,
        gateway: isIpv4(raw?.gateway) ? (raw!.gateway as string).trim() : DEFAULT_NACEF.gateway,
        destinations: destinations.length > 0 ? destinations : [...DEFAULT_NACEF.destinations],
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
        balance: normalizeBalance(rest.balance),
        nacef: normalizeNacef(rest.nacef),
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

export function setBalanceSettings(balance: Partial<BalanceSettings>): AppSettings {
    return updateSettings((current) => ({
        ...current,
        balance: normalizeBalance({ ...current.balance, ...balance }),
    }))
}

export function setNacefSettings(nacef: Partial<NacefSettings>): AppSettings {
    return updateSettings((current) => ({
        ...current,
        nacef: normalizeNacef({ ...current.nacef, ...nacef }),
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
        title: 'Configuration — caisLà',
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
