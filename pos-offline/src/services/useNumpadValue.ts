import { useState } from 'react'

/**
 * Valeur éditée par un Numpad, avec écrasement de la valeur pré-remplie :
 * tant qu'aucune touche n'a été pressée depuis l'ouverture (pristine), le
 * PREMIER chiffre remplace entièrement l'affichage au lieu de s'y ajouter
 * (sinon "25" + touche "1" donnerait "251" au lieu de "1").
 */
export interface NumpadValue {
    value: string
    onKey: (key: string) => void
    /** Fixe la valeur directement (boutons +/-) — sort du mode "pristine". */
    setDirect: (value: string) => void
}

export function useNumpadValue(initial: string): NumpadValue {
    const [value, setValue] = useState(initial)
    const [pristine, setPristine] = useState(true)

    function onKey(key: string): void {
        if (key === '⌫') {
            if (pristine) setValue('')
            else setValue((v) => v.slice(0, -1))
            setPristine(false)
            return
        }
        if (key === '.') {
            if (pristine) { setValue('0.'); setPristine(false); return }
            setValue((v) => (v.includes('.') ? v : v + '.'))
            return
        }
        if (pristine) {
            setValue(key)
            setPristine(false)
            return
        }
        setValue((v) => (v === '0' ? key : v + key))
    }

    function setDirect(v: string): void {
        setValue(v)
        setPristine(false)
    }

    return { value, onKey, setDirect }
}
