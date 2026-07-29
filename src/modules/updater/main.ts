import { autoUpdater, AppUpdater } from 'electron-updater'
import { ipcMain, BrowserWindow, app } from 'electron'
import fs from 'fs'
import path from 'path'
import { loadSettings } from '../settings/main'

// ─── Configuration ────────────────────────────────────────────────────────────

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

const isPackaged = app.isPackaged

// Feed de mise à jour : le dashboard Cieloo (monitoring.cieloo.io), plus GitHub.
// electron-updater (provider "generic") lit <feed>/latest.yml puis télécharge le
// binaire. Le manifeste est généré à la volée par le dashboard depuis la dernière
// version Windows de l'app « caisla ».
const DASHBOARD_URL = (process.env.DASHBOARD_API_URL ?? 'https://monitoring.cieloo.io/').replace(/\/+$/, '')
const UPDATE_APP_REF = 'caisla'
const UPDATE_PLATFORM = 'windows'
const UPDATE_FEED_URL = `${DASHBOARD_URL}/api/updates/${UPDATE_APP_REF}/${UPDATE_PLATFORM}/`

let _feedConfigured = false
function configureFeed(): void {
    if (_feedConfigured) return
    autoUpdater.setFeedURL({ provider: 'generic', url: UPDATE_FEED_URL })
    _feedConfigured = true
}

// ─── Init ─────────────────────────────────────────────────────────────────────

export function initAutoUpdater(getMainWindow: () => BrowserWindow | null): void {
    if (!isPackaged) return

    configureFeed()

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

    // Check 2 seconds after startup — send check-started so the splash can sync.
    // Désactivable dans les paramètres (Démarrage) : la vérification manuelle via
    // le menu Support (updater:check) reste toujours possible, les listeners
    // ci-dessus servent aux deux chemins.
    setTimeout(() => {
        if (!loadSettings().autoUpdateCheck) return
        const win = getMainWindow()
        win?.webContents.send('updater:check-started')
        void (autoUpdater as AppUpdater).checkForUpdates()
    }, 2_000)
}

// ─── IPC ──────────────────────────────────────────────────────────────────────

let _manualCheckPending = false

export function registerUpdaterIpc(): void {
    // Le splash s'en sert pour savoir s'il doit attendre un résultat de
    // vérification : en dev ou si autoUpdateCheck est désactivé, aucun
    // événement updater n'arrivera jamais.
    ipcMain.handle('updater:will-auto-check', () => isPackaged && loadSettings().autoUpdateCheck !== false)

    ipcMain.handle('updater:check', async () => {
        if (!isPackaged) {
            return { status: 'dev' }
        }
        configureFeed()
        _manualCheckPending = true
        await (autoUpdater as AppUpdater).checkForUpdates()
        return { status: 'checking' }
    })

    ipcMain.handle('updater:install-now', () => {
        autoUpdater.quitAndInstall(false, true)
    })

    ipcMain.handle('app:icon-url', () => {
        const iconPath = app.isPackaged
            ? path.join(process.resourcesPath, 'assets/img/logo_complet.png')
            : path.join(app.getAppPath(), 'assets/img/logo_complet.png')
        try {
            const data = fs.readFileSync(iconPath)
            return `data:image/png;base64,${data.toString('base64')}`
        } catch {
            return null
        }
    })
}
