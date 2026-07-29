import express, { type NextFunction, type Request as ExpReq, type Response as ExpRes } from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { normalizePrintSettings, type PrintSettings, type PrinterConfig } from '../settings/main'

export type BarcodeTestMode = 'label' | 'sheet'

export interface PrintServerStatus {
    active: boolean
    ready: boolean
    port: number
    serverUrl: string
    printer: string | null
    sumatraFound: boolean
    message: string
}

const MAX_FILE_SIZE = 50 * 1024 * 1024
const PRINT_TIMEOUT = 20_000
const RATE_WINDOW_MS = 10_000
const RATE_MAX_REQ = 5
const LOCALHOST_CORS = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i
const CIELOO_CORS = /^https:\/\/([a-z0-9-]+\.)*cieloo\.io$/i

let server: ReturnType<express.Application['listen']> | null = null
let currentSettings: PrintSettings = normalizePrintSettings(undefined)
let printRequests: number[] = []
const openConnections = new Set<{ destroy(): void }>()

function uploadsDir(): string {
    return path.join(app.getPath('userData'), 'cieloo-print-uploads')
}

function resolveSumatraPath(): string {
    const candidates = app.isPackaged
        ? [
            path.join(process.resourcesPath, 'assets', 'SumatraPDF.exe'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'SumatraPDF.exe'),
            path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe'),
            path.join(process.resourcesPath, 'SumatraPDF.exe'),
        ]
        : [
            path.join(app.getAppPath(), 'assets', 'SumatraPDF.exe'),
            path.join(app.getAppPath(), 'SumatraPDF.exe'),
        ]

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function status(message?: string): PrintServerStatus {
    const port = currentSettings.port
    const isActive = Boolean(server)
    const sumatraFound = fs.existsSync(resolveSumatraPath())
    const firstPrinter = currentSettings.printers[0]?.defaultPrinter ?? null
    const hasAnyPrinter = currentSettings.printers.some(p => p.defaultPrinter !== null)

    return {
        active: isActive,
        ready: isActive && hasAnyPrinter,
        port,
        serverUrl: `http://127.0.0.1:${port}`,
        printer: firstPrinter,
        sumatraFound,
        message: message ?? (isActive ? 'Serveur CielooPrint actif' : 'Serveur CielooPrint inactif'),
    }
}

function isRateLimited(): boolean {
    const now = Date.now()
    printRequests = printRequests.filter((entry) => entry >= now - RATE_WINDOW_MS)
    if (printRequests.length >= RATE_MAX_REQ) return true
    printRequests.push(now)
    return false
}

function cleanupFile(filePath: string | undefined): void {
    if (!filePath) return
    try {
        if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
    } catch {
        // Ignore cleanup errors.
    }
}

function printWithSumatra(filePath: string, printer: string | null | undefined, printSettings?: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!printer) {
            reject(new Error('Aucune imprimante configurée'))
            return
        }
        const sumatraPath = resolveSumatraPath()
        if (!fs.existsSync(sumatraPath)) {
            reject(new Error('SumatraPDF.exe introuvable (attendu dans resources/assets).'))
            return
        }
        const args = ['-print-to', printer]
        // -print-settings "noscale" : conserve la taille native du PDF (étiquettes à dimensions fixes)
        if (printSettings) args.push('-print-settings', printSettings)
        args.push('-silent', '-exit-when-done', filePath)
        execFile(sumatraPath, args, { timeout: PRINT_TIMEOUT }, (error) => {
            if (error) { reject(error); return }
            resolve()
        })
    })
}

function printUrlWithWebContents(url: string, config: PrinterConfig): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!config.defaultPrinter) {
            reject(new Error(`Imprimante "${config.label}" non configurée`))
            return
        }

        let settled = false
        const settle = (err?: Error): void => {
            if (settled) return
            settled = true
            clearTimeout(timer)
            try { if (!win.isDestroyed()) win.destroy() } catch { /* ok */ }
            err ? reject(err) : resolve()
        }

        const win = new BrowserWindow({
            show: false,
            width: 600,
            height: 1400,
            webPreferences: {
                contextIsolation: true,
                sandbox: false,
                nodeIntegration: false,
                session: session.defaultSession,
            },
        })

        const timer = setTimeout(() => settle(new Error('Timeout impression')), PRINT_TIMEOUT)

        win.webContents.once('did-finish-load', () => {
            if (win.isDestroyed()) return
            // Délai pour laisser JS (barcodes, images) terminer le rendu
            setTimeout(() => {
                if (win.isDestroyed()) return
                win.webContents.print(
                    {
                        silent: true,
                        printBackground: true,
                        deviceName: config.defaultPrinter ?? '',
                        copies: config.copies,
                        pageSize: {
                            width: config.paperWidth * 1000,
                            height: config.paperHeight * 1000,
                        },
                    },
                    (success, failureReason) => {
                        settle(success ? undefined : new Error(failureReason || 'Erreur impression'))
                    },
                )
            }, 1500)
        })

        win.webContents.once('did-fail-load', (_e, _code, desc) => {
            settle(new Error(`Chargement échoué : ${desc}`))
        })

        // data: URLs are self-contained — no preview param needed
        // ?preview=1 for receipt_designer.php only (skips auto PrintTicket call)
        let printUrl: string
        if (url.startsWith('data:')) {
            printUrl = url
        } else {
            try {
                const u = new URL(url)
                u.searchParams.set('preview', '1')
                printUrl = u.toString()
            } catch {
                printUrl = url.includes('?') ? `${url}&preview=1` : `${url}?preview=1`
            }
        }
        void win.loadURL(printUrl)
    })
}

/**
 * Imprime un document HTML autonome (ticket de la caisse hors-ligne) sur les
 * imprimantes ticket configurées — même pipeline silencieux que le POS online.
 */
export async function printHtmlReceipt(html: string): Promise<void> {
    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    await printUrlToAllPrinters(dataUrl)
}

async function printUrlToAllPrinters(url: string): Promise<void> {
    const active = currentSettings.printers.filter(p => p.defaultPrinter !== null)
    if (active.length === 0) throw new Error('Aucune imprimante configurée')
    const results = await Promise.allSettled(active.map(p => printUrlWithWebContents(url, p)))
    const errors = results.filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    if (errors.length > 0 && errors.length === active.length) {
        const msg = errors[0].reason instanceof Error ? errors[0].reason.message : 'Erreur impression'
        throw new Error(msg)
    }
}


export async function printTestPage(config: PrinterConfig): Promise<void> {
    if (!config.defaultPrinter) {
        throw new Error(`Aucun driver Windows configuré pour "${config.label}".`)
    }

    const now = new Date()
    const dateStr = now.toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' })

    const html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
*{margin:0;padding:0;box-sizing:border-box;}
body{font-family:monospace;font-size:13px;width:${config.paperWidth}mm;padding:4mm;}
.c{text-align:center;}.b{font-weight:bold;}
.big{font-size:15px;font-weight:bold;letter-spacing:1px;}
.ok{font-size:17px;font-weight:bold;letter-spacing:3px;margin:4px 0;}
hr{border:none;border-top:1px dashed #000;margin:5px 0;}
.row{display:flex;justify-content:space-between;font-size:12px;}
</style></head><body>
<div class="c big">CielooPrint</div>
<div class="c" style="font-size:11px;margin-bottom:3px">Page de test</div>
<hr/>
<div class="row"><span class="b">Nom</span><span>${config.label}</span></div>
<div class="row"><span class="b">Driver</span><span>${config.defaultPrinter}</span></div>
<div class="row"><span class="b">Format</span><span>${config.paperWidth} x ${config.paperHeight} mm</span></div>
<div class="row"><span class="b">Date</span><span>${dateStr} ${timeStr}</span></div>
<hr/>
<div class="c ok">** IMPRIMANTE OK **</div>
</body></html>`

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    return printUrlWithWebContents(dataUrl, config)
}

// ─── Code-barres (Code128 B) ────────────────────────────────────────────────
// Table des 107 motifs Code128 (largeurs de modules barre/espace) + motif STOP.
// Permet de générer un code-barres réellement scannable en SVG, sans dépendance.
const CODE128_PATTERNS = [
    '212222', '222122', '222221', '121223', '121322', '131222', '122213', '122312', '132212', '221213',
    '221312', '231212', '112232', '122132', '122231', '113222', '123122', '123221', '223211', '221132',
    '221231', '213212', '223112', '312131', '311222', '321122', '321221', '312212', '322112', '322211',
    '212123', '212321', '232121', '111323', '131123', '131321', '112313', '132113', '132311', '211313',
    '231113', '231311', '112133', '112331', '132131', '113123', '113321', '133121', '313121', '211331',
    '231131', '213113', '213311', '213131', '311123', '311321', '331121', '312113', '312311', '332111',
    '314111', '221411', '431111', '111224', '111422', '121124', '121421', '141122', '141221', '112214',
    '112412', '122114', '122411', '142112', '142211', '241211', '221114', '413111', '241112', '134111',
    '111242', '121142', '121241', '114212', '124112', '124211', '411212', '421112', '421211', '212141',
    '214121', '412121', '111143', '111341', '131141', '114113', '114311', '411113', '411311', '113141',
    '114131', '311141', '411131', '211412', '211214', '211232', '2331112',
]
const CODE128_STOP = 106
const CODE128_START_B = 104

/** Encode `value` en Code128-B et renvoie un SVG scannable (barres noires sur fond transparent). */
function buildCode128Svg(value: string, opts: { moduleWidth?: number; height?: number } = {}): string {
    const moduleWidth = opts.moduleWidth ?? 2
    const height = opts.height ?? 60

    // ASCII imprimable 32..126 uniquement (jeu B) ; les autres caractères sont ignorés.
    const chars = [...value].filter((c) => {
        const code = c.charCodeAt(0)
        return code >= 32 && code <= 126
    })

    const codes = [CODE128_START_B, ...chars.map((c) => c.charCodeAt(0) - 32)]
    let checksum = CODE128_START_B
    for (let i = 1; i < codes.length; i++) checksum += codes[i] * i
    codes.push(checksum % 103)
    codes.push(CODE128_STOP)

    const pattern = codes.map((c) => CODE128_PATTERNS[c]).join('')

    let x = 0
    let isBar = true // chaque motif commence par une barre
    const rects: string[] = []
    for (const ch of pattern) {
        const w = parseInt(ch, 10) * moduleWidth
        if (isBar) rects.push(`<rect x="${x}" y="0" width="${w}" height="${height}" fill="#000"/>`)
        x += w
        isBar = !isBar
    }

    return `<svg xmlns="http://www.w3.org/2000/svg" width="${x}" height="${height}" viewBox="0 0 ${x} ${height}" `
        + `shape-rendering="crispEdges" preserveAspectRatio="xMidYMid meet">${rects.join('')}</svg>`
}

/**
 * Imprime une page de test pour une imprimante code-barres.
 *  - mode `label` : une étiquette unique avec un code-barres (format rouleau, ex. 40×30 mm)
 *  - mode `sheet` : une planche A4 remplie d'une grille de codes-barres
 */
export async function printBarcodeTestPage(config: PrinterConfig, mode: BarcodeTestMode): Promise<void> {
    if (!config.defaultPrinter) {
        throw new Error(`Aucun driver Windows configuré pour "${config.label}".`)
    }

    const testValue = 'CIELOO-TEST-128'
    const dateStr = new Date().toLocaleString('fr-FR', {
        day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit',
    })

    let html: string
    if (mode === 'sheet') {
        // Planche A4 : grille de codes-barres (3 colonnes × 8 lignes)
        const cols = 3
        const rows = 8
        const cell = buildCode128Svg(testValue, { moduleWidth: 1, height: 36 })
        const cells = Array.from({ length: cols * rows }, () => `
            <div class="cell">
                <div class="cell-bc">${cell}</div>
                <div class="cell-code">${testValue}</div>
            </div>`).join('')
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@page{size:${config.paperWidth}mm ${config.paperHeight}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${config.paperWidth}mm;height:${config.paperHeight}mm;font-family:Arial,sans-serif;padding:8mm 6mm}
.title{text-align:center;font-size:11px;font-weight:bold;letter-spacing:2px;margin-bottom:2mm}
.sub{text-align:center;font-size:8px;color:#444;margin-bottom:4mm}
.grid{display:grid;grid-template-columns:repeat(${cols},1fr);gap:3mm 4mm}
.cell{border:0.3mm dashed #cbd5e1;border-radius:1mm;padding:2mm 1mm;display:flex;flex-direction:column;align-items:center;justify-content:center}
.cell-bc{width:100%;height:9mm;display:flex;align-items:center;justify-content:center}
.cell-bc svg{max-width:100%;height:100%}
.cell-code{font-size:7px;margin-top:1mm;letter-spacing:1px}
</style></head><body>
<div class="title">PLANCHE CODES BARRES</div>
<div class="sub">${config.label} · ${config.paperWidth}×${config.paperHeight} mm · ${dateStr}</div>
<div class="grid">${cells}</div>
</body></html>`
    } else {
        // Étiquette unique (format rouleau)
        const bc = buildCode128Svg(testValue, { moduleWidth: 2, height: 60 })
        html = `<!DOCTYPE html><html><head><meta charset="UTF-8"><style>
@page{size:${config.paperWidth}mm ${config.paperHeight}mm;margin:0}
*{margin:0;padding:0;box-sizing:border-box}
body{width:${config.paperWidth}mm;height:${config.paperHeight}mm;font-family:Arial,sans-serif;
     display:flex;flex-direction:column;align-items:center;justify-content:center;padding:1.5mm}
.label{font-size:9px;font-weight:bold;letter-spacing:1px}
.bc{width:92%;flex:1;max-height:55%;display:flex;align-items:center;justify-content:center;margin:1mm 0}
.bc svg{max-width:100%;max-height:100%}
.code{font-size:9px;letter-spacing:2px}
.foot{font-size:6px;color:#555;margin-top:0.5mm}
</style></head><body>
<div class="label">TEST CODE BARRES</div>
<div class="bc">${bc}</div>
<div class="code">${testValue}</div>
<div class="foot">${config.label} · ${config.paperWidth}×${config.paperHeight} mm · ${dateStr}</div>
</body></html>`
    }

    const dataUrl = `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
    return printUrlWithWebContents(dataUrl, config)
}

async function listPrintersFromPdfToPrinter(): Promise<Array<{ name: string }>> {
    const printerModule = await import('pdf-to-printer') as {
        getPrinters?: () => Promise<Array<{ name: string }>>
        default?: { getPrinters?: () => Promise<Array<{ name: string }>> }
    }

    const getPrinters = printerModule.getPrinters ?? printerModule.default?.getPrinters
    if (!getPrinters) throw new Error('Module pdf-to-printer indisponible')

    const printers = await getPrinters()
    return printers.map((printer) => ({ name: printer.name }))
}

export async function getSystemPrinters(mainWindow: BrowserWindow | null): Promise<Array<{ name: string; isDefault: boolean }>> {
    try {
        if (mainWindow && !mainWindow.isDestroyed()) {
            const printers = await mainWindow.webContents.getPrintersAsync()
            return printers.map((printer) => ({ name: printer.name, isDefault: printer.isDefault }))
        }
    } catch {
        // Fallback below.
    }

    try {
        const printers = await listPrintersFromPdfToPrinter()
        return printers.map((printer) => ({ name: printer.name, isDefault: false }))
    } catch {
        return []
    }
}

function buildExpressApp(): express.Application {
    const expressApp = express()

    const upload = multer({
        storage: multer.diskStorage({
            destination: (_req, _file, cb) => {
                fs.mkdirSync(uploadsDir(), { recursive: true })
                cb(null, uploadsDir())
            },
            filename: (_req, _file, cb) => {
                cb(null, `print_${Date.now()}_${Math.random().toString(36).slice(2)}.pdf`)
            },
        }),
        limits: { fileSize: MAX_FILE_SIZE, files: 1 },
        fileFilter: (_req, file, cb) => {
            const isPdf = file.mimetype === 'application/pdf' || file.originalname.toLowerCase().endsWith('.pdf')
            cb(null, isPdf)
        },
    })

    expressApp.disable('x-powered-by')
    expressApp.use(cors({
        origin: (origin, callback) => {
            if (!origin || LOCALHOST_CORS.test(origin) || CIELOO_CORS.test(origin)) {
                callback(null, true)
                return
            }
            callback(new Error('Origine non autorisee par CORS'))
        },
        methods: ['GET', 'POST'],
    }))

    expressApp.get('/status', (_req: ExpReq, res: ExpRes) => {
        res.json(status())
    })

    expressApp.get('/api/printers', async (_req: ExpReq, res: ExpRes) => {
        try {
            const printers = await listPrintersFromPdfToPrinter()
            res.json(printers.map((printer) => printer.name))
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Erreur inconnue'
            res.status(500).json({ error: message })
        }
    })

    expressApp.get('/api/barcode-printer', (req: ExpReq, res: ExpRes) => {
        // ?target=sheet → imprimante de planches A4 ; sinon imprimante d'étiquettes
        const isSheet = req.query.target === 'sheet'
        const bp = isSheet ? currentSettings.barcodeSheetPrinter : currentSettings.barcodePrinter
        const configured = Boolean(bp?.defaultPrinter)
        res.json({
            configured,
            printerName: configured ? bp.defaultPrinter : null,
            label: bp?.label ?? (isSheet ? 'Planche A4' : 'Étiquettes'),
            paperWidth: bp?.paperWidth ?? null,
            paperHeight: bp?.paperHeight ?? null,
            copies: bp?.copies ?? 1,
        })
    })

    expressApp.get('/api/configured-printers', (_req: ExpReq, res: ExpRes) => {
        const configured = currentSettings.printers
            .filter(p => p.defaultPrinter !== null)
            .map(p => ({
                label: p.label,
                printerName: p.defaultPrinter,
                paperWidth: p.paperWidth,
                paperHeight: p.paperHeight,
                copies: p.copies,
            }))
        res.json(configured)
    })

    expressApp.post('/print-window', express.json(), async (req: ExpReq, res: ExpRes) => {
        const url = typeof req.body?.url === 'string' ? req.body.url.trim() : ''
        if (!url || !/^https?:\/\//i.test(url)) {
            res.status(400).json({ error: 'URL manquante ou invalide' })
            return
        }

        const rawSectionId = req.body?.sectionId
        const sectionId = rawSectionId !== null && rawSectionId !== undefined ? Number(rawSectionId) : null

        try {
            if (sectionId !== null && !isNaN(sectionId)) {
                const config = currentSettings.printers.find(p => p.id === `mp-section-${sectionId}`)
                if (!config?.defaultPrinter) {
                    res.status(400).json({ error: `Aucune imprimante configurée pour la section ${sectionId}` })
                    return
                }
                await printUrlWithWebContents(url, config)
            } else {
                await printUrlToAllPrinters(url)
            }
            res.json({ success: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Erreur inconnue'
            res.status(500).json({ error: message })
        }
    })

    expressApp.post('/print', (_req, res, next) => {
        if (isRateLimited()) {
            res.status(429).json({ error: 'Trop de requetes. Reessayez dans quelques secondes.' })
            return
        }
        next()
    }, upload.single('file'), async (req: ExpReq, res: ExpRes) => {
        const filePath = req.file?.path

        if (!filePath) {
            res.status(400).json({ error: 'Aucun fichier PDF recu' })
            return
        }

        // target=barcode → imprimante d'étiquettes code-barres dédiée
        // target=barcode-sheet → imprimante de planches A4 ; sinon imprimante caisse par défaut
        const target = typeof req.query.target === 'string' ? req.query.target : ''
        let printerName: string | null
        let printSettings: string | undefined
        if (target === 'barcode' || target === 'barcode-sheet') {
            const bp = target === 'barcode-sheet' ? currentSettings.barcodeSheetPrinter : currentSettings.barcodePrinter
            if (!bp?.defaultPrinter) {
                cleanupFile(filePath)
                res.status(400).json({ error: 'Aucune imprimante code-barres configurée' })
                return
            }
            printerName = bp.defaultPrinter
            // -print-settings "noscale" : conserve la taille native du PDF.
            // On force aussi l'orientation pour qu'elle corresponde à la forme du
            // support configuré : sans ça SumatraPDF fait pivoter la page de 90°
            // lorsque l'orientation du PDF diffère de celle du papier par défaut du
            // driver (le code-barres sortait alors à la verticale et coupé).
            const orientation = bp.paperWidth >= bp.paperHeight ? 'landscape' : 'portrait'
            printSettings = `noscale,${orientation}`
        } else {
            printerName = currentSettings.printers[0]?.defaultPrinter ?? null
        }

        try {
            await printWithSumatra(filePath, printerName, printSettings)
            res.json({ success: true })
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Erreur inconnue'
            res.status(500).json({ error: message })
        } finally {
            cleanupFile(filePath)
        }
    })

    expressApp.use((error: unknown, req: ExpReq, res: ExpRes, _next: NextFunction) => {
        cleanupFile(req.file?.path)

        const multerError = error as { code?: string; message?: string }
        if (multerError.code === 'LIMIT_FILE_SIZE') {
            res.status(413).json({ error: `Fichier trop lourd (max ${MAX_FILE_SIZE / 1024 / 1024} Mo)` })
            return
        }

        res.status(400).json({ error: multerError.message ?? 'Erreur upload' })
    })

    return expressApp
}

export async function startPrintServer(printSettings: PrintSettings): Promise<PrintServerStatus> {
    currentSettings = normalizePrintSettings(printSettings)

    if (!currentSettings.enabled) {
        await stopPrintServer()
        return status('Serveur desactive dans les parametres')
    }

    if (server) {
        await stopPrintServer()
    }

    const expressApp = buildExpressApp()

    await new Promise<void>((resolve, reject) => {
        const nextServer = expressApp.listen(currentSettings.port, '127.0.0.1', () => {
            server = nextServer
            resolve()
        })

        nextServer.on('connection', (socket) => {
            openConnections.add(socket)
            socket.on('close', () => openConnections.delete(socket))
        })

        nextServer.once('error', (error) => {
            reject(error)
        })
    })

    return status()
}

export async function applyPrintSettings(printSettings: PrintSettings): Promise<PrintServerStatus> {
    return startPrintServer(printSettings)
}

export function getPrintServerStatus(): PrintServerStatus {
    return status()
}

export async function stopPrintServer(): Promise<void> {
    if (!server) return

    const activeServer = server
    server = null

    for (const conn of openConnections) conn.destroy()
    openConnections.clear()

    await new Promise<void>((resolve) => {
        activeServer.close(() => resolve())
    })
}

