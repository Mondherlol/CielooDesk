// Fenetre « Config » de la caisse locale — même habillage que les Paramètres généraux.
// Onglets : « Écran de chargement » (mode prod/dev/debug) et « Pack & serveur »
// (état du pack local, chemin, source/URL du pack, serveur local).

/// <reference path="./types/types.d.ts" />
import './styles/settings.css'

export {}

type LoaderMode = 'prod' | 'dev' | 'debug'

const MODE_INFO: Record<LoaderMode, { name: string; desc: string }> = {
    prod: { name: 'Production (par défaut)', desc: 'Messages simples et sympathiques pour les caissiers, barre de progression et étapes. Aucun terme technique.' },
    dev: { name: 'Développeur', desc: 'Les vraies actions techniques (MariaDB, PHP, installation Dolibarr…) avec barre, étapes et journal détaillé.' },
    debug: { name: 'Débogage', desc: 'Console temps réel des actions de paramétrage, sans barre ni habillage.' },
}

// ─── Onglets ──────────────────────────────────────────────────────────────────
const items = Array.from(document.querySelectorAll<HTMLElement>('.sidebar-item'))
const tabs = Array.from(document.querySelectorAll<HTMLElement>('.settings-tab'))
let packLoaded = false

function showTab(tab: string): void {
    items.forEach((it) => it.classList.toggle('active', it.dataset.tab === tab))
    tabs.forEach((t) => t.classList.toggle('active', t.id === `tab-${tab}`))
    if (tab === 'pack' && !packLoaded) { packLoaded = true; void loadPackInfo() }
}
items.forEach((it) => it.addEventListener('click', () => showTab(it.dataset.tab as string)))

// ─── Écran de chargement ──────────────────────────────────────────────────────
const select = document.getElementById('loader-mode') as HTMLSelectElement
const modeName = document.getElementById('mode-name')!
const modeDesc = document.getElementById('mode-desc')!
const savedEl = document.getElementById('saved')!
let savedTimer: ReturnType<typeof setTimeout> | null = null

function describe(mode: LoaderMode): void {
    modeName.textContent = MODE_INFO[mode].name
    modeDesc.textContent = MODE_INFO[mode].desc
}
function flashSaved(): void {
    savedEl.classList.add('show')
    if (savedTimer) clearTimeout(savedTimer)
    savedTimer = setTimeout(() => savedEl.classList.remove('show'), 1600)
}

select.addEventListener('change', async () => {
    const mode = select.value as LoaderMode
    describe(mode)
    const applied = await window.cieloo.local.setLoaderMode(mode)
    select.value = applied
    describe(applied)
    flashSaved()
})

void window.cieloo.local.getLoaderMode().then((mode) => { select.value = mode; describe(mode) })

// ─── Pack & serveur ───────────────────────────────────────────────────────────
const $ = (id: string) => document.getElementById(id)!

function fmtSize(bytes?: number): string {
    if (!bytes) return '—'
    const mb = bytes / 1048576
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} Go` : `${mb.toFixed(1)} Mo`
}

let info: LocalPackInfoUI | null = null

async function loadPackInfo(): Promise<void> {
    info = await window.cieloo.local.getPackInfo()

    const state = $('pack-state')
    state.className = `pill ${info.present ? 'ok' : 'warn'}`
    state.innerHTML = `<span class="dot"></span>${info.present ? 'Installé' : 'Non installé'}`

    $('pack-version').textContent = info.version || '—'
    ;($('pack-path') as HTMLInputElement).value = info.paths?.root || '—'

    $('pack-origin').textContent = info.usingDashboard ? 'Cloud (dashboard)' : 'URL configurée'
    $('pack-origin-desc').textContent = info.usingDashboard
        ? 'Téléchargé automatiquement depuis le dashboard.'
        : 'LOCAL_PACK_URL défini sur ce poste.'

    $('pack-cloud').textContent = info.cloud
        ? `v${info.cloud.version} · ${fmtSize(info.cloud.size)}`
        : (info.cloudError ? 'indisponible (hors-ligne ?)' : '—')

    ;($('pack-url') as HTMLInputElement).value = info.effectiveUrl || '—'
    $('srv-base').textContent = info.baseUrl || '—'
    ;($('btn-open-db') as HTMLButtonElement).disabled = !info.dbAdminUrl
}

$('btn-open-path').addEventListener('click', () => { if (info?.paths?.root) void window.cieloo.local.openPath(info.paths.root) })
$('btn-copy-url').addEventListener('click', () => {
    if (info?.effectiveUrl) { void window.cieloo.local.copy(info.effectiveUrl) }
})
$('btn-open-db').addEventListener('click', () => void window.cieloo.local.openDbAdmin())
$('btn-refresh').addEventListener('click', () => void loadPackInfo())
