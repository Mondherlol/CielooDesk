/**
 * Auto-login preload module.
 * Bundled into the main preload — runs in the renderer context on every page load.
 *
 * Behaviour on a *.cieloo.io login page:
 *  1. If auto-login is enabled and credentials are stored → auto-fill + submit (once per session).
 *  2. If auto-login is enabled but no credentials stored → intercept manual submit and ask the
 *     user whether CielooDesk should remember them.
 *  3. In all other cases (feature disabled, not a login page, …) → do nothing.
 */
import { ipcRenderer } from 'electron'

// ─── Public API (called once from preload/index.ts) ───────────────────────────

export function initAutoLoginPreload(): void {
    // Only run on external cieloo.io pages
    if (!window.location.hostname.endsWith('.cieloo.io')) return

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => void run())
    } else {
        void run()
    }
}

// ─── Core logic ───────────────────────────────────────────────────────────────

async function run(): Promise<void> {
    const form = document.querySelector<HTMLFormElement>('form#login')
    const userInput = document.querySelector<HTMLInputElement>('#username')
    const passInput = document.querySelector<HTMLInputElement>('#password')

    // Not a login page
    if (!form || !userInput || !passInput) return

    const settings = await ipcRenderer.invoke('settings:get') as { autoLogin?: boolean }
    if (!settings.autoLogin) return

    // ── Auto-fill path ────────────────────────────────────────────────────────
    // sessionStorage survives same-origin redirects — used to break infinite loops on bad creds.
    if (!sessionStorage.getItem('cieloo_al_done')) {
        const creds = await ipcRenderer.invoke('autologin:get-credentials') as
            { username: string; password: string } | null

        if (creds) {
            sessionStorage.setItem('cieloo_al_done', '1')
            showAutoLoginToast()
            await sleep(700)
            userInput.value = creds.username
            passInput.value = creds.password
            form.submit()
            return
        }
    }

    // ── "Remember me?" prompt path ────────────────────────────────────────────
    // Only intercept if no credentials are stored yet (first-time or after clear).
    const hasCreds = await ipcRenderer.invoke('autologin:has-credentials') as boolean
    if (hasCreds) return

    form.addEventListener('submit', (e) => {
        const username = userInput.value.trim()
        const password = passInput.value
        if (!username || !password) return   // let normal validation handle it

        e.preventDefault()
        showRememberPopup(form, username, password)
    }, { once: true })
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
    return new Promise(r => setTimeout(r, ms))
}

let kfInjected = false
function injectKeyframes(): void {
    if (kfInjected) return
    kfInjected = true
    const s = document.createElement('style')
    s.textContent = `
        @keyframes _cl_fadein   { from{opacity:0}                          to{opacity:1} }
        @keyframes _cl_scalein  { from{opacity:0;transform:scale(.93)}     to{opacity:1;transform:scale(1)} }
        @keyframes _cl_slidein  { from{opacity:0;transform:translateX(-50%) translateY(10px)}
                                   to{opacity:1;transform:translateX(-50%) translateY(0)} }
        @keyframes _cl_pulse    { 0%,100%{opacity:1} 50%{opacity:.35} }
    `
    document.head?.appendChild(s)
}

// ─── Auto-login toast ─────────────────────────────────────────────────────────

function showAutoLoginToast(): void {
    injectKeyframes()
    const el = document.createElement('div')
    el.style.cssText = [
        'position:fixed', 'bottom:24px', 'left:50%', 'transform:translateX(-50%)',
        'background:#fff', 'border:1px solid #e4e9f2', 'border-radius:10px',
        'padding:11px 20px', 'z-index:2147483647',
        'display:flex', 'align-items:center', 'gap:10px',
        'font-family:Inter,ui-sans-serif,system-ui,sans-serif',
        'font-size:.86rem', 'font-weight:500', 'color:#374151',
        'box-shadow:0 4px 20px rgba(0,0,0,.1)',
        'animation:_cl_slidein .3s ease both',
        'white-space:nowrap'
    ].join(';')
    el.innerHTML =
        `<span style="width:8px;height:8px;border-radius:50%;background:#3b82f6;flex-shrink:0;animation:_cl_pulse 1.1s infinite;"></span>` +
        `Connexion automatique…`
    document.body?.appendChild(el)
}

// ─── "Remember me?" popup ─────────────────────────────────────────────────────

function showRememberPopup(form: HTMLFormElement, username: string, password: string): void {
    injectKeyframes()

    const overlay = document.createElement('div')
    overlay.style.cssText = [
        'position:fixed', 'inset:0',
        'background:rgba(0,0,0,.35)',
        'backdrop-filter:blur(3px)',
        '-webkit-backdrop-filter:blur(3px)',
        'z-index:2147483647',
        'display:flex', 'align-items:center', 'justify-content:center',
        'animation:_cl_fadein .2s ease both',
        'font-family:Inter,ui-sans-serif,system-ui,sans-serif'
    ].join(';')

    overlay.innerHTML = `
<div id="_cl_card" style="
    background:#fff;border:1px solid #e4e9f2;border-radius:18px;
    padding:36px 32px 28px;max-width:370px;width:90%;
    box-shadow:0 24px 64px rgba(0,0,0,.15);
    display:flex;flex-direction:column;align-items:center;gap:12px;
    animation:_cl_scalein .25s cubic-bezier(.22,1,.36,1) both;">
    <div style="width:52px;height:52px;border-radius:15px;
        background:linear-gradient(135deg,#3b82f6,#6366f1);
        display:flex;align-items:center;justify-content:center;
        font-size:1.5rem;font-weight:800;color:#fff;
        box-shadow:0 4px 16px rgba(59,130,246,.3);flex-shrink:0;">C</div>
    <div style="font-size:1.05rem;font-weight:700;color:#111827;text-align:center;margin-top:2px;">
        Se souvenir de vous ?</div>
    <div style="font-size:.86rem;color:#6b7280;text-align:center;line-height:1.6;max-width:290px;">
        CielooDesk peut mémoriser vos identifiants et vous connecter
        automatiquement à la prochaine ouverture.</div>
    <div style="display:flex;gap:10px;margin-top:10px;width:100%;">
        <button id="_cl_no"  style="flex:1;padding:11px;border:1.5px solid #e4e9f2;
            border-radius:10px;background:#fff;color:#374151;
            font-size:.88rem;font-weight:600;cursor:pointer;font-family:inherit;
            transition:background .15s;">Non merci</button>
        <button id="_cl_yes" style="flex:1;padding:11px;border:none;border-radius:10px;
            background:linear-gradient(135deg,#3b82f6,#6366f1);color:#fff;
            font-size:.88rem;font-weight:700;cursor:pointer;font-family:inherit;
            box-shadow:0 3px 12px rgba(59,130,246,.3);transition:filter .15s;">
            Se souvenir</button>
    </div>
</div>`

    document.body?.appendChild(overlay)

    const btnNo = overlay.querySelector<HTMLButtonElement>('#_cl_no')!
    const btnYes = overlay.querySelector<HTMLButtonElement>('#_cl_yes')!

    btnNo.onmouseenter = () => { btnNo.style.background = '#f9fafb' }
    btnNo.onmouseleave = () => { btnNo.style.background = '#fff' }
    btnYes.onmouseenter = () => { btnYes.style.filter = 'brightness(1.07)' }
    btnYes.onmouseleave = () => { btnYes.style.filter = '' }

    btnYes.addEventListener('click', async () => {
        overlay.remove()
        await ipcRenderer.invoke('autologin:save-credentials', username, password)
        form.submit()
    })

    btnNo.addEventListener('click', () => {
        overlay.remove()
        form.submit()
    })
}
