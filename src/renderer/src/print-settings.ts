import './styles/print-settings.css'
import type { PrintSettings } from '../../modules/settings/main'

type PrintStatus = {
    active: boolean
    ready: boolean
    serverUrl: string
    printer: string | null
    sumatraFound: boolean
}

function toast(message: string): void {
    const el = document.getElementById('toast')!
    el.textContent = message
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
}

function clampInt(value: number, min: number, max: number, fallback: number): number {
    if (!Number.isFinite(value)) return fallback
    return Math.min(Math.max(Math.trunc(value), min), max)
}

function setStatus(status: PrintStatus): void {
    const label = document.getElementById('print-status')!
    if (!status.active) {
        label.textContent = 'Serveur inactif (etat inattendu).'
        return
    }
    if (!status.sumatraFound) {
        label.textContent = 'Serveur actif, mais SumatraPDF.exe est introuvable.'
        return
    }
    if (!status.printer) {
<<<<<<< HEAD
        label.textContent = `Serveur actif. Aucune imprimante par defaut configuree.`
        return
    }
    label.textContent = `Serveur actif. Imprimante: ${status.printer}.`
=======
        label.textContent = `Serveur actif sur ${status.serverUrl}. Aucune imprimante par defaut configuree.`
        return
    }
    label.textContent = `Serveur actif sur ${status.serverUrl}. Imprimante: ${status.printer}.`
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
}

function applyConfigToForm(config: PrintSettings): void {
    ; (document.getElementById('input-print-width') as HTMLInputElement).value = String(config.paperWidth)
        ; (document.getElementById('input-print-height') as HTMLInputElement).value = String(config.paperHeight)
        ; (document.getElementById('select-print-orientation') as HTMLSelectElement).value = config.orientation
        ; (document.getElementById('select-print-scale') as HTMLSelectElement).value = config.scale
        ; (document.getElementById('input-print-margins') as HTMLInputElement).value = String(config.margins)
        ; (document.getElementById('input-print-copies') as HTMLInputElement).value = String(config.copies)
        ; (document.getElementById('select-print-color') as HTMLSelectElement).value = String(config.color)
}

async function refreshPrinters(selected: string | null): Promise<void> {
    const printers = await window.cieloo.print.getPrinters()
    const select = document.getElementById('select-print-printer') as HTMLSelectElement

    select.innerHTML = ''

    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = 'Aucune imprimante'
    select.appendChild(empty)

    printers.forEach((printer) => {
        const option = document.createElement('option')
        option.value = printer.name
        option.textContent = printer.isDefault ? `${printer.name} (defaut systeme)` : printer.name
        if (selected && selected === printer.name) option.selected = true
        select.appendChild(option)
    })

    if (!selected) select.value = ''
}

async function refreshStatus(): Promise<void> {
    const status = await window.cieloo.print.getStatus()
    setStatus(status)
}

async function init(): Promise<void> {
    const config = await window.cieloo.print.getConfig()
    applyConfigToForm(config)
    await refreshPrinters(config.defaultPrinter)
    await refreshStatus()

    document.getElementById('btn-refresh-printers')!.addEventListener('click', async () => {
        const selected = (document.getElementById('select-print-printer') as HTMLSelectElement).value || null
        await refreshPrinters(selected)
        toast('Imprimantes actualisees')
    })

    document.getElementById('btn-refresh-status')!.addEventListener('click', async () => {
        await refreshStatus()
        toast('Statut actualise')
    })

    document.getElementById('btn-save-print')!.addEventListener('click', async () => {
        const payload: Partial<PrintSettings> = {
            defaultPrinter: (document.getElementById('select-print-printer') as HTMLSelectElement).value || null,
            paperWidth: clampInt(Number((document.getElementById('input-print-width') as HTMLInputElement).value), 1, 1000, 80),
            paperHeight: clampInt(Number((document.getElementById('input-print-height') as HTMLInputElement).value), 1, 2000, 297),
            orientation: (document.getElementById('select-print-orientation') as HTMLSelectElement).value as PrintSettings['orientation'],
            scale: (document.getElementById('select-print-scale') as HTMLSelectElement).value as PrintSettings['scale'],
            margins: clampInt(Number((document.getElementById('input-print-margins') as HTMLInputElement).value), 0, 50, 2),
            copies: clampInt(Number((document.getElementById('input-print-copies') as HTMLInputElement).value), 1, 99, 1),
            color: (document.getElementById('select-print-color') as HTMLSelectElement).value === 'true',
        }

        const result = await window.cieloo.print.saveConfig(payload)
        applyConfigToForm(result.config)
        await refreshPrinters(result.config.defaultPrinter)
        setStatus(result.status)
        toast('Configuration impression enregistree')
    })
}

void init()
