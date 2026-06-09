import './styles/settings.css'
import { createIcons, FolderOpen, MonitorSmartphone, PaintbrushVertical } from 'lucide'

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

async function init(): Promise<void> {
    createIcons({ icons: { MonitorSmartphone, PaintbrushVertical, FolderOpen } })
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
}

void init()
