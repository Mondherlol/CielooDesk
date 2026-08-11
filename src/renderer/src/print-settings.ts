import './styles/print-settings.css'
import type { PrintSettings, PrinterConfig } from '../../modules/settings/main'
import type { MultiprintSection } from './types/types'

let printers: PrinterConfig[] = []
let sections: MultiprintSection[] | null = null
let sectionsMode = false
let activeTabIndex = 0

const SECTIONS_CACHE_KEY = 'cieloo-multiprint-sections'

// Dimensions par defaut d'une imprimante ticket (mm). Doit rester aligne sur
// DEFAULT_POS_DIMS dans src/modules/settings/main.ts.
const DEFAULT_PAPER_WIDTH = 64
const DEFAULT_PAPER_HEIGHT = 297

function saveSectionsToCache(): void {
    try { localStorage.setItem(SECTIONS_CACHE_KEY, JSON.stringify(sections)) } catch {}
}

function loadSectionsFromCache(): MultiprintSection[] | null {
    try {
        const raw = localStorage.getItem(SECTIONS_CACHE_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw) as unknown
        if (Array.isArray(parsed) && parsed.length > 0) return parsed as MultiprintSection[]
    } catch {}
    return null
}

// ─── Utilities ────────────────────────────────────────────────────────────────

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

function escapeHtml(str: string): string {
    return str.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

// ─── Sections ↔ printers sync ─────────────────────────────────────────────────

function sectionPrinterId(rowid: number): string {
    return `mp-section-${rowid}`
}

function syncPrintersWithSections(loadedSections: MultiprintSection[]): void {
    for (const section of loadedSections) {
        const id = sectionPrinterId(section.rowid)
        const existing = printers.find(p => p.id === id)
        if (!existing) {
            printers.push({
                id,
                label: section.label,
                defaultPrinter: null,
                paperWidth: DEFAULT_PAPER_WIDTH,
                paperHeight: DEFAULT_PAPER_HEIGHT,
                copies: 1,
            })
        }
    }
}

function displayedPrinters(): PrinterConfig[] {
    if (!sectionsMode || !sections) return printers
    return sections.map(s => printers.find(p => p.id === sectionPrinterId(s.rowid))!)
}

function activeConfig(): PrinterConfig | undefined {
    return displayedPrinters()[activeTabIndex]
}

// ─── Active tab collection ─────────────────────────────────────────────────────

function collectTab(config: PrinterConfig, suffix: string | number): void {
    const g = <T extends HTMLElement>(id: string) => document.getElementById(id) as T | null

    const printerEl = g<HTMLSelectElement>(`inp-printer-${suffix}`)
    const widthEl   = g<HTMLInputElement>(`inp-width-${suffix}`)
    const heightEl  = g<HTMLInputElement>(`inp-height-${suffix}`)
    const copiesEl  = g<HTMLInputElement>(`inp-copies-${suffix}`)

    if (printerEl) config.defaultPrinter = printerEl.value || null
    if (widthEl)   config.paperWidth    = clampInt(Number(widthEl.value), 1, 1000, DEFAULT_PAPER_WIDTH)
    if (heightEl)  config.paperHeight   = clampInt(Number(heightEl.value), 1, 2000, DEFAULT_PAPER_HEIGHT)
    if (copiesEl)  config.copies        = clampInt(Number(copiesEl.value), 1, 99, 1)
}

function collectActiveTab(): void {
    const config = activeConfig()
    if (!config) return
    collectTab(config, activeTabIndex)
}

// ─── Auto-save ─────────────────────────────────────────────────────────────────
// Chaque modification est enregistrée automatiquement (plus de bouton « Enregistrer »).

let saveTimer: ReturnType<typeof setTimeout> | null = null

async function persistConfig(): Promise<void> {
    collectActiveTab()
    // N'envoie que les imprimantes de caisse : les imprimantes code-barres sont
    // gérées par leur propre fenêtre (saveConfig fusionne avec la config existante).
    const payload: Partial<PrintSettings> = {
        printers: printers.map(p => ({ ...p })),
    }
    await window.cieloo.print.saveConfig(payload)
    void updateTabStatuses()
}

/** Enregistre après une courte temporisation (regroupe les frappes successives). */
function scheduleSave(delay = 400): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        saveTimer = null
        persistConfig()
            .then(() => toast('Enregistré'))
            .catch(() => toast('Échec de l\'enregistrement'))
    }, delay)
}

// ─── Printer list refresh ─────────────────────────────────────────────────────

async function refreshPrinters(tabIndex: number | string, selected: string | null): Promise<void> {
    const systemPrinters = await window.cieloo.print.getPrinters()
    const selectEl = document.getElementById(`inp-printer-${tabIndex}`) as HTMLSelectElement | null
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
    const applyDot = (dotId: string, config: PrinterConfig): void => {
        const dot = document.getElementById(dotId)
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
    displayedPrinters().forEach((config, index) => applyDot(`tab-dot-${index}`, config))
}

// ─── SVG icons ────────────────────────────────────────────────────────────────

const SVG_PRINTER = `<svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/></svg>`
const SVG_REFRESH = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>`
const SVG_SETTINGS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>`
const SVG_SLIDERS = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="21" x2="4" y2="14"/><line x1="4" y1="10" x2="4" y2="3"/><line x1="12" y1="21" x2="12" y2="12"/><line x1="12" y1="8" x2="12" y2="3"/><line x1="20" y1="21" x2="20" y2="16"/><line x1="20" y1="12" x2="20" y2="3"/><line x1="1" y1="14" x2="7" y2="14"/><line x1="9" y1="8" x2="15" y2="8"/><line x1="17" y1="16" x2="23" y2="16"/></svg>`
const SVG_PRINT_TEST = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 6 2 18 2 18 9"/><path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2"/><rect x="6" y="14" width="12" height="8"/><line x1="9" y1="18" x2="15" y2="18"/></svg>`
const SVG_TRASH = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/></svg>`

// ─── Panel HTML ───────────────────────────────────────────────────────────────

function buildPanelHtml(config: PrinterConfig, index: number | string): string {
    const dis = config.defaultPrinter ? '' : ' disabled'
    return `
        <div class="p-section">
            <div class="p-section-title">Imprimante Windows</div>
            <div class="p-printer-row">
                <select id="inp-printer-${index}" class="p-printer-select"></select>
                <button id="btn-refresh-${index}" class="p-icon-btn" title="Actualiser la liste">${SVG_REFRESH}</button>
            </div>
            <div class="p-action-row">
                <button id="btn-props-${index}" class="p-action-btn"${dis}>${SVG_SETTINGS} Proprietes</button>
                <button id="btn-opts-${index}" class="p-action-btn"${dis}>${SVG_SLIDERS} Options d'impression</button>
            </div>
        </div>

        <div class="p-section">
            <div class="p-section-title">Format du papier</div>
            <div class="p-paper-grid">
                <div class="p-field">
                    <label for="inp-width-${index}">Largeur <span class="p-unit">mm</span></label>
                    <input id="inp-width-${index}" type="number" min="1" max="1000" value="${config.paperWidth}" />
                </div>
                <div class="p-field">
                    <label for="inp-height-${index}">Hauteur <span class="p-unit">mm</span></label>
                    <input id="inp-height-${index}" type="number" min="1" max="2000" value="${config.paperHeight}" />
                </div>
                <div class="p-field">
                    <label for="inp-copies-${index}">Copies</label>
                    <input id="inp-copies-${index}" type="number" min="1" max="99" value="${config.copies}" />
                </div>
            </div>
        </div>

        <div class="p-test-bar">
            <button id="btn-testpage-${index}" class="p-test-btn">${SVG_PRINT_TEST} Imprimer page de test</button>
            <span id="test-page-status-${index}" class="test-page-status"></span>
        </div>
    `
}

async function reloadSections(): Promise<void> {
    const result = await window.cieloo.multiprint.getSections()
    if (result.sections && result.sections.length > 0) {
        sections = result.sections as MultiprintSection[]
        sectionsMode = true
        syncPrintersWithSections(sections)
        saveSectionsToCache()
    }
    // If fetch failed, keep current state (don't wipe cached sections)
    activeTabIndex = 0
    renderTabs()
    void updateTabStatuses()
}

// ─── Context menu & rename modal ──────────────────────────────────────────────

function showContextMenu(x: number, y: number, index: number, currentLabel: string): void {
    document.getElementById('tab-ctx-menu')?.remove()

    const menu = document.createElement('div')
    menu.id = 'tab-ctx-menu'
    menu.className = 'tab-ctx-menu'
    menu.style.left = `${x}px`
    menu.style.top = `${y}px`

    const renameBtn = document.createElement('button')
    renameBtn.className = 'tab-ctx-item'
    renameBtn.textContent = 'Changer Nom de la Section'
    menu.appendChild(renameBtn)

    if (!sectionsMode && printers.length > 1) {
        const sep = document.createElement('div')
        sep.style.cssText = 'height:1px;background:var(--border);margin:4px 0'
        menu.appendChild(sep)

        const deleteBtn = document.createElement('button')
        deleteBtn.className = 'tab-ctx-item tab-ctx-item-danger'
        deleteBtn.textContent = 'Supprimer'
        menu.appendChild(deleteBtn)
        deleteBtn.addEventListener('click', () => {
            menu.remove()
            collectActiveTab()
            printers.splice(index, 1)
            if (activeTabIndex >= printers.length) activeTabIndex = printers.length - 1
            renderTabs()
            scheduleSave(0)
        })
    }

    document.body.appendChild(menu)
    renameBtn.addEventListener('click', () => { menu.remove(); showRenameModal(index, currentLabel) })

    const close = (e: MouseEvent) => {
        if (!menu.contains(e.target as Node)) { menu.remove(); document.removeEventListener('click', close) }
    }
    setTimeout(() => document.addEventListener('click', close), 0)
}

function showRenameModal(index: number, currentLabel: string): void {
    document.getElementById('tab-rename-modal')?.remove()

    const overlay = document.createElement('div')
    overlay.id = 'tab-rename-modal'
    overlay.className = 'modal-overlay'
    overlay.innerHTML = `
        <div class="modal-box">
            <p class="modal-title">Renommer</p>
            <input id="modal-rename-input" class="modal-input" type="text" value="${escapeHtml(currentLabel)}" maxlength="64" />
            <div class="modal-actions">
                <button id="modal-cancel" class="btn btn-secondary">Annuler</button>
                <button id="modal-ok" class="btn btn-primary">OK</button>
            </div>
        </div>
    `
    document.body.appendChild(overlay)

    const input = document.getElementById('modal-rename-input') as HTMLInputElement
    input.focus()
    input.select()

    const doRename = () => {
        const newLabel = input.value.trim()
        if (newLabel) {
            printers[index].label = newLabel
            if (sectionsMode && sections && sections[index]) {
                sections[index] = { ...sections[index], label: newLabel }
                saveSectionsToCache()
            }
            renderTabs()
            scheduleSave(0)
        }
        overlay.remove()
    }

    document.getElementById('modal-ok')?.addEventListener('click', doRename)
    document.getElementById('modal-cancel')?.addEventListener('click', () => overlay.remove())
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') doRename()
        if (e.key === 'Escape') overlay.remove()
    })
    overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove() })
}

// ─── Tab rendering ────────────────────────────────────────────────────────────

/** Branche les contrôles d'un panneau (sélecteur, propriétés, options, page de test). */
function wirePanel(config: PrinterConfig, suffix: string | number): void {
    // Printer list refresh
    document.getElementById(`btn-refresh-${suffix}`)?.addEventListener('click', async () => {
        const sel = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value || null
        await refreshPrinters(suffix, sel)
        toast('Imprimantes actualisees')
    })

    // Open printer properties / options
    document.getElementById(`btn-props-${suffix}`)?.addEventListener('click', () => {
        const name = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value
        if (name) void window.cieloo.print.openPrinterProperties(name)
    })
    document.getElementById(`btn-opts-${suffix}`)?.addEventListener('click', () => {
        const name = (document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null)?.value
        if (name) void window.cieloo.print.openPrinterOptions(name)
    })

    // Enable/disable action buttons when selection changes + enregistrement auto
    const selEl = document.getElementById(`inp-printer-${suffix}`) as HTMLSelectElement | null
    const propsBtn = document.getElementById(`btn-props-${suffix}`) as HTMLButtonElement | null
    const optsBtn  = document.getElementById(`btn-opts-${suffix}`) as HTMLButtonElement | null
    selEl?.addEventListener('change', () => {
        const hasVal = Boolean(selEl.value)
        if (propsBtn) propsBtn.disabled = !hasVal
        if (optsBtn)  optsBtn.disabled  = !hasVal
        scheduleSave(0) // changement de driver → enregistrement immédiat
    })

    // Format papier / copies → enregistrement auto (débounce pendant la frappe,
    // immédiat à la perte de focus / Entrée)
    ;['inp-width', 'inp-height', 'inp-copies'].forEach((prefix) => {
        const el = document.getElementById(`${prefix}-${suffix}`) as HTMLInputElement | null
        el?.addEventListener('input', () => scheduleSave())
        el?.addEventListener('change', () => scheduleSave(0))
    })

    void refreshPrinters(suffix, config.defaultPrinter)

    // Print test page
    document.getElementById(`btn-testpage-${suffix}`)?.addEventListener('click', async () => {
        collectActiveTab()
        const btn = document.getElementById(`btn-testpage-${suffix}`) as HTMLButtonElement | null
        const statusEl = document.getElementById(`test-page-status-${suffix}`)
        if (btn) btn.disabled = true
        if (statusEl) { statusEl.textContent = 'Impression...'; statusEl.className = 'test-page-status' }
        const result = await window.cieloo.print.printTest(config)
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

    const displayed = displayedPrinters()

    displayed.forEach((config, index) => {
        const section = sectionsMode && sections ? sections[index] : undefined

        const tabBtn = document.createElement('button')
        tabBtn.className = `tab-btn${index === activeTabIndex ? ' active' : ''}`
        tabBtn.textContent = section ? section.label : (config.label || `Imprimante ${index + 1}`)
        const dot = document.createElement('span')
        dot.id = `tab-dot-${index}`
        dot.className = 'tab-dot tab-dot-idle'
        dot.title = 'Verification...'
        tabBtn.appendChild(dot)
        nav.appendChild(tabBtn)

        const panel = document.createElement('div')
        panel.className = `tab-panel${index === activeTabIndex ? '' : ' hidden'}`
        panel.innerHTML = buildPanelHtml(config, index)
        panels.appendChild(panel)
    })

    if (!sectionsMode) {
        const addBtn = document.createElement('button')
        addBtn.className = 'tab-btn tab-add'
        addBtn.textContent = '+ Ajouter'
        nav.appendChild(addBtn)
        addBtn.addEventListener('click', () => {
            collectActiveTab()
            printers.push({
                id: `printer-${Date.now()}`,
                label: `Imprimante ${printers.length + 1}`,
                defaultPrinter: null,
                paperWidth: DEFAULT_PAPER_WIDTH,
                paperHeight: DEFAULT_PAPER_HEIGHT,
                copies: 1,
            })
            activeTabIndex = printers.length - 1
            renderTabs()
            scheduleSave(0)
        })
    }

    const tabBtns = nav.querySelectorAll<HTMLButtonElement>('.tab-btn:not(.tab-add)')

    displayed.forEach((config, index) => {
        // Tab switch
        tabBtns[index].addEventListener('click', () => {
            collectActiveTab()
            activeTabIndex = index
            renderTabs()
        })

        // Right-click rename
        tabBtns[index].addEventListener('contextmenu', (e) => {
            e.preventDefault()
            const currentLabel = sectionsMode && sections?.[index] ? sections[index].label : config.label
            showContextMenu(e.clientX, e.clientY, index, currentLabel)
        })

        wirePanel(config, index)
    })

    void updateTabStatuses()
}

// ─── Init ─────────────────────────────────────────────────────────────────────

async function init(): Promise<void> {
    const config = await window.cieloo.print.getConfig()
    printers = config.printers.map((p: PrinterConfig) => ({ ...p }))
    activeTabIndex = 0

    // Try to load MultiPrint sections via Dolibarr session cookies
    const result = await window.cieloo.multiprint.getSections()
    if (result.sections && result.sections.length > 0) {
        sections = result.sections as MultiprintSection[]
        sectionsMode = true
        syncPrintersWithSections(sections)
        saveSectionsToCache()
    } else {
        // Fallback: use locally cached sections from last successful fetch
        const cached = loadSectionsFromCache()
        if (cached) {
            sections = cached
            sectionsMode = true
            syncPrintersWithSections(sections)
        }
    }

    renderTabs()

    // Filet de sécurité : enregistre une éventuelle modification en attente avant fermeture.
    window.addEventListener('beforeunload', () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void persistConfig() }
    })

    document.getElementById('btn-reload-sections')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-reload-sections') as HTMLButtonElement | null
        if (btn) btn.disabled = true
        await reloadSections()
        if (btn) btn.disabled = false
        toast('Sections rechargées')
    })

    document.getElementById('btn-install-driver')?.addEventListener('click', async () => {
        const btn = document.getElementById('btn-install-driver') as HTMLButtonElement | null
        if (btn) btn.disabled = true
        const result = await window.cieloo.print.installDriver()
        if (btn) btn.disabled = false
        if (result.launched) {
            toast('Installation lancée…')
            setTimeout(async () => {
                const displayed = displayedPrinters()
                for (let i = 0; i < displayed.length; i++) {
                    await refreshPrinters(i, displayed[i].defaultPrinter)
                }
                void updateTabStatuses()
            }, 8000)
        } else {
            toast('Driver introuvable dans les ressources.')
        }
    })

}

void init()
