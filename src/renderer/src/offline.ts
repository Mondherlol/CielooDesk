// Offline fallback page script
// Loaded when did-fail-load fires with a network error on a cieloo URL.
// Uses window.cieloo.net.reloadLast (exposed by preload) to recover.

/// <reference path="./types/types.d.ts" />

const COUNTDOWN_SEC = 30

const numEl     = document.getElementById('ol-num')!
const labelEl   = document.getElementById('ol-label')!
const spinnerEl = document.getElementById('ol-spinner') as HTMLElement
const statusEl  = document.getElementById('ol-status')!
const retryBtn  = document.getElementById('ol-retry') as HTMLButtonElement

let countdown = COUNTDOWN_SEC
let cdTimer: ReturnType<typeof setInterval> | null = null
let checking = false

// Connectivity check done in the main process via net.request (Electron's
// native HTTP stack). This avoids the false-positive of pinging localhost
// when the offline.html page itself is served from localhost:5173.
async function ping(): Promise<boolean> {
    return window.cieloo.net.check()
}

function setCheckingUI(on: boolean): void {
    spinnerEl.style.display = on ? 'block' : 'none'
    labelEl.textContent = on ? 'Vérification…' : 'Nouvelle tentative dans'
    numEl.style.display = on ? 'none' : ''
    retryBtn.disabled = on
}

function setStatus(msg: string, cls: '' | 'err' | 'ok' = ''): void {
    statusEl.textContent = msg
    statusEl.className = cls
}

function startCountdown(): void {
    countdown = COUNTDOWN_SEC
    numEl.textContent = String(countdown)
    setCheckingUI(false)
    setStatus('')
    if (cdTimer) clearInterval(cdTimer)
    cdTimer = setInterval(() => {
        countdown--
        if (countdown <= 0) {
            if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
            void doRetry()
        } else {
            numEl.textContent = String(countdown)
        }
    }, 1000)
}

async function doRetry(): Promise<void> {
    if (checking) return
    checking = true
    if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
    setCheckingUI(true)
    setStatus('')

    const ok = await ping()
    if (ok) {
        setStatus('Connexion rétablie !', 'ok')
        // Small delay so user sees the confirmation before the page transitions
        setTimeout(() => {
            void window.cieloo.net.reloadLast()
            // Main will call loadURL — this page will unload on success,
            // or did-fail-load will bring us back here if still offline.
        }, 600)
    } else {
        checking = false
        setStatus('Toujours hors ligne.', 'err')
        setTimeout(() => startCountdown(), 2000)
    }
}

retryBtn.addEventListener('click', () => void doRetry())

// Auto-retry when the OS detects the interface is back
window.addEventListener('online', () => void doRetry())

startCountdown()
