import { ipcMain, safeStorage, app } from 'electron'
import path from 'node:path'
import fs from 'node:fs'

interface StoredCredentials {
    username: string
    /** AES-256 encrypted password, base64-encoded via Electron safeStorage */
    passwordEncrypted: string
}

function credentialsPath(): string {
    return path.join(app.getPath('userData'), 'autologin.json')
}

function readRaw(): StoredCredentials | null {
    try {
        return JSON.parse(fs.readFileSync(credentialsPath(), 'utf-8')) as StoredCredentials
    } catch {
        return null
    }
}

export function registerAutoLoginIpc(): void {
    /** Returns true if credentials are stored on disk */
    ipcMain.handle('autologin:has-credentials', () => readRaw() !== null)

    /** Decrypts and returns stored credentials, or null */
    ipcMain.handle('autologin:get-credentials', (): { username: string; password: string } | null => {
        const raw = readRaw()
        if (!raw || !safeStorage.isEncryptionAvailable()) return null
        try {
            const password = safeStorage.decryptString(Buffer.from(raw.passwordEncrypted, 'base64'))
            return { username: raw.username, password }
        } catch {
            return null
        }
    })

    /** Encrypts and persists credentials */
    ipcMain.handle('autologin:save-credentials', (_e, username: string, password: string) => {
        if (!safeStorage.isEncryptionAvailable()) throw new Error('safeStorage unavailable')
        const enc = safeStorage.encryptString(password).toString('base64')
        fs.writeFileSync(credentialsPath(), JSON.stringify({ username, passwordEncrypted: enc } satisfies StoredCredentials))
    })

    /** Removes stored credentials */
    ipcMain.handle('autologin:clear-credentials', () => {
        try { fs.unlinkSync(credentialsPath()) } catch { /* already absent */ }
    })
}
