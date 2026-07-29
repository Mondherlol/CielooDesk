import './styles/print-settings.css'
import type { BalanceSettings, BalanceTvaMapping } from '../../modules/settings/main'

// ─── Toast ──────────────────────────────────────────────────────────────────
function toast(msg: string): void {
    const el = document.getElementById('toast')!
    el.textContent = msg
    el.classList.add('visible')
    setTimeout(() => el.classList.remove('visible'), 2200)
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T

let current: BalanceSettings

// ─── TVA mapping table ──────────────────────────────────────────────────────
function renderTvaRows(map: BalanceTvaMapping[]): void {
    const tbody = $('bal-tva-rows')
    tbody.innerHTML = ''
    map.forEach((m, i) => {
        const tr = document.createElement('tr')
        tr.innerHTML = `
            <td><input type="number" step="0.1" class="tva-taux" data-i="${i}" value="${m.taux}" /></td>
            <td><input type="number" min="0" max="99" class="tva-id" data-i="${i}" value="${m.id}" /></td>
            <td><button class="bal-row-del" data-i="${i}">✕</button></td>`
        tbody.appendChild(tr)
    })
    tbody.querySelectorAll<HTMLInputElement>('.tva-taux, .tva-id').forEach((el) => {
        el.addEventListener('change', () => { collectTva(); scheduleSave() })
    })
    tbody.querySelectorAll<HTMLButtonElement>('.bal-row-del').forEach((btn) => {
        btn.addEventListener('click', () => {
            const i = Number(btn.dataset.i)
            current.tvaMap.splice(i, 1)
            renderTvaRows(current.tvaMap)
            scheduleSave()
        })
    })
}

function collectTva(): void {
    const taux = Array.from(document.querySelectorAll<HTMLInputElement>('.tva-taux'))
    const ids = Array.from(document.querySelectorAll<HTMLInputElement>('.tva-id'))
    const map: BalanceTvaMapping[] = []
    taux.forEach((t, i) => {
        const tx = Number(t.value)
        const id = Number(ids[i]?.value)
        if (Number.isFinite(tx) && Number.isInteger(id)) map.push({ taux: tx, id })
    })
    current.tvaMap = map
}

// ─── Collect & save ─────────────────────────────────────────────────────────
function collect(): Partial<BalanceSettings> {
    collectTva()
    return {
        // Le mode balance s'active/désactive depuis les Paramètres généraux :
        // on préserve ici la valeur courante sans l'exposer dans cette fenêtre.
        enabled: current.enabled,
        fileName: ($('bal-filename') as HTMLInputElement).value.trim() || 'Articles.txt',
        defaultType: Number(($('bal-type') as HTMLSelectElement).value) === 1 ? 1 : 2,
        priceDecimals: Number(($('bal-decimals') as HTMLInputElement).value),
        nameMaxLength: Number(($('bal-namelen') as HTMLInputElement).value),
        refreshIntervalMin: Number(($('bal-interval') as HTMLInputElement).value),
        webhookPort: Number(($('bal-webhook') as HTMLInputElement).value),
        defaultTvaId: Number(($('bal-default-tvaid') as HTMLInputElement).value),
        apiKey: ($('bal-apikey') as HTMLInputElement).value.trim(),
        tvaMap: current.tvaMap,
        exportFolder: current.exportFolder,
    }
}

let saveTimer: ReturnType<typeof setTimeout> | null = null
async function save(): Promise<void> {
    current = await window.cieloo.balance.saveConfig(collect())
}
function scheduleSave(delay = 400): void {
    if (saveTimer) clearTimeout(saveTimer)
    saveTimer = setTimeout(() => {
        saveTimer = null
        save().then(() => toast('Enregistré')).catch(() => toast('Échec de l\'enregistrement'))
    }, delay)
}

// ─── Status & preview ───────────────────────────────────────────────────────
function showStatus(text: string, kind: 'ok' | 'err' | 'info'): void {
    const el = $('bal-status')
    el.textContent = text
    el.className = `bal-status ${kind}`
    el.style.display = ''
}

async function refreshPreview(): Promise<void> {
    $('bal-count').textContent = 'Chargement de l\'aperçu…'
    $('bal-preview').textContent = ''
    const res = await window.cieloo.balance.preview()
    if (!res.ok) {
        $('bal-count').textContent = ''
        showStatus(`Aperçu impossible : ${res.error ?? 'erreur inconnue'}`, 'err')
        return
    }
    $('bal-count').textContent = `${res.count} produit(s) éligible(s) (réf à 5 chiffres)`
    $('bal-preview').textContent = res.content || '(aucun produit)'
}

async function generateNow(): Promise<void> {
    const btn = $('bal-generate') as HTMLButtonElement
    btn.disabled = true
    showStatus('Génération en cours…', 'info')
    const r = await window.cieloo.balance.generateNow()
    btn.disabled = false
    if (!r.ok) { showStatus(`Échec : ${r.error ?? 'erreur'}`, 'err'); return }
    if (r.written) showStatus(`✓ Fichier écrit (${r.count} article(s)) → ${r.filePath}`, 'ok')
    else if (r.skipped) showStatus(`Aucun changement (${r.count} article(s)) — fichier déjà à jour`, 'info')
    void refreshPreview()
}

// ─── Init ───────────────────────────────────────────────────────────────────
async function init(): Promise<void> {
    current = await window.cieloo.balance.getConfig()

    ;($('bal-folder') as HTMLInputElement).value = current.exportFolder ?? ''
    ;($('bal-filename') as HTMLInputElement).value = current.fileName
    ;($('bal-type') as HTMLSelectElement).value = String(current.defaultType)
    ;($('bal-decimals') as HTMLInputElement).value = String(current.priceDecimals)
    ;($('bal-namelen') as HTMLInputElement).value = String(current.nameMaxLength)
    ;($('bal-interval') as HTMLInputElement).value = String(current.refreshIntervalMin)
    ;($('bal-webhook') as HTMLInputElement).value = String(current.webhookPort)
    ;($('bal-default-tvaid') as HTMLInputElement).value = String(current.defaultTvaId)
    ;($('bal-apikey') as HTMLInputElement).value = current.apiKey ?? ''
    renderTvaRows(current.tvaMap)

    ;['bal-filename', 'bal-type', 'bal-decimals', 'bal-namelen', 'bal-interval', 'bal-webhook', 'bal-default-tvaid', 'bal-apikey']
        .forEach((id) => {
            $(id).addEventListener('change', () => scheduleSave(0))
            $(id).addEventListener('input', () => scheduleSave())
        })

    $('bal-browse').addEventListener('click', async () => {
        const folder = await window.cieloo.balance.selectFolder()
        if (folder) {
            current.exportFolder = folder
            ;($('bal-folder') as HTMLInputElement).value = folder
            toast('Dossier sélectionné')
        }
    })

    $('bal-tva-add').addEventListener('click', () => {
        current.tvaMap.push({ taux: 0, id: current.defaultTvaId })
        renderTvaRows(current.tvaMap)
        scheduleSave()
    })

    $('bal-generate').addEventListener('click', () => void generateNow())
    $('bal-refresh-preview').addEventListener('click', () => void refreshPreview())

    window.cieloo.balance.onStatusUpdated((r) => {
        if (r.written) showStatus(`✓ Mis à jour automatiquement (${r.count} article(s))`, 'ok')
    })

    window.addEventListener('beforeunload', () => {
        if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; void save() }
    })

    // Aperçu initial (best-effort)
    void refreshPreview().catch(() => { /* ignore */ })
}

void init()
