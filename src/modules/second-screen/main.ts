import { BrowserWindow, screen, session } from 'electron'
import { loadSettings } from '../settings/main'

let secondScreenWindow: BrowserWindow | null = null
let displayListenersRegistered = false
let bootRetryTimer: NodeJS.Timeout | null = null
let bootRetryCount = 0
let lastSecondScreenUrl = ''
let hasAutoStartedSecondScreen = false
let pendingManualOpen = false
let secondScreenMode: 'fullscreen' | 'windowed' = 'fullscreen'
let secondScreenWindowedBounds: Electron.Rectangle | null = null

const CONTROL_SCHEME = 'cieloo-second-screen'
const BOOT_RETRY_MAX = 10
const BOOT_RETRY_DELAY_MS = 1200
const WINDOWED_MIN_WIDTH = 640
const WINDOWED_MIN_HEIGHT = 360
const WINDOWED_DEFAULT_WIDTH = 1280
const WINDOWED_DEFAULT_HEIGHT = 720

interface SecondScreenOpenOptions {
    focus?: boolean
    forceReload?: boolean
}

interface SecondScreenLoadOptions {
    forceReload?: boolean
}

function isCielooUrl(url: string): boolean {
    try {
        return new URL(url).hostname.endsWith('.cieloo.io')
    } catch {
        return false
    }
}

function findSecondaryDisplay(): Electron.Display | null {
    const displays = screen.getAllDisplays()
    if (displays.length < 2) return null

    const primaryId = screen.getPrimaryDisplay().id
    return displays.find((display) => display.id !== primaryId) ?? null
}

function moveWindowToDisplay(win: BrowserWindow, display: Electron.Display): void {
    win.setBounds({
        x: display.bounds.x,
        y: display.bounds.y,
        width: display.bounds.width,
        height: display.bounds.height,
    })
}

function clearBootRetry(): void {
    if (!bootRetryTimer) return
    clearTimeout(bootRetryTimer)
    bootRetryTimer = null
}

function resetBootRetry(): void {
    bootRetryCount = 0
    clearBootRetry()
}

function clampWindowedBounds(bounds: Electron.Rectangle, display: Electron.Display): Electron.Rectangle {
    const workArea = display.workArea
    const width = Math.max(WINDOWED_MIN_WIDTH, Math.min(bounds.width, workArea.width))
    const height = Math.max(WINDOWED_MIN_HEIGHT, Math.min(bounds.height, workArea.height))
    const maxX = workArea.x + Math.max(0, workArea.width - width)
    const maxY = workArea.y + Math.max(0, workArea.height - height)
    const x = Math.min(Math.max(bounds.x, workArea.x), maxX)
    const y = Math.min(Math.max(bounds.y, workArea.y), maxY)

    return { x, y, width, height }
}

function getDefaultWindowedBounds(display: Electron.Display): Electron.Rectangle {
    const workArea = display.workArea
    const width = Math.min(WINDOWED_DEFAULT_WIDTH, workArea.width)
    const height = Math.min(WINDOWED_DEFAULT_HEIGHT, workArea.height)
    const x = Math.round(workArea.x + (workArea.width - width) / 2)
    const y = Math.round(workArea.y + (workArea.height - height) / 2)

    return { x, y, width, height }
}

function getWindowedBounds(display: Electron.Display): Electron.Rectangle {
    const nextBounds = secondScreenWindowedBounds ?? getDefaultWindowedBounds(display)
    return clampWindowedBounds(nextBounds, display)
}

function rememberWindowedBounds(win: BrowserWindow): void {
    if (win.isDestroyed() || win.isFullScreen()) return
    secondScreenWindowedBounds = win.getBounds()
}

function applySecondScreenMode(win: BrowserWindow, display: Electron.Display): void {
    if (secondScreenMode === 'windowed') {
        win.setFullScreen(false)
        if (win.isMaximized()) win.unmaximize()
        win.setResizable(true)
        win.setMinimumSize(WINDOWED_MIN_WIDTH, WINDOWED_MIN_HEIGHT)
        win.setBounds(getWindowedBounds(display))
        return
    }

    win.setResizable(false)
    win.setFullScreen(false)
    moveWindowToDisplay(win, display)
    win.setFullScreen(true)
}

function resolveTargetUrl(targetUrl?: string): string | null {
    if (targetUrl && isCielooUrl(targetUrl)) return targetUrl
    if (isCielooUrl(lastSecondScreenUrl)) return lastSecondScreenUrl
    return null
}

function rememberSecondScreenTarget(targetUrl?: string): string | null {
    const resolvedUrl = resolveTargetUrl(targetUrl)
    if (!resolvedUrl) return null
    lastSecondScreenUrl = resolvedUrl
    return resolvedUrl
}

function maybeAutoStartSecondScreen(targetUrl?: string): void {
    registerDisplayListeners()
    const resolvedUrl = rememberSecondScreenTarget(targetUrl)
    if (!resolvedUrl) return
    if (!loadSettings().secondDisplayAutoStart) return
    if (hasAutoStartedSecondScreen) return
    if (secondScreenWindow && !secondScreenWindow.isDestroyed()) {
        hasAutoStartedSecondScreen = true
        return
    }
    if (!findSecondaryDisplay()) return

    const win = ensureSecondScreenWindow(resolvedUrl, { focus: false })
    if (win) hasAutoStartedSecondScreen = true
}

function scheduleBootRetry(): void {
    if (bootRetryTimer || bootRetryCount >= BOOT_RETRY_MAX || !lastSecondScreenUrl) return
    bootRetryTimer = setTimeout(() => {
        bootRetryTimer = null
        bootRetryCount += 1
        ensureSecondScreenWindow(lastSecondScreenUrl)
    }, BOOT_RETRY_DELAY_MS)
}

function registerDisplayListeners(): void {
    if (displayListenersRegistered) return
    displayListenersRegistered = true

    screen.on('display-added', () => {
        if (secondScreenWindow && !secondScreenWindow.isDestroyed()) return
        if (pendingManualOpen) {
            const win = ensureSecondScreenWindow(lastSecondScreenUrl)
            if (win) pendingManualOpen = false
            return
        }
        maybeAutoStartSecondScreen(lastSecondScreenUrl)
    })

    screen.on('display-removed', () => {
        const targetDisplay = findSecondaryDisplay()
        if (targetDisplay && secondScreenWindow && !secondScreenWindow.isDestroyed()) {
            applySecondScreenMode(secondScreenWindow, targetDisplay)
            return
        }

        if (!targetDisplay && secondScreenWindow && !secondScreenWindow.isDestroyed()) {
            secondScreenWindow.close()
        }
    })

    screen.on('display-metrics-changed', () => {
        const targetDisplay = findSecondaryDisplay()
        if (!targetDisplay || !secondScreenWindow || secondScreenWindow.isDestroyed()) return
        applySecondScreenMode(secondScreenWindow, targetDisplay)
    })
}

function handleControlNavigation(win: BrowserWindow, url: string): boolean {
    if (!url.startsWith(`${CONTROL_SCHEME}://`)) return false

    const action = url.slice(`${CONTROL_SCHEME}://`.length)

    if (action === 'close') {
        win.close()
        return true
    }

    if (action === 'minimize') {
        win.minimize()
        return true
    }

    if (action === 'refresh') {
        win.reload()
        return true
    }

    if (action === 'windowed') {
        const targetDisplay = screen.getDisplayMatching(win.getBounds())
        secondScreenMode = 'windowed'
        applySecondScreenMode(win, targetDisplay)
        win.focus()
        return true
    }

    if (action === 'fullscreen') {
        rememberWindowedBounds(win)
        const targetDisplay = screen.getDisplayMatching(win.getBounds())
        secondScreenMode = 'fullscreen'
        applySecondScreenMode(win, targetDisplay)
        win.focus()
        return true
    }

    return true
}

function injectWindowControls(win: BrowserWindow): void {
    void win.webContents.executeJavaScript(`
        (() => {
            if (document.getElementById('cieloo-second-screen-toolbar')) return

            const style = document.createElement('style')
            style.textContent = \`
                #cieloo-second-screen-hitbox {
                    position: fixed;
                    inset: 0 0 auto 0;
                    height: 14px;
                    z-index: 2147483646;
                    background: transparent;
                }

                #cieloo-second-screen-toolbar {
                    position: fixed;
                    top: 0;
                    left: 50%;
                    transform: translate(-50%, -110%);
                    display: flex;
                    align-items: center;
                    gap: 8px;
                    padding: 10px 12px;
                    border-radius: 0 0 16px 16px;
                    background: rgba(15, 23, 42, 0.92);
                    box-shadow: 0 12px 30px rgba(0, 0, 0, 0.28);
                    backdrop-filter: blur(10px);
                    -webkit-backdrop-filter: blur(10px);
                    z-index: 2147483647;
                    opacity: 0;
                    pointer-events: none;
                    transition: transform .18s ease, opacity .18s ease;
                    font-family: Inter, ui-sans-serif, system-ui, sans-serif;
                }

                #cieloo-second-screen-toolbar.is-visible {
                    transform: translate(-50%, 0);
                    opacity: 1;
                    pointer-events: auto;
                }

                .cieloo-second-screen-btn {
                    border: none;
                    border-radius: 10px;
                    padding: 9px 12px;
                    color: #e2e8f0;
                    background: rgba(255, 255, 255, 0.08);
                    cursor: pointer;
                    font: inherit;
                    font-size: 13px;
                    font-weight: 700;
                    white-space: nowrap;
                    transition: background .15s ease, transform .15s ease;
                }

                .cieloo-second-screen-btn:hover {
                    background: rgba(255, 255, 255, 0.16);
                    transform: translateY(-1px);
                }

                .cieloo-second-screen-btn.danger {
                    background: rgba(220, 38, 38, 0.88);
                    color: #fff;
                }

                .cieloo-second-screen-btn.danger:hover {
                    background: rgba(239, 68, 68, 0.98);
                }
            \`

            const hitbox = document.createElement('div')
            hitbox.id = 'cieloo-second-screen-hitbox'

            const toolbar = document.createElement('div')
            toolbar.id = 'cieloo-second-screen-toolbar'
            toolbar.innerHTML = \`
                <button class="cieloo-second-screen-btn" data-action="refresh">Rafraichir</button>
                <button class="cieloo-second-screen-btn" data-action="windowed">Fenetre</button>
                <button class="cieloo-second-screen-btn" data-action="fullscreen">Plein ecran</button>
                <button class="cieloo-second-screen-btn" data-action="minimize">Reduire</button>
                <button class="cieloo-second-screen-btn danger" data-action="close">Fermer</button>
            \`

            let hideTimer = null

            const showToolbar = () => {
                if (hideTimer) {
                    clearTimeout(hideTimer)
                    hideTimer = null
                }
                toolbar.classList.add('is-visible')
            }

            const hideToolbarSoon = () => {
                if (hideTimer) clearTimeout(hideTimer)
                hideTimer = setTimeout(() => {
                    toolbar.classList.remove('is-visible')
                }, 220)
            }

            hitbox.addEventListener('mouseenter', showToolbar)
            toolbar.addEventListener('mouseenter', showToolbar)
            toolbar.addEventListener('mouseleave', hideToolbarSoon)

            toolbar.addEventListener('click', (event) => {
                const target = event.target
                if (!(target instanceof HTMLElement)) return
                const action = target.dataset.action
                if (!action) return
                window.location.href = '${CONTROL_SCHEME}://' + action
            })

            document.documentElement.appendChild(style)
            document.body.appendChild(hitbox)
            document.body.appendChild(toolbar)
        })();
    `).catch(() => {
        // Ignore injection failures on transient loads.
    })
}

function loadIntoSecondScreen(win: BrowserWindow, targetUrl: string, options: SecondScreenLoadOptions = {}): void {
    lastSecondScreenUrl = targetUrl

    if (win.webContents.getURL() !== targetUrl) {
        void win.loadURL(targetUrl)
        return
    }

    if (options.forceReload) {
        win.webContents.reloadIgnoringCache()
    }
}

export function ensureSecondScreenWindow(targetUrl?: string, options: SecondScreenOpenOptions = {}): BrowserWindow | null {
    registerDisplayListeners()
    const shouldFocus = options.focus ?? true

    const resolvedUrl = rememberSecondScreenTarget(targetUrl)
    if (!resolvedUrl) {
        clearBootRetry()
        return null
    }

    if (secondScreenWindow && !secondScreenWindow.isDestroyed()) {
        const targetDisplay = findSecondaryDisplay()
        if (targetDisplay) applySecondScreenMode(secondScreenWindow, targetDisplay)
        if (secondScreenWindow.isMinimized()) secondScreenWindow.restore()
        loadIntoSecondScreen(secondScreenWindow, resolvedUrl, { forceReload: options.forceReload })
        secondScreenWindow.show()
        if (shouldFocus) secondScreenWindow.focus()
        clearBootRetry()
        return secondScreenWindow
    }

    const targetDisplay = findSecondaryDisplay()
    if (!targetDisplay) {
        scheduleBootRetry()
        return null
    }

    clearBootRetry()

    secondScreenWindow = new BrowserWindow({
        x: targetDisplay.bounds.x,
        y: targetDisplay.bounds.y,
        width: targetDisplay.bounds.width,
        height: targetDisplay.bounds.height,
        backgroundColor: '#000000',
        title: 'CielooPos - Retour client',
        frame: true,
        autoHideMenuBar: true,
        show: false,
        resizable: true,
        minimizable: true,
        maximizable: true,
        fullscreenable: true,
        webPreferences: {
            session: session.defaultSession,
            contextIsolation: true,
            sandbox: true,
            nodeIntegration: false,
            spellcheck: false,
        },
    })

    secondScreenWindow.removeMenu()
    secondScreenWindow.webContents.on('before-input-event', (_event, input) => {
        if (input.type !== 'keyDown') return

        const isDevToolsShortcut = input.key === 'F12'
            || ((input.control || input.meta) && input.shift && input.key.toLowerCase() === 'i')

        if (!isDevToolsShortcut) return

        secondScreenWindow?.webContents.toggleDevTools()
    })
    secondScreenWindow.webContents.on('will-navigate', (event, url) => {
        if (!secondScreenWindow) return
        if (!handleControlNavigation(secondScreenWindow, url)) return
        event.preventDefault()
    })
    secondScreenWindow.once('ready-to-show', () => {
        if (!secondScreenWindow || secondScreenWindow.isDestroyed()) return
        applySecondScreenMode(secondScreenWindow, targetDisplay)
        secondScreenWindow.show()
    })
    secondScreenWindow.webContents.once('did-finish-load', () => {
        if (!secondScreenWindow || secondScreenWindow.isDestroyed()) return
        applySecondScreenMode(secondScreenWindow, targetDisplay)
        if (!secondScreenWindow.isVisible()) secondScreenWindow.show()
        injectWindowControls(secondScreenWindow)
    })
    secondScreenWindow.webContents.on('did-navigate', () => {
        if (!secondScreenWindow || secondScreenWindow.isDestroyed()) return
        injectWindowControls(secondScreenWindow)
    })
    secondScreenWindow.webContents.on('did-navigate-in-page', () => {
        if (!secondScreenWindow || secondScreenWindow.isDestroyed()) return
        injectWindowControls(secondScreenWindow)
    })
    secondScreenWindow.on('closed', () => {
        secondScreenWindow = null
    })
    secondScreenWindow.on('move', () => {
        if (!secondScreenWindow) return
        rememberWindowedBounds(secondScreenWindow)
    })
    secondScreenWindow.on('resize', () => {
        if (!secondScreenWindow) return
        rememberWindowedBounds(secondScreenWindow)
    })
    secondScreenWindow.on('unresponsive', () => {
        secondScreenWindow?.reload()
    })

    loadIntoSecondScreen(secondScreenWindow, resolvedUrl)

    return secondScreenWindow
}

export function startSecondScreen(targetUrl: string, options: SecondScreenOpenOptions = {}): BrowserWindow | null {
    resetBootRetry()
    hasAutoStartedSecondScreen = true
    pendingManualOpen = true
    const openOptions = { ...options, forceReload: true }
    const win = ensureSecondScreenWindow(targetUrl, openOptions)
    if (win) pendingManualOpen = false
    setTimeout(() => {
        const retryWin = ensureSecondScreenWindow(targetUrl, openOptions)
        if (retryWin) pendingManualOpen = false
    }, 800)
    return win
}

export function syncSecondScreen(targetUrl: string, options: SecondScreenLoadOptions = {}): void {
    if (!isCielooUrl(targetUrl)) return
    registerDisplayListeners()
    rememberSecondScreenTarget(targetUrl)

    if (!secondScreenWindow || secondScreenWindow.isDestroyed()) {
        maybeAutoStartSecondScreen(targetUrl)
        return
    }

    loadIntoSecondScreen(secondScreenWindow, targetUrl, options)
}
