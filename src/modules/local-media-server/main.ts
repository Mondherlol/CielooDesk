import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { loadSettings } from '../settings/main'

const DEFAULT_PORT = 7842
const MEDIA_PORT = Number.parseInt(process.env.CIELOO_MEDIA_PORT || '', 10) || DEFAULT_PORT

const MIME_TYPES: Record<string, string> = {
    '.apng': 'image/apng',
    '.avif': 'image/avif',
    '.bmp': 'image/bmp',
    '.css': 'text/css; charset=utf-8',
    '.csv': 'text/csv; charset=utf-8',
    '.gif': 'image/gif',
    '.htm': 'text/html; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.m4a': 'audio/mp4',
    '.mov': 'video/quicktime',
    '.mp3': 'audio/mpeg',
    '.mp4': 'video/mp4',
    '.mpeg': 'video/mpeg',
    '.mpg': 'video/mpeg',
    '.oga': 'audio/ogg',
    '.ogg': 'audio/ogg',
    '.ogv': 'video/ogg',
    '.pdf': 'application/pdf',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.txt': 'text/plain; charset=utf-8',
    '.wav': 'audio/wav',
    '.webm': 'video/webm',
    '.webp': 'image/webp',
}

let server: http.Server | null = null
let listeningPort: number | null = null

function getCorsHeaders(): Record<string, string> {
    return {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET,HEAD,OPTIONS',
        'Access-Control-Allow-Headers': 'Range,Content-Type',
        'Access-Control-Expose-Headers': 'Accept-Ranges,Content-Length,Content-Range,Content-Type',
    }
}

function sendEmpty(res: http.ServerResponse, statusCode: number, headers: Record<string, string | number>): void {
    res.writeHead(statusCode, headers)
    res.end()
}

function sendJsonError(res: http.ServerResponse, statusCode: number, message: string): void {
    const payload = Buffer.from(JSON.stringify({ error: message }))
    res.writeHead(statusCode, {
        ...getCorsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': payload.length,
    })
    res.end(payload)
}

function sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    const body = Buffer.from(JSON.stringify(payload))
    res.writeHead(statusCode, {
        ...getCorsHeaders(),
        'Content-Type': 'application/json; charset=utf-8',
        'Content-Length': body.length,
    })
    res.end(body)
}

function hasTraversal(pathname: string): boolean {
    return pathname
        .split(/[\\/]+/)
        .some((segment) => segment === '..')
}

function decodeRequestPath(rawUrl: string): string | null {
    const requestUrl = new URL(rawUrl, `http://127.0.0.1:${MEDIA_PORT}`)
    const decodedPathname = decodeURIComponent(requestUrl.pathname || '/')
    if (!decodedPathname || decodedPathname === '/') return null
    if (decodedPathname.includes('\0')) return null
    if (hasTraversal(decodedPathname)) return null
    return decodedPathname.replace(/^\/+/, '')
}

function resolveAbsoluteFilePath(rawUrl: string): string | null {
    const decoded = decodeRequestPath(rawUrl)
    if (!decoded) return null

    if (/^[A-Za-z]:/.test(decoded)) {
        const normalized = path.win32.normalize(decoded.replace(/\//g, '\\'))
        if (!path.win32.isAbsolute(normalized)) return null
        return normalized
    }

    if (decoded.startsWith('/')) {
        const normalized = path.posix.normalize(decoded)
        if (!path.posix.isAbsolute(normalized)) return null
        return normalized
    }

    return null
}

function getMimeType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase()
    return MIME_TYPES[ext] || 'application/octet-stream'
}

function normalizeComparablePath(filePath: string): string {
    const resolved = path.resolve(filePath)
    return process.platform === 'win32' ? resolved.toLowerCase() : resolved
}

async function isPathAllowedByConfiguredRoot(targetPath: string): Promise<boolean> {
    const configuredRoot = loadSettings().secondDisplayMediaFolder?.trim()
    if (!configuredRoot) return true

    try {
        const rootRealPath = await fs.promises.realpath(configuredRoot)
        const rootStats = await fs.promises.stat(rootRealPath)
        if (!rootStats.isDirectory()) return false

        const comparableRoot = normalizeComparablePath(rootRealPath)
        const comparableTarget = normalizeComparablePath(targetPath)
        const relativePath = path.relative(comparableRoot, comparableTarget)

        return relativePath === '' || (!relativePath.startsWith('..') && !path.isAbsolute(relativePath))
    } catch {
        return false
    }
}

async function statRealFile(filePath: string): Promise<{ realPath: string; stats: fs.Stats }> {
    const realPath = await fs.promises.realpath(filePath)
    const stats = await fs.promises.stat(realPath)
    if (!stats.isFile()) {
        const error = new Error('Not a file') as NodeJS.ErrnoException
        error.code = 'EISDIR'
        throw error
    }
    return { realPath, stats }
}

async function statRealDirectory(dirPath: string): Promise<{ realPath: string; stats: fs.Stats }> {
    const realPath = await fs.promises.realpath(dirPath)
    const stats = await fs.promises.stat(realPath)
    if (!stats.isDirectory()) {
        const error = new Error('Not a directory') as NodeJS.ErrnoException
        error.code = 'ENOTDIR'
        throw error
    }
    return { realPath, stats }
}

function resolveAbsoluteDirectoryPath(rawDir: string): string | null {
    if (!rawDir || rawDir.includes('\0') || hasTraversal(rawDir)) return null

    if (/^[A-Za-z]:/.test(rawDir)) {
        const normalized = path.win32.normalize(rawDir.replace(/\//g, '\\'))
        if (!path.win32.isAbsolute(normalized)) return null
        return normalized
    }

    if (rawDir.startsWith('/')) {
        const normalized = path.posix.normalize(rawDir)
        if (!path.posix.isAbsolute(normalized)) return null
        return normalized
    }

    return null
}

function parseRangeHeader(rangeHeader: string | undefined, fileSize: number):
    | null
    | { invalid: true }
    | { unsatisfiable: true }
    | { start: number; end: number } {
    if (!rangeHeader) return null

    const match = /^bytes=(\d*)-(\d*)$/i.exec(rangeHeader.trim())
    if (!match) return { invalid: true }

    const [, rawStart, rawEnd] = match
    if (!rawStart && !rawEnd) return { invalid: true }

    let start: number
    let end: number

    if (!rawStart) {
        const suffixLength = Number.parseInt(rawEnd, 10)
        if (!Number.isFinite(suffixLength) || suffixLength <= 0) return { invalid: true }
        start = Math.max(fileSize - suffixLength, 0)
        end = fileSize - 1
    } else {
        start = Number.parseInt(rawStart, 10)
        end = rawEnd ? Number.parseInt(rawEnd, 10) : fileSize - 1

        if (!Number.isFinite(start) || !Number.isFinite(end)) return { invalid: true }
        if (start < 0 || end < start) return { invalid: true }
    }

    if (start >= fileSize) return { unsatisfiable: true }

    end = Math.min(end, fileSize - 1)
    return { start, end }
}

function streamFile(req: http.IncomingMessage, res: http.ServerResponse, filePath: string, stats: fs.Stats): void {
    const mimeType = getMimeType(filePath)
    const range = parseRangeHeader(req.headers.range, stats.size)

    if (range && 'invalid' in range) {
        sendJsonError(res, 416, 'Invalid Range header')
        return
    }

    if (range && 'unsatisfiable' in range) {
        res.writeHead(416, {
            ...getCorsHeaders(),
            'Accept-Ranges': 'bytes',
            'Content-Range': `bytes */${stats.size}`,
        })
        res.end()
        return
    }

    const hasRange = Boolean(range && 'start' in range)
    const start = hasRange && range ? range.start : 0
    const end = hasRange && range ? range.end : stats.size - 1
    const chunkSize = end - start + 1

    const headers: Record<string, string | number> = {
        ...getCorsHeaders(),
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'no-store',
        'Content-Type': mimeType,
        'Content-Length': chunkSize,
    }

    if (hasRange) headers['Content-Range'] = `bytes ${start}-${end}/${stats.size}`

    if (req.method === 'HEAD') {
        sendEmpty(res, hasRange ? 206 : 200, headers)
        return
    }

    res.writeHead(hasRange ? 206 : 200, headers)

    const stream = fs.createReadStream(filePath, { start, end })
    stream.on('error', () => {
        if (!res.headersSent) {
            sendJsonError(res, 500, 'Failed to stream media file')
            return
        }
        res.destroy()
    })
    stream.pipe(res)
}

async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    if (!req.url) {
        sendJsonError(res, 400, 'Missing request URL')
        return
    }

    const requestUrl = new URL(req.url, `http://127.0.0.1:${MEDIA_PORT}`)

    if (req.method === 'OPTIONS') {
        sendEmpty(res, 204, getCorsHeaders())
        return
    }

    if (req.method !== 'GET' && req.method !== 'HEAD') {
        sendJsonError(res, 405, 'Method Not Allowed')
        return
    }

    if (requestUrl.pathname === '/api/media-root') {
        sendJson(res, 200, {
            dir: loadSettings().secondDisplayMediaFolder ?? null,
        })
        return
    }

    if (requestUrl.pathname === '/api/list') {
        const rawDir = requestUrl.searchParams.get('dir')
        const decodedDir = rawDir ? decodeURIComponent(rawDir) : ''
        const dirPath = resolveAbsoluteDirectoryPath(decodedDir)

        if (!dirPath) {
            sendJson(res, 200, { files: [], error: 'not found' })
            return
        }

        try {
            const { realPath } = await statRealDirectory(dirPath)
            const isAllowed = await isPathAllowedByConfiguredRoot(realPath)
            if (!isAllowed) {
                sendJsonError(res, 403, 'Directory is outside the configured media folder')
                return
            }

            const entries = await fs.promises.readdir(realPath, { withFileTypes: true })
            const files = entries
                .filter((entry) => entry.isFile())
                .map((entry) => entry.name)

            sendJson(res, 200, { files })
            return
        } catch {
            sendJson(res, 200, { files: [], error: 'not found' })
            return
        }
    }

    const filePath = resolveAbsoluteFilePath(req.url)
    if (!filePath) {
        sendJsonError(res, 400, 'Invalid absolute file path')
        return
    }

    try {
        const { realPath, stats } = await statRealFile(filePath)
        const isAllowed = await isPathAllowedByConfiguredRoot(realPath)
        if (!isAllowed) {
            sendJsonError(res, 403, 'Media file is outside the configured media folder')
            return
        }
        streamFile(req, res, realPath, stats)
    } catch (error) {
        const err = error as NodeJS.ErrnoException
        if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
            sendJsonError(res, 404, 'Media file not found')
            return
        }
        if (err.code === 'EISDIR') {
            sendJsonError(res, 403, 'Directories are not allowed')
            return
        }
        if (err.code === 'EACCES') {
            sendJsonError(res, 403, 'Media file is not readable')
            return
        }

        console.warn('[local-media] request failed:', error)
        sendJsonError(res, 500, 'Failed to serve media file')
    }
}

export function start(): Promise<{ port: number; started: boolean }> {
    if (server) return Promise.resolve({ port: listeningPort || MEDIA_PORT, started: true })

    return new Promise((resolve) => {
        const nextServer = http.createServer((req, res) => {
            void handleRequest(req, res)
        })

        nextServer.on('error', (error: NodeJS.ErrnoException) => {
            if (error.code === 'EADDRINUSE') {
                console.warn(`[local-media] Port ${MEDIA_PORT} is already in use. Media server disabled.`)
            } else {
                console.warn('[local-media] Failed to start media server:', error)
            }
            if (server === nextServer) {
                server = null
                listeningPort = null
            }
            resolve({ port: MEDIA_PORT, started: false })
        })

        nextServer.listen(MEDIA_PORT, '127.0.0.1', () => {
            server = nextServer
            listeningPort = MEDIA_PORT
            console.info(`[local-media] Listening on http://localhost:${MEDIA_PORT}`)
            resolve({ port: MEDIA_PORT, started: true })
        })
    })
}

export function stop(): Promise<void> {
    if (!server) return Promise.resolve()

    return new Promise((resolve) => {
        const activeServer = server
        server = null
        listeningPort = null
        if (!activeServer) {
            resolve()
            return
        }
        activeServer.close(() => resolve())
    })
}
