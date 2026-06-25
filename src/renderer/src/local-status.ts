// Fenetre « Statut du serveur » de la caisse locale.
// Affiche l'etat des serveurs PHP/MariaDB, les identifiants base, et propose des
// actions (ouvrir la caisse / l'explorateur de base dans le navigateur, journaux…).

/// <reference path="./types/types.d.ts" />

export {}

const $ = (id: string): HTMLElement => document.getElementById(id)!

const btnPos = $('btn-pos') as HTMLButtonElement
const btnDb = $('btn-db') as HTMLButtonElement
const btnLogs = $('btn-logs') as HTMLButtonElement
const btnRefresh = $('btn-refresh') as HTMLButtonElement
const btnCopy = $('btn-copy') as HTMLButtonElement
const btnOpenRoot = $('btn-open-root') as HTMLButtonElement

let info: LocalDebugInfoUI | null = null
let toastTimer: ReturnType<typeof setTimeout> | null = null

function toast(msg: string): void {
    const el = $('toast')
    el.textContent = msg
    el.classList.add('show')
    if (toastTimer) clearTimeout(toastTimer)
    toastTimer = setTimeout(() => el.classList.remove('show'), 1600)
}

function setDot(id: string, on: boolean): void {
    const el = $(id)
    el.classList.toggle('green', on)
    el.classList.toggle('red', !on)
}

function posUrl(i: LocalDebugInfoUI): string | null {
    return i.currentUrl ?? i.baseUrl
}

function render(i: LocalDebugInfoUI): void {
    info = i

    const running = i.phpRunning && i.dbRunning
    const badge = $('global-badge')
    badge.textContent = running ? '● En marche' : i.packPresent ? '● À l\'arrêt' : '● Non installée'
    badge.classList.toggle('on', running)
    badge.classList.toggle('off', !running)

    $('pack-sub').textContent = i.packPresent
        ? `Pack installé${i.packVersion ? ` · v${i.packVersion}` : ''} · Dolibarr ${i.installed ? 'configuré' : 'non configuré'}`
        : 'Pack non installé'

    setDot('web-dot', i.phpRunning)
    $('web-state').textContent = i.phpRunning ? 'En marche' : 'Arrêté'
    $('web-port').textContent = i.phpPort ? String(i.phpPort) : '—'
    $('web-url').textContent = i.baseUrl ?? '—'

    setDot('db-dot', i.dbRunning)
    $('db-state').textContent = i.dbRunning ? 'En marche' : 'Arrêté'
    $('db-port').textContent = i.dbPort ? String(i.dbPort) : '—'
    $('db-name').textContent = i.dbName

    $('cred-user').textContent = i.dbUser
    $('cred-pass').textContent = i.dbPassword ?? '—'
    $('path-root').textContent = i.paths.root

    btnPos.disabled = !posUrl(i)
    btnDb.disabled = !i.phpRunning || !i.dbAdminUrl
    btnCopy.disabled = !i.dbPassword
}

async function refresh(): Promise<void> {
    render(await window.cieloo.local.getDebugInfo())
}

btnPos.addEventListener('click', () => {
    const url = info && posUrl(info)
    if (url) void window.cieloo.local.openExternal(url)
})
btnDb.addEventListener('click', () => void window.cieloo.local.openDbAdmin())
btnLogs.addEventListener('click', () => { if (info) void window.cieloo.local.openPath(info.paths.logs) })
btnOpenRoot.addEventListener('click', () => { if (info) void window.cieloo.local.openPath(info.paths.root) })
btnRefresh.addEventListener('click', () => void refresh())

btnCopy.addEventListener('click', () => {
    if (!info) return
    const text = `host=127.0.0.1\nport=${info.dbPort ?? ''}\ndatabase=${info.dbName}\nuser=${info.dbUser}\npassword=${info.dbPassword ?? ''}`
    void window.cieloo.local.copy(text)
    toast('Identifiants copiés ✓')
})

// Le main peut demander un rafraichissement quand la fenetre est deja ouverte.
window.cieloo.local.onRefresh(() => void refresh())

void refresh()
