import { ipcMain } from 'electron'
import { SerialPort } from 'serialport'
import {
    loadSettings,
    setCustomerDisplaySettings,
    normalizeCustomerDisplay,
    type CustomerDisplaySettings,
    type CustomerDisplayProtocol,
} from '../settings/main'

// ─── Afficheur client VFD (pole display 2x20, ex. SAGA) ─────────────────────────
// Ces afficheurs « pixels verts sur fond noir » sont des VFD pilotés en série
// (port COM, souvent un câble USB qui crée un COM virtuel). On leur envoie du
// texte ASCII + des codes de contrôle selon le jeu de commandes du modèle.

const ESC = 0x1b
const CLR = 0x0c // efface l'écran
const CR = 0x0d

export interface SerialPortInfo {
    path: string
    label: string
}

export interface SendResult {
    success: boolean
    message?: string
}

/** Liste les ports série disponibles (COM1, COM3, …). */
export async function listSerialPorts(): Promise<SerialPortInfo[]> {
    try {
        const ports = await SerialPort.list()
        return ports.map((p) => ({
            path: p.path,
            label: [p.path, p.manufacturer, p.friendlyName]
                .filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
                .join(' — '),
        }))
    } catch {
        return []
    }
}

/** Ajuste une ligne à la largeur de l'afficheur (tronque + complète d'espaces). */
function fit(text: string, columns: number): string {
    return text.slice(0, columns).padEnd(columns, ' ')
}

/** Construit la trame d'octets à envoyer selon le protocole choisi. */
function buildPayload(
    line1: string,
    line2: string,
    protocol: CustomerDisplayProtocol,
    columns: number,
): Buffer {
    const l1 = fit(line1, columns)
    const l2 = fit(line2, columns)

    switch (protocol) {
        // CD5220 : la majorité des afficheurs SAGA / EPSON DM-D.
        // ESC '@' = init, ESC 'Q' 'A' = écriture ligne haute, 'B' = ligne basse.
        case 'cd5220':
            return Buffer.concat([
                Buffer.from([ESC, 0x40]),
                Buffer.from([ESC, 0x51, 0x41]), Buffer.from(l1, 'latin1'), Buffer.from([CR]),
                Buffer.from([ESC, 0x51, 0x42]), Buffer.from(l2, 'latin1'), Buffer.from([CR]),
            ])

        // ESC/POS : init puis écriture continue (l'afficheur passe seul en ligne 2).
        case 'esc-pos':
            return Buffer.concat([
                Buffer.from([ESC, 0x40]),
                Buffer.from([CLR]),
                Buffer.from(l1 + l2, 'latin1'),
            ])

        // Plain : on efface puis on écrit, l'afficheur boucle sur la ligne 2 à 20 car.
        case 'plain':
        default:
            return Buffer.concat([
                Buffer.from([CLR]),
                Buffer.from(l1 + l2, 'latin1'),
            ])
    }
}

/** Ouvre le port, envoie la trame, attend la fin d'écriture, referme. */
function writeToPort(portPath: string, baudRate: number, payload: Buffer): Promise<void> {
    return new Promise((resolve, reject) => {
        const port = new SerialPort(
            { path: portPath, baudRate, dataBits: 8, parity: 'none', stopBits: 1, autoOpen: false },
        )

        const fail = (err: Error): void => {
            if (port.isOpen) port.close(() => reject(err))
            else reject(err)
        }

        port.open((openErr) => {
            if (openErr) { reject(openErr); return }
            port.write(payload, (writeErr) => {
                if (writeErr) { fail(writeErr); return }
                port.drain((drainErr) => {
                    if (drainErr) { fail(drainErr); return }
                    // Petit délai pour laisser le VFD finir d'afficher avant fermeture.
                    setTimeout(() => port.close(() => resolve()), 120)
                })
            })
        })
    })
}

/** Envoie deux lignes de texte sur l'afficheur client (config explicite ou réglages). */
export async function sendToCustomerDisplay(
    line1: string,
    line2: string,
    override?: Partial<CustomerDisplaySettings>,
): Promise<SendResult> {
    const config = override
        ? normalizeCustomerDisplay({ ...loadSettings().customerDisplay, ...override })
        : loadSettings().customerDisplay

    if (!config.port) {
        return { success: false, message: 'Aucun port série sélectionné.' }
    }

    try {
        const payload = buildPayload(line1, line2, config.protocol, config.columns)
        await writeToPort(config.port, config.baudRate, payload)
        return { success: true }
    } catch (err) {
        return { success: false, message: err instanceof Error ? err.message : String(err) }
    }
}

// ─── Affichage temps réel du panier ─────────────────────────────────────────────
// L'app POS (index.php) diffuse l'état du panier via BroadcastChannel('cieloopos_cart')
// à chaque ajout/retrait. On capte ce flux côté Electron (cf. preload + injection)
// et on gère un petit "scénario" d'affichage : accueil → vente → merci → accueil.
// Sans rien modifier côté PHP / second screen.

interface CartLine {
    label?: string
    unit_ttc_formatted?: string
    unit_ttc?: number
}

interface CartState {
    lines?: CartLine[]
    total_ttc?: number
    total_ttc_formatted?: string
}

let lastSentSignature = ''
let sendDebounce: NodeJS.Timeout | null = null
let thankYouTimer: NodeJS.Timeout | null = null
let lastHadItems = false

// État courant de l'affichage panier (pour le défilement)
let scrollTimer: NodeJS.Timeout | null = null
let scrollFrames: number[] = [0] // suite d'offsets (avec pauses) à parcourir en boucle
let scrollIdx = 0
let cartView: { name: string; price: string; total: string; columns: number } | null = null

/** Centre un libellé sur la largeur de l'afficheur. */
function center(text: string, columns: number): string {
    const t = text.slice(0, columns)
    const left = Math.floor(Math.max(0, columns - t.length) / 2)
    return ' '.repeat(left) + t
}

/** Envoie 2 lignes au VFD, avec debounce + dé-duplication. */
function displayLines(l1: string, l2: string, force = false): void {
    const signature = `${l1}\n${l2}`
    if (!force && signature === lastSentSignature) return
    lastSentSignature = signature
    if (sendDebounce) clearTimeout(sendDebounce)
    sendDebounce = setTimeout(() => { void sendToCustomerDisplay(l1, l2) }, 80)
}

function stopScroll(): void {
    if (scrollTimer) { clearInterval(scrollTimer); scrollTimer = null }
    cartView = null
}

/** Largeur disponible pour le nom (le prix unitaire reste fixe à droite). */
function nameWidth(price: string, columns: number): number {
    return Math.max(1, columns - price.slice(0, columns).length - 1) // -1 = espace séparateur
}

/**
 * Construit la suite d'offsets de défilement selon la config :
 * pause au début, défilement (ou bascule directe si "instantané") jusqu'à
 * révéler la fin du nom, pause à la fin, puis retour au début.
 */
function buildScrollFrames(name: string, price: string, columns: number): number[] {
    const width = nameWidth(price, columns)
    if (name.length <= width) return [0]

    const c = loadSettings().customerDisplay
    const maxScroll = name.length - width
    // Nombre de "ticks" d'immobilité correspondant à la pause configurée.
    const hold = Math.max(0, Math.round((c.scrollStartPauseSec * 1000) / Math.max(1, c.scrollStepMs)))
    const frames: number[] = []

    if (c.scrollInstant) {
        // Bascule directe début ↔ fin (pas de défilement fluide).
        const h = Math.max(1, hold)
        for (let i = 0; i < h; i++) frames.push(0)
        for (let i = 0; i < h; i++) frames.push(maxScroll)
        return frames
    }

    for (let i = 0; i < hold; i++) frames.push(0)
    for (let p = 1; p <= maxScroll; p++) frames.push(p)
    for (let i = 0; i < hold; i++) frames.push(maxScroll)
    return frames.length > 0 ? frames : [0]
}

/** Ligne haute : nom (fenêtre à partir de l'offset) + prix unitaire fixe à droite. */
function buildItemLine(name: string, price: string, columns: number, offset: number): string {
    const priceStr = price.slice(0, columns)
    const width = nameWidth(price, columns)
    const namePart = name.slice(offset, offset + width).padEnd(width)
    const line = `${namePart} ${priceStr}`
    return line.length > columns ? line.slice(0, columns) : line.padEnd(columns)
}

/** Ligne basse : total, éventuellement préfixé du libellé ("TOTAL : 12,500"). */
function buildTotalLine(total: string, columns: number): string {
    const c = loadSettings().customerDisplay
    if (c.showTotalLabel && c.totalLabel.trim()) {
        return center(`${c.totalLabel.trim()} : ${total}`, columns)
    }
    return center(total, columns)
}

/** Rend une trame de l'affichage panier (appelée une fois, ou en boucle si défilement). */
function renderCartFrame(): void {
    if (!cartView) return
    const offset = scrollFrames[scrollIdx] ?? 0
    const top = buildItemLine(cartView.name, cartView.price, cartView.columns, offset)
    const bottom = buildTotalLine(cartView.total, cartView.columns)
    displayLines(top, bottom)
}

/** Démarre l'affichage du panier (dernier article + prix en haut, total en bas). */
function showCart(name: string, price: string, total: string, columns: number): void {
    stopScroll()
    cartView = { name, price, total, columns }
    scrollFrames = buildScrollFrames(name, price, columns)
    scrollIdx = 0
    renderCartFrame()

    if (scrollFrames.length > 1) {
        const stepMs = loadSettings().customerDisplay.scrollStepMs
        scrollTimer = setInterval(() => {
            scrollIdx = (scrollIdx + 1) % scrollFrames.length
            renderCartFrame()
        }, stepMs)
    }
}

/** Affiche le message d'accueil (panier vide). */
function showWelcome(): void {
    stopScroll()
    const c = loadSettings().customerDisplay
    displayLines(center(c.line1, c.columns), center(c.line2, c.columns))
}

/** Affiche le texte d'accueil au démarrage. Sans effet si désactivé. */
export async function pushIdleText(): Promise<void> {
    const c = loadSettings().customerDisplay
    if (!c.enabled || !c.port) return
    await sendToCustomerDisplay(center(c.line1, c.columns), center(c.line2, c.columns))
}

/** Reçoit un état de panier (depuis le renderer) et joue le scénario d'affichage. */
export function handleCartUpdate(cart: CartState): void {
    const c = loadSettings().customerDisplay
    if (!c.enabled || !c.port) return

    const lines = Array.isArray(cart.lines) ? cart.lines : []
    const hasItems = lines.length > 0

    if (hasItems) {
        // Vente en cours → on annule un éventuel "merci".
        if (thankYouTimer) { clearTimeout(thankYouTimer); thankYouTimer = null }
        lastHadItems = true

        const total = (cart.total_ttc_formatted ?? '').trim() || String(cart.total_ttc ?? 0)

        if (c.cartMode === 'total') {
            // Mode "total seul" : ligne 1 = libellé, ligne 2 = total (comme avant).
            stopScroll()
            displayLines(center(c.totalLabel, c.columns), center(total, c.columns))
            return
        }

        // Mode "detailed" : ligne 1 = dernier article + prix unitaire, ligne 2 = total.
        // lines[0] = dernier article scanné/ajouté (réordonné côté ajax_secondscreen.php)
        const last = lines[0] ?? {}
        const name = (last.label ?? '').trim()
        const unit = (last.unit_ttc_formatted ?? '').trim() || String(last.unit_ttc ?? '')
        showCart(name, unit, total, c.columns)
        return
    }

    // Panier vide : on arrête le défilement éventuel.
    stopScroll()

    // Si on sort d'une vente → message de fin éphémère, puis accueil.
    if (lastHadItems && c.thankYouEnabled) {
        lastHadItems = false
        displayLines(center(c.thankYouLine1, c.columns), center(c.thankYouLine2, c.columns), true)
        if (thankYouTimer) clearTimeout(thankYouTimer)
        thankYouTimer = setTimeout(() => {
            thankYouTimer = null
            showWelcome()
        }, Math.max(1, c.thankYouDurationSec) * 1000)
        return
    }

    lastHadItems = false
    // Ne pas écraser un "merci" en cours d'affichage.
    if (!thankYouTimer) showWelcome()
}

export function registerCustomerDisplayIpc(): void {
    ipcMain.handle('customer-display:list-ports', () => listSerialPorts())

    ipcMain.handle('customer-display:get-config', () => loadSettings().customerDisplay)

    ipcMain.handle('customer-display:save-config', (_e, config: Partial<CustomerDisplaySettings>) => {
        const saved = setCustomerDisplaySettings(config).customerDisplay
        lastSentSignature = '' // force un re-rendu au prochain update (texte/colonnes modifiés)
        return saved
    })

    ipcMain.handle(
        'customer-display:send',
        (_e, line1: string, line2: string, override?: Partial<CustomerDisplaySettings>) =>
            sendToCustomerDisplay(line1 ?? '', line2 ?? '', override),
    )

    // Flux temps réel du panier (relayé par le preload depuis le BroadcastChannel POS)
    ipcMain.on('customer-display:cart-update', (_e, cart: CartState) => handleCartUpdate(cart ?? {}))
}
