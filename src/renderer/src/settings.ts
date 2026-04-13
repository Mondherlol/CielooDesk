import './styles/settings.css'
import { createIcons, Palette, KeyRound, Rocket, Keyboard } from 'lucide'
import type { AppSettings, ShortcutMap } from '../../modules/settings/main'

// ─── Toast ────────────────────────────────────────────────────────────────────

function toast(msg: string): void {
    const el = document.getElementById('toast')!
    el.textContent = msg
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
}

// ─── Tabs ─────────────────────────────────────────────────────────────────────

function initTabs(): void {
    const items = document.querySelectorAll<HTMLButtonElement>('.sidebar-item')
    const tabs = document.querySelectorAll<HTMLDivElement>('.settings-tab')

    items.forEach(item => {
        item.addEventListener('click', () => {
            const target = item.dataset.tab!
            items.forEach(i => i.classList.remove('active'))
            tabs.forEach(t => t.classList.remove('active'))
            item.classList.add('active')
            document.getElementById(`tab-${target}`)?.classList.add('active')
        })
    })
}

function initDevMenu(): void {
    const versionEl = document.getElementById('sidebar-version')
    const devMenuEl = document.getElementById('dev-menu')
    const clearConfigBtn = document.getElementById('btn-dev-clear-config') as HTMLButtonElement | null
    if (!versionEl || !devMenuEl || !clearConfigBtn) return

    let tapCount = 0
    let tapTimer: ReturnType<typeof setTimeout> | null = null

    const resetTapState = (): void => {
        tapCount = 0
        if (tapTimer) {
            clearTimeout(tapTimer)
            tapTimer = null
        }
    }

    versionEl.addEventListener('click', () => {
        tapCount += 1

        if (tapTimer) clearTimeout(tapTimer)
        tapTimer = setTimeout(() => {
            resetTapState()
        }, 1200)

        if (tapCount < 3) return

        const isVisible = devMenuEl.classList.toggle('visible')
        devMenuEl.setAttribute('aria-hidden', String(!isVisible))
        toast(isVisible ? 'Menu développeur activé' : 'Menu développeur masqué')
        resetTapState()
    })

    clearConfigBtn.addEventListener('click', async () => {
        const confirmed = window.confirm('Effacer la config instance et revenir à l\'écran de configuration ?')
        if (!confirmed) return

        clearConfigBtn.disabled = true
        try {
            await window.cieloo.config.clear()
            toast('Configuration effacée')
        } finally {
            clearConfigBtn.disabled = false
        }
    })
}

// ─── Shortcut editor ──────────────────────────────────────────────────────────

const SHORTCUT_LABELS: Record<keyof ShortcutMap, string> = {
    reload: 'Recharger la page',
    hardReload: 'Forcer le rechargement',
    fullscreen: 'Plein écran',
    quit: 'Quitter',
    devtools: 'Outils développeurs',
}

/** Convert an Electron accelerator string to display-friendly kbd tokens */
function acceleratorToKbds(acc: string): string[] {
    return acc.split('+').map(k => {
        if (k === 'CmdOrCtrl') return 'Ctrl'
        if (k === 'Return') return 'Entrée'
        if (k === 'Escape') return 'Échap'
        if (k === 'Delete') return 'Suppr'
        if (k === 'Backspace') return '⌫'
        if (k === 'Space') return 'Espace'
        return k
    })
}

/** Capture a keydown and return an Electron accelerator string, or null for modifier-only */
function keydownToAccelerator(e: KeyboardEvent): string | null {
    const modifiers: string[] = []
    if (e.ctrlKey || e.metaKey) modifiers.push('CmdOrCtrl')
    if (e.altKey) modifiers.push('Alt')
    if (e.shiftKey) modifiers.push('Shift')

    const ignored = ['Control', 'Alt', 'Shift', 'Meta', 'CapsLock', 'NumLock', 'ScrollLock']
    if (ignored.includes(e.key)) return null   // modifier-only keypress, wait for the real key

    const special: Record<string, string> = {
        Enter: 'Return', Escape: 'Escape', Delete: 'Delete', Backspace: 'Backspace',
        Tab: 'Tab', ' ': 'Space', ArrowUp: 'Up', ArrowDown: 'Down',
        ArrowLeft: 'Left', ArrowRight: 'Right',
    }

    let key = special[e.key] ?? (e.key.length === 1 ? e.key.toUpperCase() : e.key)
    // F1–F12 pass through as-is
    return [...modifiers, key].join('+')
}

let currentShortcuts: ShortcutMap = {} as ShortcutMap

function renderShortcuts(shortcuts: ShortcutMap, isDev: boolean): void {
    currentShortcuts = { ...shortcuts }
    const container = document.getElementById('shortcuts-list')!
    container.innerHTML = ''

    const visibleShortcutIds = (Object.keys(SHORTCUT_LABELS) as (keyof ShortcutMap)[])
        .filter((id) => isDev || id !== 'devtools')

        ; (visibleShortcutIds).forEach(id => {
            const row = document.createElement('div')
            row.className = 'shortcut-row'

            const label = document.createElement('span')
            label.className = 'shortcut-action'
            label.textContent = SHORTCUT_LABELS[id]

            const keyDisplay = document.createElement('div')
            keyDisplay.className = 'shortcut-key'

            const kbdWrap = document.createElement('span')
            kbdWrap.className = 'kbd-display'
            acceleratorToKbds(shortcuts[id]).forEach((part, i) => {
                if (i > 0) kbdWrap.appendChild(document.createTextNode(' + '))
                const kbd = document.createElement('span')
                kbd.className = 'kbd'
                kbd.textContent = part
                kbdWrap.appendChild(kbd)
            })

            const input = document.createElement('div')
            input.className = 'shortcut-input'
            input.textContent = 'Appuyez sur les touches…'
            input.tabIndex = -1

            keyDisplay.appendChild(kbdWrap)
            keyDisplay.appendChild(input)

            const editBtn = document.createElement('button')
            editBtn.className = 'shortcut-edit-btn'
            editBtn.textContent = 'Modifier'

            // ── Recording logic ──────────────────────────────────────────────────
            let recording = false

            function startRecording(): void {
                recording = true
                keyDisplay.classList.add('recording')
                input.classList.add('recording')
                input.textContent = 'Appuyez sur les touches…'
                editBtn.textContent = 'Annuler'
            }

            function stopRecording(): void {
                recording = false
                keyDisplay.classList.remove('recording')
                input.classList.remove('recording')
                editBtn.textContent = 'Modifier'
            }

            editBtn.addEventListener('click', () => {
                if (recording) { stopRecording(); return }
                startRecording()
            })

            document.addEventListener('keydown', (e) => {
                if (!recording) return
                e.preventDefault()
                e.stopPropagation()

                const acc = keydownToAccelerator(e)
                if (!acc) return   // modifier only, wait

                // Escape cancels without saving
                if (acc === 'Escape') { stopRecording(); return }

                // Apply new shortcut
                currentShortcuts[id] = acc
                stopRecording()

                // Re-render this row's kbd display
                kbdWrap.innerHTML = ''
                acceleratorToKbds(acc).forEach((part, i) => {
                    if (i > 0) kbdWrap.appendChild(document.createTextNode(' + '))
                    const kbd = document.createElement('span')
                    kbd.className = 'kbd'
                    kbd.textContent = part
                    kbdWrap.appendChild(kbd)
                })

                // Persist
                void window.cieloo.settings.setShortcuts(currentShortcuts).then(() => {
                    toast(`Raccourci mis à jour — ${SHORTCUT_LABELS[id]}`)
                })
            }, true)

            row.appendChild(label)
            row.appendChild(keyDisplay)
            row.appendChild(editBtn)
            container.appendChild(row)
        })
}

// ─── Credentials status ───────────────────────────────────────────────────────

async function refreshCredsStatus(): Promise<void> {
    const statusEl = document.getElementById('creds-status')!
    const clearBtn = document.getElementById('btn-clear-creds') as HTMLButtonElement
    const has = await window.cieloo.autoLogin.hasCredentials()
    if (has) {
        statusEl.textContent = '✓ Identifiants mémorisés'
        statusEl.classList.add('stored')
        clearBtn.disabled = false
    } else {
        statusEl.textContent = 'Aucun identifiant mémorisé'
        statusEl.classList.remove('stored')
        clearBtn.disabled = true
    }
}

// ─── Bootstrap ────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    createIcons({ icons: { Palette, KeyRound, Rocket, Keyboard } })
    initTabs()
    initDevMenu()

    const [settings, version, isDev] = await Promise.all([
        window.cieloo.settings.get(),
        window.cieloo.app.version(),
        window.cieloo.app.isDev(),
    ])
    const versionEl = document.getElementById('sidebar-version')
    if (versionEl) versionEl.textContent = `V. ${version}`

        // Apparence
        ; (document.getElementById('toggle-fullscreen') as HTMLInputElement).checked = settings.fullscreen
        ; (document.getElementById('select-spinner') as HTMLSelectElement).value = settings.spinnerPosition
        ; (document.getElementById('select-newwindow') as HTMLSelectElement).value = settings.newWindowMode

        // Connexion
        ; (document.getElementById('toggle-autologin') as HTMLInputElement).checked = settings.autoLogin
    await refreshCredsStatus()

        // Démarrage
        ; (document.getElementById('toggle-startup') as HTMLInputElement).checked = settings.launchAtStartup

    // Raccourcis
    renderShortcuts(settings.shortcuts, isDev)

    // ── Wire controls ────────────────────────────────────────────────────────

    function wireToggle(id: string, key: keyof AppSettings, label: string): void {
        document.getElementById(id)!.addEventListener('change', async (e) => {
            const v = (e.target as HTMLInputElement).checked
            await window.cieloo.settings.set(key as string, v)
            toast(v ? `${label} activé` : `${label} désactivé`)
        })
    }

    wireToggle('toggle-fullscreen', 'fullscreen', 'Plein écran')
    wireToggle('toggle-autologin', 'autoLogin', 'Connexion automatique')
    wireToggle('toggle-startup', 'launchAtStartup', 'Démarrage automatique')

    document.getElementById('select-spinner')!.addEventListener('change', async (e) => {
        const v = (e.target as HTMLSelectElement).value
        await window.cieloo.settings.set('spinnerPosition', v as never)
        toast('Position du spinner mise à jour')
    })

    document.getElementById('select-newwindow')!.addEventListener('change', async (e) => {
        const v = (e.target as HTMLSelectElement).value
        await window.cieloo.settings.set('newWindowMode', v as never)
        toast('Mode d\'ouverture des liens mis à jour')
    })

    document.getElementById('btn-clear-creds')!.addEventListener('click', async () => {
        await window.cieloo.autoLogin.clearCredentials()
        await refreshCredsStatus()
        toast('Identifiants supprimés')
    })

    document.getElementById('btn-reset-shortcuts')!.addEventListener('click', async () => {
        const updated = await window.cieloo.settings.resetShortcuts()
        renderShortcuts(updated.shortcuts, isDev)
        toast('Raccourcis réinitialisés')
    })
}

void init()
