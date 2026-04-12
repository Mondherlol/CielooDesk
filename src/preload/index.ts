import { contextBridge, ipcRenderer } from 'electron'
import { initAutoLoginPreload } from '../modules/auto-login/preload'
<<<<<<< HEAD
import type { AppSettings, PrintSettings } from '../modules/settings/main'
=======
import type { AppSettings, HeaderTheme, PrintSettings } from '../modules/settings/main'
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
import type { PrintServerStatus } from '../modules/print-server/main'

// ─── IPC Bridge ───────────────────────────────────────────────────────────────

contextBridge.exposeInMainWorld('cieloo', {

    config: {
        get: (): Promise<{ instance?: string }> =>
            ipcRenderer.invoke('config:get'),
<<<<<<< HEAD
        getBootstrapInstance: (): Promise<{ instance: string; source: 'clipboard' | 'exe' } | null> =>
            ipcRenderer.invoke('config:get-bootstrap-instance'),
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
        saveInstance: (instance: string): Promise<void> =>
            ipcRenderer.invoke('config:save-instance', instance),
        clear: (): Promise<void> =>
            ipcRenderer.invoke('config:clear')
    },

    autoLogin: {
        hasCredentials: (): Promise<boolean> =>
            ipcRenderer.invoke('autologin:has-credentials'),
        getCredentials: (): Promise<{ username: string; password: string } | null> =>
            ipcRenderer.invoke('autologin:get-credentials'),
        saveCredentials: (username: string, password: string): Promise<void> =>
            ipcRenderer.invoke('autologin:save-credentials', username, password),
        clearCredentials: (): Promise<void> =>
            ipcRenderer.invoke('autologin:clear-credentials')
    },

    settings: {
        get: (): Promise<AppSettings> =>
            ipcRenderer.invoke('settings:get'),
        set: (key: string, value: boolean | string): Promise<AppSettings> =>
            ipcRenderer.invoke('settings:set', key, value),
        setShortcuts: (shortcuts: AppSettings['shortcuts']): Promise<AppSettings> =>
            ipcRenderer.invoke('settings:set-shortcuts', shortcuts),
        resetShortcuts: (): Promise<AppSettings> =>
            ipcRenderer.invoke('settings:reset-shortcuts'),
        open: (): Promise<void> =>
            ipcRenderer.invoke('settings:open')
    },

    print: {
        getPrinters: (): Promise<Array<{ name: string; isDefault: boolean }>> =>
            ipcRenderer.invoke('print:get-printers'),
        getConfig: (): Promise<PrintSettings> =>
            ipcRenderer.invoke('print:get-config'),
        getStatus: (): Promise<PrintServerStatus> =>
            ipcRenderer.invoke('print:get-status'),
        saveConfig: (print: Partial<PrintSettings>): Promise<{ config: PrintSettings; status: PrintServerStatus }> =>
            ipcRenderer.invoke('print:save-config', print),
    },

    nav: {
        goBack: (): Promise<void> => ipcRenderer.invoke('nav:go-back'),
        goForward: (): Promise<void> => ipcRenderer.invoke('nav:go-forward'),
        canGoBack: (): Promise<boolean> => ipcRenderer.invoke('nav:can-go-back'),
        canGoForward: (): Promise<boolean> => ipcRenderer.invoke('nav:can-go-forward'),
    },

    net: {
        reloadLast: (): Promise<void> => ipcRenderer.invoke('net:reload-last'),
        check: (): Promise<boolean> => ipcRenderer.invoke('net:check'),
<<<<<<< HEAD
    },

    app: {
        version: (): Promise<string> => ipcRenderer.invoke('app:version'),
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    }

})

// ─── Module hooks ─────────────────────────────────────────────────────────────

initAutoLoginPreload()

// ─── Offline IPC from main process ────────────────────────────────────────────
// Main sends 'net:offline' when it blocks a navigation (will-navigate guard).
// We show the overlay immediately so the PHP page stays visible behind it.

let _triggerOfflineOverlay: (() => void) | null = null

ipcRenderer.on('net:offline', () => {
    _triggerOfflineOverlay?.()
})

// ─── Helpers ──────────────────────────────────────────────────────────────────

function isExternalPage(): boolean {
    const h = window.location.href
    return !h.startsWith('file://') && !h.includes('localhost')
}

<<<<<<< HEAD
=======
type HeaderThemeStyle = {
    barBackground: string
    barBorder: string
    textColor: string
    buttonBackground: string
    buttonBackgroundHover: string
    buttonIconColor: string
    logoBackground: string
    logoColor: string
}

function resolveHeaderTheme(theme: HeaderTheme): HeaderTheme {
    if (theme !== 'system') return theme
    return 'light'
}

function getHeaderThemeStyle(theme: HeaderTheme): HeaderThemeStyle {
    if (theme === 'sky-blue') {
        return {
            barBackground: 'linear-gradient(180deg, #e8f4ff 0%, #d7ecff 100%)',
            barBorder: '#8ac4f5',
            textColor: '#0b3b63',
            buttonBackground: 'rgba(24, 119, 185, 0.16)',
            buttonBackgroundHover: 'rgba(24, 119, 185, 0.28)',
            buttonIconColor: '#0f4f84',
            logoBackground: 'linear-gradient(135deg, #38bdf8, #1d4ed8)',
            logoColor: '#ffffff',
        }
    }

    return {
        barBackground: 'linear-gradient(180deg, #f8f9fa 0%, #f3f4f6 100%)',
        barBorder: '#e5e7eb',
        textColor: '#111827',
        buttonBackground: 'rgba(0,0,0,0.05)',
        buttonBackgroundHover: 'rgba(0,0,0,0.1)',
        buttonIconColor: '#374151',
        logoBackground: 'linear-gradient(135deg, #3b82f6, #6366f1)',
        logoColor: '#ffffff',
    }
}
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be

// ─── Injected keyframe styles (into <html> early, before body exists) ─────────

function injectBaseStyles(): void {
    if (!isExternalPage()) return
<<<<<<< HEAD
    if (!document.documentElement) return
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    const s = document.createElement('style')
    s.textContent = `
        html,body{margin:0!important;padding:0!important;border:0!important;}
        @keyframes _cl_spin    { to { transform: rotate(360deg); } }
        @keyframes _cl_fadein  { from { opacity:0; transform:scale(.7); } to { opacity:1; transform:scale(1); } }
        @keyframes _cl_fadeout { from { opacity:1; } to { opacity:0; transform:scale(.7); } }
    `
    document.documentElement.appendChild(s)
}

injectBaseStyles()

// ─── All DOM-dependent injections run on DOMContentLoaded ─────────────────────

<<<<<<< HEAD
function isSettingsPage(): boolean {
    const href = window.location.href
    return href.includes('settings.html') || href.includes('print-settings.html') || href.includes('contact.html')
}

function runInjections(): void {
    if (isSettingsPage()) return
    if (isExternalPage()) injectOverlays()
}

// Always register for every future page navigation
document.addEventListener('DOMContentLoaded', runInjections)
// Also run immediately if the first page's DOM is already parsed
if (document.readyState !== 'loading') runInjections()
=======
document.addEventListener('DOMContentLoaded', () => {
    if (!isExternalPage()) return
    injectCustomTitleBar()
    injectOverlays()
})

// ─── Custom title bar with nav buttons and page title ────────────────────────

function injectCustomTitleBar(): void {
    if (document.getElementById('_cl_titlebar')) return

    const defaultTheme = getHeaderThemeStyle('light')

    // Create title bar wrapper
    const titleBar = document.createElement('div')
    titleBar.id = '_cl_titlebar'
    titleBar.style.cssText = [
        'position:fixed', 'top:0', 'left:0', 'right:0',
        'height:40px',
        'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:space-between',
        `background:${defaultTheme.barBackground}`,
        `border-bottom:1px solid ${defaultTheme.barBorder}`,
        'padding:0 12px',
        'font-family:Inter, ui-sans-serif, system-ui, -apple-system, sans-serif',
        '-webkit-app-region:drag',  // Allow window dragging
        'user-select:none',
    ].join(';')

    // ─── LEFT: Back/Forward buttons ───────────────────────────────────────
    const navBox = document.createElement('div')
    navBox.style.cssText = [
        'display:flex', 'align-items:center', 'gap:4px',
        '-webkit-app-region:no-drag',
    ].join(';')

    function makeNavBtn(svg: string, title: string, onClick: () => void): HTMLButtonElement {
        const btn = document.createElement('button')
        btn.title = title
        btn.style.cssText = [
            'width:32px', 'height:32px',
            'border:none', 'border-radius:6px',
            `background:${defaultTheme.buttonBackground}`,
            `color:${defaultTheme.buttonIconColor}`,
            'display:flex', 'align-items:center', 'justify-content:center',
            'cursor:pointer',
            'transition:background .15s, color .15s',
            'flex-shrink:0',
            'padding:0',
        ].join(';')
        btn.innerHTML = svg
        btn.dataset.bg = defaultTheme.buttonBackground
        btn.dataset.bgHover = defaultTheme.buttonBackgroundHover
        btn.onmouseenter = () => { btn.style.background = btn.dataset.bgHover ?? defaultTheme.buttonBackgroundHover }
        btn.onmouseleave = () => { btn.style.background = btn.dataset.bg ?? defaultTheme.buttonBackground }
        btn.onclick = onClick
        return btn
    }

    const SVG_BACK = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>`
    const SVG_FORWARD = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>`

    const btnBack = makeNavBtn(SVG_BACK, 'Retour', () => void ipcRenderer.invoke('nav:go-back'))
    const btnForward = makeNavBtn(SVG_FORWARD, 'Suivant', () => void ipcRenderer.invoke('nav:go-forward'))

    navBox.appendChild(btnBack)
    navBox.appendChild(btnForward)

    // Update button state
    async function updateNavState(): Promise<void> {
        const canBack = await ipcRenderer.invoke('nav:can-go-back') as boolean
        const canForward = await ipcRenderer.invoke('nav:can-go-forward') as boolean
        btnBack.style.opacity = canBack ? '1' : '0.4'
        btnBack.style.cursor = canBack ? 'pointer' : 'default'
        btnForward.style.opacity = canForward ? '1' : '0.4'
        btnForward.style.cursor = canForward ? 'pointer' : 'default'
    }
    void updateNavState()

    // ─── CENTER: Logo + Page title ────────────────────────────────────────
    const centerBox = document.createElement('div')
    centerBox.style.cssText = [
        'flex:1', 'display:flex', 'align-items:center', 'justify-content:center', 'gap:8px',
        'min-width:0',
    ].join(';')

    const logo = document.createElement('div')
    logo.style.cssText = [
        'width:24px', 'height:24px', 'border-radius:5px',
        `background:${defaultTheme.logoBackground}`,
        'display:flex', 'align-items:center', 'justify-content:center',
        'font-size:0.85rem', 'font-weight:800', `color:${defaultTheme.logoColor}`,
        'flex-shrink:0',
    ].join(';')
    logo.textContent = 'C'

    const pageTitle = document.createElement('span')
    pageTitle.style.cssText = [
        'font-size:13px', 'font-weight:500', `color:${defaultTheme.textColor}`,
        'white-space:nowrap', 'overflow:hidden', 'text-overflow:ellipsis',
    ].join(';')
    pageTitle.textContent = document.title || 'CielooDesk'

    centerBox.appendChild(logo)
    centerBox.appendChild(pageTitle)

    // Update title when page changes
    const observer = new MutationObserver(() => {
        pageTitle.textContent = document.title || 'CielooDesk'
    })
    observer.observe(document.querySelector('title') || document.head, { childList: true, subtree: true, characterData: true })

    // ─── Assemble and inject ──────────────────────────────────────────────
    titleBar.appendChild(navBox)
    titleBar.appendChild(centerBox)
    document.body.appendChild(titleBar)

    // Add padding to body for title bar height
    const originalPadding = document.body.style.paddingTop
    document.body.style.paddingTop = '40px'

    // Keyboard shortcuts
    window.addEventListener('keydown', (e) => {
        if (e.altKey && e.key === 'ArrowLeft') { e.preventDefault(); void ipcRenderer.invoke('nav:go-back') }
        if (e.altKey && e.key === 'ArrowRight') { e.preventDefault(); void ipcRenderer.invoke('nav:go-forward') }
    })

    // Apply configured header theme (independent from OS when user picks a fixed option)
    void ipcRenderer.invoke('settings:get').then((s: AppSettings) => {
        const resolved = resolveHeaderTheme(s.headerTheme ?? 'system')
        const t = getHeaderThemeStyle(resolved)
        titleBar.style.background = t.barBackground
        titleBar.style.borderBottom = `1px solid ${t.barBorder}`
        pageTitle.style.color = t.textColor
        logo.style.background = t.logoBackground
        logo.style.color = t.logoColor
            ;[btnBack, btnForward].forEach(btn => {
                btn.style.color = t.buttonIconColor
                btn.style.background = t.buttonBackground
                btn.dataset.bg = t.buttonBackground
                btn.dataset.bgHover = t.buttonBackgroundHover
            })
    })
}

// ─── Back / Forward navigation buttons ───────────────────────────────────────
// [Legacy function kept for compatibility, but now handled by custom title bar]
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be

// ─── Splash + offline overlays ────────────────────────────────────────────────

function injectOverlays(): void {
    if (document.getElementById('cieloo-overlays')) return

    // ── SVG icons ─────────────────────────────────────────────────────────────
    const SVG_WIFI_OFF = `<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <line x1="1" y1="1" x2="23" y2="23"/>
        <path d="M16.72 11.06A10.94 10.94 0 0 1 19 12.55"/>
        <path d="M5 12.55a10.94 10.94 0 0 1 5.17-2.39"/>
        <path d="M10.71 5.05A16 16 0 0 1 22.56 9"/>
        <path d="M1.42 9a15.91 15.91 0 0 1 4.7-2.88"/>
        <path d="M8.53 16.11a6 6 0 0 1 6.95 0"/>
        <line x1="12" y1="20" x2="12.01" y2="20"/>
    </svg>`

    const SVG_RETRY = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <polyline points="23 4 23 10 17 10"/>
        <path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/>
    </svg>`

    // ── Styles ────────────────────────────────────────────────────────────────
    const styleEl = document.createElement('style')
    styleEl.textContent = `
        #cieloo-overlays *{box-sizing:border-box;}
<<<<<<< HEAD
=======
        #cieloo-splash{
            font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
            position:fixed;inset:0;z-index:2147483647;background:#fff;
            display:flex;flex-direction:column;align-items:center;justify-content:center;gap:18px;
            transition:opacity .45s ease;
        }
        #cieloo-splash.cieloo-hidden{opacity:0;pointer-events:none;}
        .cieloo-logo{width:60px;height:60px;border-radius:16px;
            background:linear-gradient(135deg,#3b82f6,#6366f1);
            display:flex;align-items:center;justify-content:center;
            font-size:1.7rem;font-weight:800;color:#fff;
            box-shadow:0 6px 20px rgba(59,130,246,.25);flex-shrink:0;}
        .cieloo-title{color:#111827;font-size:1.35rem;font-weight:800;letter-spacing:-.02em;}
        .cieloo-spinner-lg{width:32px;height:32px;
            border:3px solid rgba(59,130,246,.18);border-top-color:#3b82f6;
            border-radius:50%;animation:_cl_spin .7s linear infinite;}

>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
        /* ── Offline overlay ── */
        #cieloo-offline{
            font-family:Inter,ui-sans-serif,system-ui,-apple-system,sans-serif;
            position:fixed;inset:0;z-index:2147483647;
            background:rgba(241,245,255,0.96);
            backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px);
            display:none;align-items:center;justify-content:center;
        }
        #cieloo-offline.cieloo-visible{display:flex;animation:_cl_fadein .25s ease;}
        #_cl_card{
            background:#fff;border-radius:22px;
            padding:40px 44px 36px;
            box-shadow:0 12px 48px rgba(0,0,0,.13),0 2px 8px rgba(0,0,0,.06);
            display:flex;flex-direction:column;align-items:center;gap:14px;
            max-width:370px;width:calc(100% - 40px);
        }
        #_cl_wifi_icon{
            width:76px;height:76px;border-radius:50%;
            background:linear-gradient(135deg,#fee2e2 0%,#fef3c7 100%);
            display:flex;align-items:center;justify-content:center;
            color:#ef4444;flex-shrink:0;
        }
        #_cl_main_title{
            color:#111827;font-size:1.2rem;font-weight:800;
            letter-spacing:-.02em;text-align:center;margin:0;
        }
        #_cl_sub{
            color:#6b7280;font-size:.855rem;
            text-align:center;line-height:1.65;margin:0;max-width:260px;
        }
        #_cl_countdown_row{
            display:flex;align-items:center;gap:8px;
            color:#9ca3af;font-size:.8rem;
        }
        #_cl_countdown_num{
            font-weight:700;color:#6b7280;font-variant-numeric:tabular-nums;
            min-width:2ch;text-align:right;
        }
        #_cl_spinner_sm{
            width:14px;height:14px;
            border:2px solid rgba(59,130,246,.2);border-top-color:#3b82f6;
            border-radius:50%;animation:_cl_spin .6s linear infinite;
            display:none;flex-shrink:0;
        }
        #_cl_status{
            font-size:.78rem;text-align:center;min-height:1.1em;
            transition:color .2s;color:#9ca3af;
        }
        #_cl_status.err{color:#ef4444;}
        #_cl_status.ok{color:#10b981;}
        #_cl_btn{
            width:100%;padding:13px 24px;margin-top:4px;
            background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;
            border:none;border-radius:11px;font-size:.92rem;font-weight:700;
            cursor:pointer;font-family:inherit;
            box-shadow:0 3px 14px rgba(59,130,246,.32);
            transition:filter .15s,transform .15s,box-shadow .15s;
            display:flex;align-items:center;justify-content:center;gap:8px;
        }
        #_cl_btn:hover:not(:disabled){filter:brightness(1.08);transform:translateY(-1px);box-shadow:0 6px 20px rgba(59,130,246,.42);}
        #_cl_btn:active:not(:disabled){transform:translateY(0);filter:brightness(.97);}
        #_cl_btn:disabled{opacity:.6;cursor:not-allowed;transform:none;filter:none;}
    `

    // ── DOM ───────────────────────────────────────────────────────────────────
    const wrapper = document.createElement('div')
    wrapper.id = 'cieloo-overlays'
    wrapper.innerHTML = `
<<<<<<< HEAD
=======
        <div id="cieloo-splash">
            <div class="cieloo-logo">C</div>
            <div class="cieloo-title">CielooDesk</div>
            <div class="cieloo-spinner-lg"></div>
        </div>
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
        <div id="cieloo-offline">
            <div id="_cl_card">
                <div id="_cl_wifi_icon">${SVG_WIFI_OFF}</div>
                <div id="_cl_main_title">Connexion perdue</div>
                <div id="_cl_sub">Votre session est préservée.<br>Vérifiez votre réseau Wi-Fi ou Ethernet.</div>
                <div id="_cl_countdown_row">
                    <div id="_cl_spinner_sm"></div>
                    <span id="_cl_countdown_label">Nouvelle tentative dans</span>
                    <span id="_cl_countdown_num">30</span><span>s</span>
                </div>
                <div id="_cl_status"></div>
                <button id="_cl_btn">${SVG_RETRY} Réessayer maintenant</button>
            </div>
        </div>
    `

    document.head.appendChild(styleEl)
    document.body.appendChild(wrapper)

<<<<<<< HEAD
=======
    // ── Splash dismiss ────────────────────────────────────────────────────────
    window.addEventListener('load', () => {
        setTimeout(() => {
            const splash = document.getElementById('cieloo-splash')
            if (!splash) return
            splash.classList.add('cieloo-hidden')
            setTimeout(() => splash.remove(), 480)
        }, 250)
    })

>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    // ── Connectivity engine ───────────────────────────────────────────────────
    const COUNTDOWN_SEC = 30         // seconds before auto-retry
    const PING_TIMEOUT_MS = 4000     // max ms to wait for ping
    const BG_CHECK_MS = 20000        // periodic check when "online" (catches silent failures)

<<<<<<< HEAD
    const offlineEl = document.getElementById('cieloo-offline')!
    const numEl = document.getElementById('_cl_countdown_num')!
    const labelEl = document.getElementById('_cl_countdown_label')!
    const spinnerSm = document.getElementById('_cl_spinner_sm')!
    const statusEl = document.getElementById('_cl_status')!
    const retryBtn = document.getElementById('_cl_btn') as HTMLButtonElement

    let overlayUp = false
    let checking = false
    let countdownVal = COUNTDOWN_SEC
    let cdTimer: ReturnType<typeof setInterval> | null = null
    let bgTimer: ReturnType<typeof setTimeout> | null = null

    function clearTimers(): void {
        if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
        if (bgTimer) { clearTimeout(bgTimer); bgTimer = null }
=======
    const offlineEl  = document.getElementById('cieloo-offline')!
    const numEl      = document.getElementById('_cl_countdown_num')!
    const labelEl    = document.getElementById('_cl_countdown_label')!
    const spinnerSm  = document.getElementById('_cl_spinner_sm')!
    const statusEl   = document.getElementById('_cl_status')!
    const retryBtn   = document.getElementById('_cl_btn') as HTMLButtonElement

    let overlayUp      = false
    let checking       = false
    let countdownVal   = COUNTDOWN_SEC
    let cdTimer: ReturnType<typeof setInterval>  | null = null
    let bgTimer: ReturnType<typeof setTimeout>   | null = null

    function clearTimers(): void {
        if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
        if (bgTimer) { clearTimeout(bgTimer);  bgTimer = null }
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
    }

    // Ping the current origin — any HTTP response = connectivity OK.
    // mode:'no-cors' means we get an opaque response (status 0) even for non-CORS
    // resources, but it only rejects on a real network error.
    async function ping(): Promise<boolean> {
        const ctrl = new AbortController()
        const tid = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS)
        try {
            await fetch(window.location.origin + '/favicon.ico', {
                method: 'GET', mode: 'no-cors', cache: 'no-store', signal: ctrl.signal
            })
            clearTimeout(tid)
            return true
        } catch {
            clearTimeout(tid)
            return false
        }
    }

    function setStatus(msg: string, cls: '' | 'err' | 'ok' = ''): void {
        statusEl.textContent = msg
        statusEl.className = cls
    }

    function setCheckingUI(on: boolean): void {
        spinnerSm.style.display = on ? 'block' : 'none'
        labelEl.textContent = on ? 'Vérification…' : 'Nouvelle tentative dans'
        numEl.style.display = on ? 'none' : ''
        retryBtn.disabled = on
    }

    function startCountdown(): void {
        countdownVal = COUNTDOWN_SEC
        numEl.textContent = String(countdownVal)
        setCheckingUI(false)
        if (cdTimer) clearInterval(cdTimer)
        cdTimer = setInterval(() => {
            countdownVal--
            if (countdownVal <= 0) {
                if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
                void doRetry()
            } else {
                numEl.textContent = String(countdownVal)
            }
        }, 1000)
    }

    function showOverlay(): void {
        if (overlayUp) return
        overlayUp = true
        clearTimers()
        offlineEl.classList.add('cieloo-visible')
        setStatus('')
        setCheckingUI(false)
        startCountdown()
    }

    function hideOverlay(): void {
        if (!overlayUp) return
        overlayUp = false
        clearTimers()
        offlineEl.classList.remove('cieloo-visible')
        setStatus('')
        // Keep a background check running to catch silent drops
        scheduleBgCheck()
    }

    function scheduleBgCheck(): void {
        if (bgTimer) clearTimeout(bgTimer)
        bgTimer = setTimeout(async () => {
            if (overlayUp) return
            const ok = await ping()
            if (!ok) showOverlay()
            else scheduleBgCheck()
        }, BG_CHECK_MS)
    }

    async function doRetry(): Promise<void> {
        if (checking) return
        checking = true
        clearTimers()
        setCheckingUI(true)
        setStatus('')

        const ok = await ping()
        checking = false

        if (ok) {
            setStatus('Connexion rétablie !', 'ok')
            // Brief confirmation then dismiss — page state is preserved, no reload
            setTimeout(() => hideOverlay(), 700)
        } else {
            setCheckingUI(false)
            setStatus('Toujours hors ligne.', 'err')
            setTimeout(() => {
                if (!overlayUp) return
                setStatus('')
                startCountdown()
            }, 1800)
        }
    }

    retryBtn.addEventListener('click', () => void doRetry())

    // Allow the main-process IPC listener to trigger this overlay
    _triggerOfflineOverlay = showOverlay

    // ── Event listeners ───────────────────────────────────────────────────────
    // 'offline' fires almost immediately in Chromium when WiFi/Ethernet drops
    window.addEventListener('offline', () => showOverlay())

    // 'online' fires when the OS thinks the interface is back — but verify with a ping
    // before hiding, to avoid flash when it's actually a captive portal or fluke
    window.addEventListener('online', () => {
        if (!overlayUp) return
        // Stop the countdown, show checking state immediately
        if (cdTimer) { clearInterval(cdTimer); cdTimer = null }
        setCheckingUI(true)
        setStatus('Connexion détectée, vérification…')
        void doRetry()
    })

    // Boot: if already offline when the page loads
    if (!navigator.onLine) showOverlay()
    else scheduleBgCheck()
}
