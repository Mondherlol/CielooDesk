import './styles/print-settings.css'

type PortInfo = { port: number; pid: number | null; processName: string | null; listening: boolean }

type NacefPingResult = { available: boolean; statusCode?: number; error?: string }

declare global {
    interface Window {
        cieloo: {
            tech: {
                getPortInfo: () => Promise<PortInfo[]>
                pingNacef: (port: number) => Promise<NacefPingResult>
            }
        }
    }
}

async function refresh(): Promise<void> {
    const btn = document.getElementById('btn-refresh') as HTMLButtonElement
    const container = document.getElementById('ports-container')!
    btn.disabled = true

    const results = await window.cieloo.tech.getPortInfo()

    container.innerHTML = results.map(({ port, pid, processName, listening }) => {
        const statusClass = listening ? 'port-status--used' : 'port-status--free'
        const statusLabel = listening ? 'Occupé' : 'Libre'
        const processLabel = listening
            ? `<span class="port-process">${processName ?? 'Inconnu'}</span> <span class="port-pid">PID ${pid}</span>`
            : `<span class="port-free-label">Aucun processus</span>`

        return `
            <div class="port-row">
                <div class="port-number">:<strong>${port}</strong></div>
                <div class="port-info">${processLabel}</div>
                <div class="port-status ${statusClass}">${statusLabel}</div>
            </div>
        `
    }).join('')

    btn.disabled = false
}

async function pingNacef(): Promise<void> {
    const btn = document.getElementById('btn-ping-nacef') as HTMLButtonElement
    const input = document.getElementById('nacef-port') as HTMLInputElement
    const result = document.getElementById('nacef-result')!
    const port = parseInt(input.value, 10)
    if (!port || port < 1 || port > 65535) return

    btn.disabled = true
    result.innerHTML = `<span class="nacef-result-detail">Vérification…</span>`

    const res = await window.cieloo.tech.pingNacef(port)

    if (res.available) {
        const code = res.statusCode ? ` HTTP ${res.statusCode}` : ''
        result.innerHTML = `
            <span class="nacef-badge nacef-badge--up">Disponible</span>
            <span class="nacef-result-detail">Port ${port} répond${code}</span>`
    } else {
        const detail = res.error === 'timeout' ? 'délai dépassé' : (res.error ?? 'connexion refusée')
        result.innerHTML = `
            <span class="nacef-badge nacef-badge--down">Indisponible</span>
            <span class="nacef-result-detail">${detail}</span>`
    }

    btn.disabled = false
}

document.addEventListener('DOMContentLoaded', () => { void refresh() })
document.getElementById('btn-refresh')?.addEventListener('click', () => void refresh())
document.getElementById('btn-ping-nacef')?.addEventListener('click', () => void pingNacef())
