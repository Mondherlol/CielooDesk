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

/** Affiche le texte par défaut configuré (au démarrage). Sans effet si désactivé. */
export async function pushIdleText(): Promise<void> {
    const config = loadSettings().customerDisplay
    if (!config.enabled || !config.port) return
    await sendToCustomerDisplay(config.line1, config.line2)
}

// ─── Affichage temps réel du panier ─────────────────────────────────────────────
// L'app POS (index.php) diffuse l'état du panier via BroadcastChannel('cieloopos_cart')
// à chaque ajout/retrait. On capte ce flux côté Electron (cf. preload + injection)
// et on affiche le total ici, sans rien modifier côté PHP / second screen.

interface CartState {
    lines?: unknown[]
    total_ttc?: number
    total_ttc_formatted?: string
}

let lastSentSignature = ''
let sendDebounce: NodeJS.Timeout | null = null

/** Centre / ajuste un libellé sur la largeur de l'afficheur. */
function center(text: string, columns: number): string {
    const t = text.slice(0, columns)
    const pad = Math.max(0, columns - t.length)
    const left = Math.floor(pad / 2)
    return ' '.repeat(left) + t
}

/** Construit les 2 lignes à afficher pour un panier (ou le message au repos). */
function formatCart(cart: CartState, columns: number, idle1: string, idle2: string): [string, string] {
    const hasItems = Array.isArray(cart.lines) && cart.lines.length > 0
    if (!hasItems) return [idle1, idle2]

    const amount = (cart.total_ttc_formatted ?? '').trim() || String(cart.total_ttc ?? 0)
    // Ligne 1 : libellé "TOTAL" centré ; Ligne 2 : montant centré.
    return [center('TOTAL', columns), center(amount, columns)]
}

/** Reçoit un état de panier (depuis le renderer) et l'affiche sur le VFD (debouncé). */
export function handleCartUpdate(cart: CartState): void {
    const config = loadSettings().customerDisplay
    if (!config.enabled || !config.port) return

    const [l1, l2] = formatCart(cart, config.columns, config.line1, config.line2)
    const signature = `${l1}\n${l2}`
    if (signature === lastSentSignature) return // rien de neuf, on évite de spammer le port
    lastSentSignature = signature

    if (sendDebounce) clearTimeout(sendDebounce)
    sendDebounce = setTimeout(() => {
        void sendToCustomerDisplay(l1, l2)
    }, 120)
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
