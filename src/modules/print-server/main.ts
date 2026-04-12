import express, { type NextFunction, type Request, type Response } from 'express'
import cors from 'cors'
import multer from 'multer'
import { execFile } from 'node:child_process'
import { app, BrowserWindow } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

import { normalizePrintSettings, type PrintSettings } from '../settings/main'

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

function uploadsDir(): string {
    return path.join(app.getPath('userData'), 'cieloo-print-uploads')
}

function resolveSumatraPath(): string {
    const candidates = app.isPackaged
        ? [
            // Preferred location when using electron-builder extraResources.
            path.join(process.resourcesPath, 'assets', 'SumatraPDF.exe'),
            // Fallback if file ended up unpacked from app.asar.
            path.join(process.resourcesPath, 'app.asar.unpacked', 'assets', 'SumatraPDF.exe'),
            // pdf-to-printer bundles its own Sumatra binary here.
            path.join(process.resourcesPath, 'app.asar.unpacked', 'node_modules', 'pdf-to-printer', 'dist', 'SumatraPDF-3.4.6-32.exe'),
            path.join(process.resourcesPath, 'SumatraPDF.exe'),
        ]
        : [
            // Dev layout.
            path.join(app.getAppPath(), 'assets', 'SumatraPDF.exe'),
            path.join(app.getAppPath(), 'SumatraPDF.exe'),
        ]

    return candidates.find((candidate) => fs.existsSync(candidate)) ?? candidates[0]
}

function status(message?: string): PrintServerStatus {
    const port = currentSettings.port
    const isActive = Boolean(server)
    const sumatraFound = fs.existsSync(resolveSumatraPath())

    return {
        active: isActive,
        ready: isActive && Boolean(currentSettings.defaultPrinter) && sumatraFound,
        port,
        serverUrl: `http://127.0.0.1:${port}`,
        printer: currentSettings.defaultPrinter,
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

function buildSumatraArgs(filePath: string): string[] {
    const o = currentSettings
    return [
        '-print-to', o.defaultPrinter ?? '',
        '-print-settings', `${o.copies}x,${o.orientation},${o.color ? 'color' : 'monochrome'},${o.scale},paper=${o.paperWidth}x${o.paperHeight}mm,margins=${o.margins}`,
        '-silent',
        '-exit-when-done',
        filePath,
    ]
}

function printWithSumatra(filePath: string): Promise<void> {
    return new Promise((resolve, reject) => {
        if (!currentSettings.defaultPrinter) {
            reject(new Error('Aucune imprimante configurée'))
            return
        }

        const sumatraPath = resolveSumatraPath()
        if (!fs.existsSync(sumatraPath)) {
            reject(new Error('SumatraPDF.exe introuvable (attendu dans resources/assets).'))
            return
        }

        const args = buildSumatraArgs(filePath)
        execFile(sumatraPath, args, { timeout: PRINT_TIMEOUT }, (error) => {
            if (error) {
                reject(error)
                return
            }
            resolve()
        })
    })
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

    expressApp.get('/status', (_req: Request, res: Response) => {
        res.json(status())
    })

    expressApp.get('/api/printers', async (_req: Request, res: Response) => {
        try {
            const printers = await listPrintersFromPdfToPrinter()
            res.json(printers.map((printer) => printer.name))
        } catch (error) {
            const message = error instanceof Error ? error.message : 'Erreur inconnue'
            res.status(500).json({ error: message })
        }
    })

    expressApp.post('/print', (req, res, next) => {
        if (isRateLimited()) {
            res.status(429).json({ error: 'Trop de requetes. Reessayez dans quelques secondes.' })
            return
        }
        next()
    }, upload.single('file'), async (req: Request, res: Response) => {
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

    expressApp.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
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

    await new Promise<void>((resolve) => {
        activeServer.close(() => resolve())
    })
}
