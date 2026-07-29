// Bruitages de la caisse. Les mp3 sont CEUX de la caisse online (module
// cieloopos) pour que le mode local sonne exactement pareil ; les bips
// synthétiques (WebAudio) couvrent le reste sans fichier supplémentaire.

import beepScanUrl from '../assets/beepScan.mp3'
import addingProductUrl from '../assets/AddingProduct.mp3'

const scanAudio = new Audio(beepScanUrl)
const addAudio = new Audio(addingProductUrl)
scanAudio.volume = 0.6
addAudio.volume = 0.5

function replay(audio: HTMLAudioElement): void {
    audio.currentTime = 0
    void audio.play().catch(() => { /* autoplay bloqué avant 1er geste : tant pis */ })
}

/** Scan douchette reconnu. */
export function playScan(): void { replay(scanAudio) }

/** Produit ajouté au panier (clic sur une tuile, +1). */
export function playAdd(): void { replay(addAudio) }

// ─── Bips synthétiques ──────────────────────────────────────────────────────

let ctx: AudioContext | null = null

function audioCtx(): AudioContext {
    if (!ctx) ctx = new AudioContext()
    if (ctx.state === 'suspended') void ctx.resume()
    return ctx
}

function tone(freq: number, startMs: number, durMs: number, type: OscillatorType, volume: number): void {
    const ac = audioCtx()
    const osc = ac.createOscillator()
    const gain = ac.createGain()
    const t0 = ac.currentTime + startMs / 1000
    const t1 = t0 + durMs / 1000
    osc.type = type
    osc.frequency.value = freq
    gain.gain.setValueAtTime(volume, t0)
    gain.gain.exponentialRampToValueAtTime(0.001, t1)
    osc.connect(gain).connect(ac.destination)
    osc.start(t0)
    osc.stop(t1)
}

/** Erreur (code-barres inconnu, action refusée) : double buzz grave. */
export function playError(): void {
    tone(180, 0, 130, 'square', 0.12)
    tone(140, 150, 180, 'square', 0.12)
}

/** Vente encaissée : petit carillon ascendant. */
export function playSuccess(): void {
    tone(880, 0, 120, 'sine', 0.18)
    tone(1174, 110, 140, 'sine', 0.18)
    tone(1568, 230, 220, 'sine', 0.16)
}

/** Retrait / décrément / vider : tick discret. */
export function playTick(): void {
    tone(520, 0, 45, 'triangle', 0.1)
}
