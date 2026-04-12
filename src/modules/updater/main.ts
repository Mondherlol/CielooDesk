import { autoUpdater, AppUpdater } from 'electron-updater'
import { ipcMain, dialog, BrowserWindow, app } from 'electron'

// ─── Configuration ────────────────────────────────────────────────────────────

autoUpdater.autoDownload = true
autoUpdater.autoInstallOnAppQuit = true

// In dev, electron-updater needs a published version to work — disable silently.
const isPackaged = app.isPackaged

// ─── Silent check on startup ──────────────────────────────────────────────────

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
        // Notify renderer only if a manual check was triggered (see flag below)
        if (_manualCheckPending) {
            _manualCheckPending = false
            const win = getMainWindow()
            win?.webContents.send('updater:up-to-date', { version: app.getVersion() })
        }
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

        void dialog.showMessageBox(win, {
            type: 'info',
            title: 'Mise à jour disponible',
            message: `CielooDesk ${info.version} est prêt à être installé.`,
            detail: 'La mise à jour sera installée au prochain redémarrage.\nVoulez-vous redémarrer maintenant ?',
            buttons: ['Redémarrer maintenant', 'Plus tard'],
            defaultId: 0,
            cancelId: 1,
            icon: undefined,
        }).then(({ response }) => {
            if (response === 0) autoUpdater.quitAndInstall(false, true)
        })
    })

    autoUpdater.on('error', (err) => {
        if (_manualCheckPending) {
            _manualCheckPending = false
            const win = getMainWindow()
            void dialog.showErrorBox(
                'Vérification des mises à jour',
                `Impossible de vérifier les mises à jour.\n\n${err.message}`
            )
        }
        // Silently log automatic background errors
        console.error('[updater]', err.message)
    })

    // Silent background check 10 seconds after startup
    setTimeout(() => {
        void (autoUpdater as AppUpdater).checkForUpdates()
    }, 10_000)
}

// ─── IPC: manual check triggered from the menu ────────────────────────────────

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
}
