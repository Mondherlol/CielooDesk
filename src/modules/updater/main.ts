import { autoUpdater, AppUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'

// ─── Configuration ────────────────────────────────────────────────────────────

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

const isPackaged = app.isPackaged

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
    if (!isPackaged) return

    autoUpdater.on('update-available', (info) => {
        const win = getMainWindow()
        if (!win) return
        win.webContents.send('updater:update-available', {
            version: info.version,
            releaseNotes: info.releaseNotes ?? null,
        })
    })

    autoUpdater.on('update-not-available', () => {
        _manualCheckPending = false
        const win = getMainWindow()
        win?.webContents.send('updater:up-to-date', { version: app.getVersion() })
    })

    autoUpdater.on('download-progress', (progress) => {
        const win = getMainWindow()
        win?.webContents.send('updater:download-progress', {
            percent: Math.round(progress.percent),
            transferred: progress.transferred,
            total: progress.total,
        })
    })

    autoUpdater.on('update-downloaded', (info) => {
        const win = getMainWindow()
        if (!win) {
            autoUpdater.quitAndInstall(false, true)
            return
        }
        win.webContents.send('updater:update-downloaded', { version: info.version })
    })

    autoUpdater.on('error', (err) => {
        const win = getMainWindow()
        if (_manualCheckPending) {
            _manualCheckPending = false
            win?.webContents.send('updater:error', { message: err.message })
        }
        // Signal splash to not wait forever on error
        win?.webContents.send('updater:up-to-date', { version: app.getVersion() })
        console.error('[updater]', err.message)
    })

    // Check 2 seconds after startup — send check-started so the splash can sync
    setTimeout(() => {
        const win = getMainWindow()
        win?.webContents.send('updater:check-started')
        void (autoUpdater as AppUpdater).checkForUpdates()
    }, 2_000)
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

let _manualCheckPending = false

export function registerUpdaterIpc(): void {
    ipcMain.handle('updater:check', async () => {
        if (!isPackaged) {
            return { status: 'dev' }
        }
        _manualCheckPending = true
        await (autoUpdater as AppUpdater).checkForUpdates()
        return { status: 'checking' }
    })

    ipcMain.handle('updater:install-now', () => {
        autoUpdater.quitAndInstall(false, true)
    })

    ipcMain.handle('app:icon-url', () => {
        const iconPath = app.isPackaged
            ? path.join(process.resourcesPath, 'assets/img/512_rounded.png')
            : path.join(app.getAppPath(), 'assets/img/512_rounded.png')
        try {
            const data = fs.readFileSync(iconPath)
            return `data:image/png;base64,${data.toString('base64')}`
        } catch {
            return null
        }
    })
}
