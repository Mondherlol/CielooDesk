import express, { type NextFunction, type Request as ExpReq, type Response as ExpRes } from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'node:child_process'
import { app, BrowserWindow, session } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { normalizePrintSettings, type PrintSettings, type PrinterConfig } from '../settings/main'

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

function printWithSumatra(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const printer = currentSettings.printers[0]?.defaultPrinter
        if (!printer) {
            reject(new Error('Aucune imprimante configurée'))
            return
        }
        const sumatraPath = resolveSumatraPath()
        if (!fs.existsSync(sumatraPath)) {
            reject(new Error('SumatraPDF.exe introuvable (attendu dans resources/assets).'))
            return
        }
        const args = ['-print-to', printer, '-silent', '-exit-when-done', filePath]
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

        try {
            await printWithSumatra(filePath)
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

