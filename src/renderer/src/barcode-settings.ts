import './styles/print-settings.css'
import type { PrintSettings, PrinterConfig } from '../../modules/settings/main'

// ─── Tabs definition ───────────────────────────────────────────────────────────
// Deux imprimantes code-barres distinctes : étiquette (rouleau) et planche A4.
type TabKey = 'label' | 'sheet'

interface TabDef {
    key: TabKey
    label: string
    /** Mode de page de test envoyé au process principal */
    testMode: 'label' | 'sheet'
    /** Libellé du bouton de test */
    testLabel: string
}

const TABS: TabDef[] = [
    { key: 'label', label: 'Étiquette', testMode: 'label', testLabel: 'Imprimer une étiquette test' },
    { key: 'sheet', label: 'Planche A4', testMode: 'sheet', testLabel: 'Imprimer une planche test' },
]

// Driver(s) d'imprimantes code-barres téléchargeables
interface DriverModel {
    brand: string
    name: string
    weight: string
    date: string
    url: string
}

const DRIVER_MODELS: DriverModel[] = [
    {
        brand: 'Gainscha',
        name: 'Label Printer Driver (Gprinter 11.10.0)',
        weight: '75.99 Mo',
        date: '2025/11/18',
        url: 'https://www.gainscha.com.tw/upload/20251118/c857acc75ad27545a7e7179b1957cfd9.rar',
    },
]

// État : une config par onglet
const configs: Record<TabKey, PrinterConfig> = {
    label: { id: 'printer-barcode', label: 'Étiquettes', defaultPrinter: null, paperWidth: 40, paperHeight: 30, copies: 1 },
    sheet: { id: 'printer-barcode-sheet', label: 'Planche A4', defaultPrinter: null, paperWidth: 210, paperHeight: 297, copies: 1 },
}
let activeTab: TabKey = 'label'

// ─── Utilities ──────────────────────────────────────────────────────────────────

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

// ─── SVG icons ────────────────────────────────────────────────────────────────
const SVG_REFRESH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
const SVG_SETTINGS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
const SVG_SLIDERS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`
const SVG_BARCODE = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 5v14"/><path d="M8 5v14"/><path d="M12 5v14"/><path d="M17 5v14"/><path d="M21 5v14"/></svg>`

// ─── Printer list refresh ───────────────────────────────────────────────────────

async function refreshPrinters(suffix: TabKey, selected: string | null): Promise<void> {
    const systemPrinters = await window.cieloo.print.getPrinters()
    const selectEl = document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null
    if (!selectEl) return

    selectEl.innerHTML = ''
    const empty = document.createElement('option')
    empty.value = ''
    empty.textContent = 'Aucune imprimante'
    selectEl.appendChild(empty)

    systemPrinters.forEach((printer) => {
        const option = document.createElement('option')
        option.value = printer.name
        option.textContent = printer.isDefault ? `${printer.name} (defaut systeme)` : printer.name
        if (selected && selected === printer.name) option.selected = true
        selectEl.appendChild(option)
    })

    if (!selected) selectEl.value = ''
}

async function updateTabStatuses(): Promise<void> {
    const sysPrinters = await window.cieloo.print.getPrinters()
    const applyDot = (suffix: TabKey, config: PrinterConfig): void => {
        const dot = document.getElementById(`tab-dot-${suffix}`)
        if (!dot) return
        if (!config.defaultPrinter) {
            dot.className = 'tab-dot tab-dot-idle'
            dot.title = 'Non configuree'
        } else if (sysPrinters.some(p => p.name === config.defaultPrinter)) {
            dot.className = 'tab-dot tab-dot-ok'
            dot.title = 'Connectee'
        } else {
            dot.className = 'tab-dot tab-dot-error'
            dot.title = 'Introuvable'
        }
    }
    TABS.forEach(t => applyDot(t.key, configs[t.key]))
}

// ─── Panel HTML ───────────────────────────────────────────────────────────────

function buildPanelHtml(config: PrinterConfig, tab: TabDef): string {
    const suffix = tab.key
    const dis = config.defaultPrinter ? '' : ' disabled'
    const dimHint = suffix === 'label'
        ? 'Étiquette en rouleau — par défaut 40 × 30 mm.'
        : 'Feuille A4 — par défaut 210 × 297 mm.'
    return `
        <div class="p-section">
            <div class="p-section-title">Imprimante Windows</div>
            <div class="p-printer-row">
                <select id="inp-printer-${suffix}" class="p-printer-select"></select>
                <button id="btn-refresh-${suffix}" class="p-icon-btn" title="Actualiser la liste">${SVG_REFRESH}</button>
            </div>
            <div class="p-action-row">
                <button id="btn-props-${suffix}" class="p-action-btn"${dis}>${SVG_SETTINGS} Proprietes</button>
                <button id="btn-opts-${suffix}" class="p-action-btn"${dis}>${SVG_SLIDERS} Options d'impression</button>
            </div>
        </div>

        <div class="p-section">
            <div class="p-section-title">Format du papier</div>
            <div class="p-paper-grid">
                <div class="p-field">
                    <label for="inp-width-${suffix}">Largeur <span class="p-unit">mm</span></label>
                    <input id="inp-width-${suffix}" type="number" min="1" max="1000" value="${config.paperWidth}" />
                </div>
                <div class="p-field">
                    <label for="inp-height-${suffix}">Hauteur <span class="p-unit">mm</span></label>
                    <input id="inp-height-${suffix}" type="number" min="1" max="2000" value="${config.paperHeight}" />
                </div>
                <div class="p-field">
                    <label for="inp-copies-${suffix}">Copies</label>
                    <input id="inp-copies-${suffix}" type="number" min="1" max="99" value="${config.copies}" />
                </div>
            </div>
            <p class="help">${dimHint}</p>
        </div>

        <div class="p-test-bar">
            <button id="btn-testpage-${suffix}" class="p-test-btn">${SVG_BARCODE} ${tab.testLabel}</button>
            <span id="test-page-status-${suffix}" class="test-page-status"></span>
        </div>
    `
}

// ─── Collect & persist ──────────────────────────────────────────────────────────

function collectTab(tab: TabKey): void {
    const config = configs[tab]
    const printerEl = document.getElementById(`inp-printer-${tab}`) as HTMLSelectElement | null
    const widthEl   = document.getElementById(`inp-width-${tab}`) as HTMLInputElement | null
    const heightEl  = document.getElementById(`inp-height-${tab}`) as HTMLInputElement | null
    const copiesEl  = document.getElementById(`inp-copies-${tab}`) as HTMLInputElement | null

    if (printerEl) config.defaultPrinter = printerEl.value || null
    if (widthEl)   config.paperWidth  = clampInt(Number(widthEl.value), 1, 1000, config.paperWidth)
    if (heightEl)  config.paperHeight = clampInt(Number(heightEl.value), 1, 2000, config.paperHeight)
    if (copiesEl)  config.copies      = clampInt(Number(copiesEl.value), 1, 99, 1)
}

let saveTimer: ReturnType<typeof setTimeout> | null = null

async function persistConfig(): Promise<void> {
    collectTab(activeTab)
    const payload: Partial<PrintSettings> = {
        barcodePrinter: { ...configs.label },
        barcodeSheetPrinter: { ...configs.sheet },
    }
    await window.cieloo.print.saveConfig(payload)
    void updateTabStatuses()
}

function scheduleSave(delay = 400): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        saveTimer = null
        persistConfig()
            .then(() => toast('Enregistré'))
            .catch(() => toast('Échec de l\'enregistrement'))
    }, delay)
}

// ─── Tab rendering ────────────────────────────────────────────────────────────

function wirePanel(tab: TabDef): void {
    const suffix = tab.key
    const config = configs[suffix]

    document.getElementById(`btn-refresh-${suffix}`)?.addEventListener('click', async () => {
        const sel = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value || null
        await refreshPrinters(suffix, sel)
        toast('Imprimantes actualisees')
    })

    document.getElementById(`btn-props-${suffix}`)?.addEventListener('click', () => {
        const name = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value
        if (name) void window.cieloo.print.openPrinterProperties(name)
    })
    document.getElementById(`btn-opts-${suffix}`)?.addEventListener('click', () => {
        const name = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value
        if (name) void window.cieloo.print.openPrinterOptions(name)
    })

    const selEl = document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null
    const propsBtn = document.getElementById(`btn-props-${suffix}`) as HTMLButtonElement | null
    const optsBtn  = document.getElementById(`btn-opts-${suffix}`) as HTMLButtonElement | null
    selEl?.addEventListener('change', () => {
        const hasVal = Boolean(selEl.value)
        if (propsBtn) propsBtn.disabled = !hasVal
        if (optsBtn)  optsBtn.disabled  = !hasVal
        scheduleSave(0)
    })

    ;['inp-width', 'inp-height', 'inp-copies'].forEach((prefix) => {
        const el = document.getElementById(`${prefix}-${suffix}`) as HTMLInputElement | null
        el?.addEventListener('input', () => scheduleSave())
        el?.addEventListener('change', () => scheduleSave(0))
    })

    void refreshPrinters(suffix, config.defaultPrinter)

    // Page de test code-barres (mode étiquette ou planche)
    document.getElementById(`btn-testpage-${suffix}`)?.addEventListener('click', async () => {
        collectTab(suffix)
        const btn = document.getElementById(`btn-testpage-${suffix}`) as HTMLButtonElement | null
        const statusEl = document.getElementById(`test-page-status-${suffix}`)
        if (btn) btn.disabled = true
        if (statusEl) { statusEl.textContent = 'Impression...'; statusEl.className = 'test-page-status' }
        const result = await window.cieloo.print.printBarcodeTest(config, tab.testMode)
        if (btn) btn.disabled = false
        if (statusEl) {
            statusEl.textContent = result.success ? '✓ Envoye' : `✗ ${result.message ?? 'Erreur'}`
            statusEl.className = `test-page-status ${result.success ? 'tp-ok' : 'tp-error'}`
            setTimeout(() => { if (statusEl) { statusEl.textContent = ''; statusEl.className = 'test-page-status' } }, 4000)
        }
    })
}

function renderTabs(): void {
    const nav = document.getElementById('tab-nav')!
    const panels = document.getElementById('tab-panels')!
    nav.innerHTML = ''
    panels.innerHTML = ''

    TABS.forEach((tab) => {
        const tabBtn = document.createElement('button')
        tabBtn.className = `tab-btn${tab.key === activeTab ? ' active' : ''}`
        tabBtn.textContent = tab.label
        const dot = document.createElement('span')
        dot.id = `tab-dot-${tab.key}`
        dot.className = 'tab-dot tab-dot-idle'
        dot.title = 'Verification...'
        tabBtn.appendChild(dot)
        nav.appendChild(tabBtn)
        tabBtn.addEventListener('click', () => {
            collectTab(activeTab)
            activeTab = tab.key
            renderTabs()
        })

        const panel = document.createElement('div')
        panel.className = `tab-panel${tab.key === activeTab ? '' : ' hidden'}`
        panel.innerHTML = buildPanelHtml(configs[tab.key], tab)
        panels.appendChild(panel)
    })

    TABS.forEach(wirePanel)
    void updateTabStatuses()
}

// ─── Driver install modal ─────────────────────────────────────────────────────

function showDriverModal(): void {
    document.getElementById('driver-modal')?.remove()

    const overlay = document.createElement('div')
    overlay.id = 'driver-modal'
    overlay.className = 'modal-overlay'

    const cards = DRIVER_MODELS.map((d, i) => `
        <button class="driver-card" data-driver="${i}">
            <div class="driver-card-brand">${d.brand}</div>
            <div class="driver-card-name">${d.name}</div>
            <div class="driver-card-meta">Windows · ${d.weight} · ${d.date}</div>
        </button>`).join('')

    overlay.innerHTML = `
        <div class="modal-box driver-modal-box">
            <p class="modal-title">Installer un driver code-barres</p>
            <p class="help" style="margin-bottom:14px">Choisissez le modèle de votre imprimante pour télécharger son driver.</p>
            <div class="driver-cards">${cards}</div>
            <div class="modal-actions" style="margin-top:16px">
                <button id="driver-cancel" class="btn btn-secondary">Fermer</button>
            </div>
        </div>
    `
    document.body.appendChild(overlay)

    overlay.querySelectorAll<HTMLButtonElement>('.driver-card').forEach((card) => {
        card.addEventListener('click', async () => {
            const idx = Number(card.dataset.driver)
            const model = DRIVER_MODELS[idx]
            if (!model) return
            const result = await window.cieloo.print.downloadDriver(model.url)
            toast(result.launched ? `Téléchargement du driver ${model.brand}…` : 'Échec du téléchargement')
            overlay.remove()
        })
    })

    document.getElementById('driver-cancel')?.addEventListener('click', () => overlay.remove())
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
    document.addEventListener('keydown', function esc(e) {
        if (e.key === 'Escape') { overlay.remove(); document.removeEventListener('keydown', esc) }
    })
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    const config = await window.cieloo.print.getConfig()
    if (config.barcodePrinter) configs.label = { ...config.barcodePrinter }
    if (config.barcodeSheetPrinter) configs.sheet = { ...config.barcodeSheetPrinter }
    activeTab = 'label'

    renderTabs()

    window.addEventListener('beforeunload', () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void persistConfig() }
    })

    document.getElementById('btn-install-driver')?.addEventListener('click', () => showDriverModal())
}

void init()
