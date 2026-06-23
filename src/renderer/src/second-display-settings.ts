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
    const resetTextBtn = $<HTMLButtonElement>('cd-reset-text')
    const sendBtn = $<HTMLButtonElement>('cd-send')

    // Texte au repos par défaut (doit rester aligné avec DEFAULTS côté main).
    const DEFAULT_LINE1 = 'Bienvenue'
    const DEFAULT_LINE2 = 'Powered by CaisLà'
    const previewL1 = $<HTMLSpanElement>('cd-preview-l1')
    const previewL2 = $<HTMLSpanElement>('cd-preview-l2')

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

    const renderPreview = (): void => {
        const cols = Math.max(8, Math.min(40, parseInt(columns.value, 10) || 20))
        previewL1.textContent = line1.value.slice(0, cols).padEnd(cols, ' ')
        previewL2.textContent = line2.value.slice(0, cols).padEnd(cols, ' ')
    }

    // Pré-remplissage depuis la config
    enabled.checked = config.enabled
    baud.value = String(config.baudRate)
    protocol.value = config.protocol
    columns.value = String(config.columns)
    line1.value = config.line1
    line2.value = config.line2
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
    })

    const persist = async (): Promise<void> => {
        await window.cieloo.customerDisplay.saveConfig(currentConfig())
    }

    enabled.addEventListener('change', persist)
    portSelect.addEventListener('change', persist)
    baud.addEventListener('change', persist)
    protocol.addEventListener('change', persist)
    columns.addEventListener('change', () => { renderPreview(); void persist() })
    line1.addEventListener('input', renderPreview)
    line2.addEventListener('input', renderPreview)
    line1.addEventListener('change', persist)
    line2.addEventListener('change', persist)

    refreshBtn.addEventListener('click', async () => {
        await refreshPorts(portSelect.value)
        toast('Liste des ports rafraîchie')
    })

    resetTextBtn.addEventListener('click', async () => {
        line1.value = DEFAULT_LINE1
        line2.value = DEFAULT_LINE2
        renderPreview()
        await persist()
        toast('Texte au repos réinitialisé')
    })

    sendBtn.addEventListener('click', async () => {
        if (!portSelect.value) { toast('Sélectionnez d\'abord un port série'); return }
        sendBtn.disabled = true
        await persist()
        const result = await window.cieloo.customerDisplay.send(line1.value, line2.value, currentConfig())
        sendBtn.disabled = false
        toast(result.success ? 'Texte envoyé à l\'afficheur' : `Échec : ${result.message ?? 'erreur inconnue'}`)
    })
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
