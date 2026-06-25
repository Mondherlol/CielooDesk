import './styles/settings.css'
import { createIcons, FolderOpen, MonitorSmartphone, PaintbrushVertical, Type } from 'lucide'

function toast(msg: string): void {
    const el = document.getElementById('toast')!
    el.textContent = msg
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
}

function initTabs(): void {
    const items = document.querySelectorAll<HTMLButtonElement>('.sidebar-item')
    const tabs = document.querySelectorAll<HTMLDivElement>('.settings-tab')

    items.forEach((item) => {
        item.addEventListener('click', () => {
            const target = item.dataset.tab
            if (!target) return

            items.forEach((currentItem) => currentItem.classList.remove('active'))
            tabs.forEach((tab) => tab.classList.remove('active'))

            item.classList.add('active')
            document.getElementById(`tab-${target}`)?.classList.add('active')
        })
    })
}

function $<T extends HTMLElement>(id: string): T {
    return document.getElementById(id) as T
}

async function initCustomerDisplay(): Promise<void> {
    const enabled = $<HTMLInputElement>('cd-enabled')
    const portSelect = $<HTMLSelectElement>('cd-port')
    const refreshBtn = $<HTMLButtonElement>('cd-refresh-ports')
    const baud = $<HTMLSelectElement>('cd-baud')
    const protocol = $<HTMLSelectElement>('cd-protocol')
    const columns = $<HTMLInputElement>('cd-columns')
    const line1 = $<HTMLInputElement>('cd-line1')
    const line2 = $<HTMLInputElement>('cd-line2')
    const cartMode = $<HTMLSelectElement>('cd-cart-mode')
    const totalLabel = $<HTMLInputElement>('cd-total-label')
    const showTotalLabel = $<HTMLInputElement>('cd-show-total-label')
    const scrollPause = $<HTMLInputElement>('cd-scroll-pause')
    const scrollStep = $<HTMLInputElement>('cd-scroll-step')
    const scrollInstant = $<HTMLInputElement>('cd-scroll-instant')
    const thankYouEnabled = $<HTMLInputElement>('cd-thankyou-enabled')
    const thankYou1 = $<HTMLInputElement>('cd-thankyou1')
    const thankYou2 = $<HTMLInputElement>('cd-thankyou2')
    const thankYouDuration = $<HTMLInputElement>('cd-thankyou-duration')
    const resetTextBtn = $<HTMLButtonElement>('cd-reset-text')
    const sendWelcomeBtn = $<HTMLButtonElement>('cd-send-welcome')
    const sendThankYouBtn = $<HTMLButtonElement>('cd-send-thankyou')

    // Config par défaut "comportement/contenu" (doit rester alignée avec DEFAULTS côté main).
    // La connexion (port, vitesse, protocole, colonnes, activation) n'est PAS réinitialisée.
    const CONFIG_DEFAULTS = {
        line1: 'Bienvenue !',
        line2: 'Ravi de vous voir',
        cartMode: 'detailed',
        totalLabel: 'TOTAL',
        showTotalLabel: true,
        scrollStartPauseSec: 0.5,
        scrollStepMs: 450,
        scrollInstant: false,
        thankYouEnabled: true,
        thankYouLine1: 'Merci !',
        thankYouLine2: 'A bientot :)',
        thankYouDurationSec: 5,
    }
    const previewL1 = $<HTMLSpanElement>('cd-preview-l1')
    const previewL2 = $<HTMLSpanElement>('cd-preview-l2')
    const tyPreviewL1 = $<HTMLSpanElement>('cd-ty-preview-l1')
    const tyPreviewL2 = $<HTMLSpanElement>('cd-ty-preview-l2')

    const config = await window.cieloo.customerDisplay.getConfig()

    const refreshPorts = async (selected: string): Promise<void> => {
        const ports = await window.cieloo.customerDisplay.listPorts()
        portSelect.innerHTML = ''
        if (ports.length === 0) {
            const opt = document.createElement('option')
            opt.value = ''
            opt.textContent = 'Aucun port détecté'
            portSelect.appendChild(opt)
        }
        for (const p of ports) {
            const opt = document.createElement('option')
            opt.value = p.path
            opt.textContent = p.label
            portSelect.appendChild(opt)
        }
        // Conserve le port enregistré même s'il n'est pas (encore) branché.
        if (selected && !ports.some((p) => p.path === selected)) {
            const opt = document.createElement('option')
            opt.value = selected
            opt.textContent = `${selected} (non détecté)`
            portSelect.appendChild(opt)
        }
        portSelect.value = selected
    }

    const fit = (text: string, cols: number): string => text.slice(0, cols).padEnd(cols, ' ')
    const renderPreview = (): void => {
        const cols = Math.max(8, Math.min(40, parseInt(columns.value, 10) || 20))
        previewL1.textContent = fit(line1.value, cols)
        previewL2.textContent = fit(line2.value, cols)
        tyPreviewL1.textContent = fit(thankYou1.value, cols)
        tyPreviewL2.textContent = fit(thankYou2.value, cols)
    }

    // Pré-remplissage depuis la config
    enabled.checked = config.enabled
    baud.value = String(config.baudRate)
    protocol.value = config.protocol
    columns.value = String(config.columns)
    line1.value = config.line1
    line2.value = config.line2
    cartMode.value = config.cartMode
    totalLabel.value = config.totalLabel
    showTotalLabel.checked = config.showTotalLabel
    scrollPause.value = String(config.scrollStartPauseSec)
    scrollStep.value = String(config.scrollStepMs)
    scrollInstant.checked = config.scrollInstant
    thankYouEnabled.checked = config.thankYouEnabled
    thankYou1.value = config.thankYouLine1
    thankYou2.value = config.thankYouLine2
    thankYouDuration.value = String(config.thankYouDurationSec)
    await refreshPorts(config.port)
    renderPreview()

    const currentConfig = () => ({
        enabled: enabled.checked,
        port: portSelect.value,
        baudRate: parseInt(baud.value, 10) || 9600,
        protocol: protocol.value as 'cd5220' | 'esc-pos' | 'plain',
        columns: parseInt(columns.value, 10) || 20,
        line1: line1.value,
        line2: line2.value,
        cartMode: cartMode.value as 'total' | 'detailed',
        totalLabel: totalLabel.value,
        showTotalLabel: showTotalLabel.checked,
        scrollStartPauseSec: parseFloat(scrollPause.value) || 0,
        scrollStepMs: parseInt(scrollStep.value, 10) || 450,
        scrollInstant: scrollInstant.checked,
        thankYouEnabled: thankYouEnabled.checked,
        thankYouLine1: thankYou1.value,
        thankYouLine2: thankYou2.value,
        thankYouDurationSec: parseInt(thankYouDuration.value, 10) || 5,
    })

    const persist = async (): Promise<void> => {
        await window.cieloo.customerDisplay.saveConfig(currentConfig())
    }

    enabled.addEventListener('change', persist)
    portSelect.addEventListener('change', persist)
    baud.addEventListener('change', persist)
    protocol.addEventListener('change', persist)
    columns.addEventListener('change', () => { renderPreview(); void persist() })
    for (const el of [line1, line2, thankYou1, thankYou2]) {
        el.addEventListener('input', renderPreview)
    }
    for (const el of [line1, line2, totalLabel, thankYou1, thankYou2, thankYouDuration, scrollPause, scrollStep]) {
        el.addEventListener('change', persist)
    }
    cartMode.addEventListener('change', persist)
    showTotalLabel.addEventListener('change', persist)
    scrollInstant.addEventListener('change', persist)
    thankYouEnabled.addEventListener('change', persist)

    refreshBtn.addEventListener('click', async () => {
        await refreshPorts(portSelect.value)
        toast('Liste des ports rafraîchie')
    })

    // Réinitialise TOUTE la config contenu/comportement (garde la connexion).
    resetTextBtn.addEventListener('click', async () => {
        line1.value = CONFIG_DEFAULTS.line1
        line2.value = CONFIG_DEFAULTS.line2
        cartMode.value = CONFIG_DEFAULTS.cartMode
        totalLabel.value = CONFIG_DEFAULTS.totalLabel
        showTotalLabel.checked = CONFIG_DEFAULTS.showTotalLabel
        scrollPause.value = String(CONFIG_DEFAULTS.scrollStartPauseSec)
        scrollStep.value = String(CONFIG_DEFAULTS.scrollStepMs)
        scrollInstant.checked = CONFIG_DEFAULTS.scrollInstant
        thankYouEnabled.checked = CONFIG_DEFAULTS.thankYouEnabled
        thankYou1.value = CONFIG_DEFAULTS.thankYouLine1
        thankYou2.value = CONFIG_DEFAULTS.thankYouLine2
        thankYouDuration.value = String(CONFIG_DEFAULTS.thankYouDurationSec)
        renderPreview()
        await persist()
        toast('Configuration réinitialisée')
    })

    // Envoi de test générique sur l'afficheur.
    const testSend = async (btn: HTMLButtonElement, l1: string, l2: string): Promise<void> => {
        if (!portSelect.value) { toast('Sélectionnez d\'abord un port série'); return }
        btn.disabled = true
        await persist()
        const result = await window.cieloo.customerDisplay.send(l1, l2, currentConfig())
        btn.disabled = false
        toast(result.success ? 'Texte envoyé à l\'afficheur' : `Échec : ${result.message ?? 'erreur inconnue'}`)
    }

    sendWelcomeBtn.addEventListener('click', () => testSend(sendWelcomeBtn, line1.value, line2.value))
    sendThankYouBtn.addEventListener('click', () => testSend(sendThankYouBtn, thankYou1.value, thankYou2.value))
}

async function init(): Promise<void> {
    createIcons({ icons: { MonitorSmartphone, PaintbrushVertical, FolderOpen, Type } })
    initTabs()

    const [settings, version] = await Promise.all([
        window.cieloo.settings.get(),
        window.cieloo.app.version(),
    ])

    const versionEl = document.getElementById('sidebar-version')
    if (versionEl) versionEl.textContent = `V. ${version}`

    const autoStartToggle = document.getElementById('toggle-second-display-autostart') as HTMLInputElement
    const mediaFolderValue = document.getElementById('second-display-media-folder-value') as HTMLSpanElement
    const clearMediaFolderButton = document.getElementById('btn-clear-second-display-media-folder') as HTMLButtonElement

    const renderMediaFolder = (folder: string | null): void => {
        mediaFolderValue.textContent = folder || 'Aucun dossier selectionne'
        clearMediaFolderButton.disabled = !folder
    }

    autoStartToggle.checked = settings.secondDisplayAutoStart
    renderMediaFolder(settings.secondDisplayMediaFolder)

    autoStartToggle.addEventListener('change', async (event) => {
        const enabled = (event.target as HTMLInputElement).checked
        await window.cieloo.settings.set('secondDisplayAutoStart', enabled)
        toast(enabled
            ? 'Demarrage automatique du second afficheur active'
            : 'Demarrage automatique du second afficheur desactive')
    })

    document.getElementById('btn-open-second-display-editor')?.addEventListener('click', async () => {
        await window.cieloo.secondDisplay.openEditor()
    })

    document.getElementById('btn-select-second-display-media-folder')?.addEventListener('click', async () => {
        const selectedFolder = await window.cieloo.secondDisplay.selectMediaFolder()
        if (!selectedFolder) return

        renderMediaFolder(selectedFolder)
        toast('Dossier media du second afficheur mis a jour')
    })

    clearMediaFolderButton.addEventListener('click', async () => {
        await window.cieloo.secondDisplay.clearMediaFolder()
        renderMediaFolder(null)
        toast('Restriction du dossier media desactivee')
    })

    await initCustomerDisplay()
}

void init()
