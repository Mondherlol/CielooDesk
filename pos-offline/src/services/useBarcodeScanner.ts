// Capture les scans douchette (rafale de caractères + Entrée) quand aucun champ
// n'a le focus. Une frappe humaine est trop lente pour déclencher (gap > 100ms
// entre deux touches → buffer remis à zéro).

import { useEffect, useRef } from 'react'

const MAX_GAP_MS = 100
const MIN_LENGTH = 6

export function useBarcodeScanner(onScan: (code: string) => void): void {
    const cb = useRef(onScan)
    cb.current = onScan

    useEffect(() => {
        let buffer = ''
        let lastKey = 0

        function onKeyDown(e: KeyboardEvent): void {
            const target = e.target as HTMLElement | null
            if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return

            const now = Date.now()
            if (now - lastKey > MAX_GAP_MS) buffer = ''
            lastKey = now

            if (e.key === 'Enter') {
                if (buffer.length >= MIN_LENGTH) cb.current(buffer)
                buffer = ''
            } else if (e.key.length === 1) {
                buffer += e.key
            }
        }

        window.addEventListener('keydown', onKeyDown)
        return () => window.removeEventListener('keydown', onKeyDown)
    }, [])
}
