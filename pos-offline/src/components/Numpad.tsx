interface Props {
    onKey: (key: string) => void // '0'-'9', '.', '⌫'
}

const KEYS = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '.', '0', '⌫']

/** Pavé numérique tactile — purement présentationnel, la composition de la
 *  valeur (écrasement de la valeur pré-remplie au premier chiffre, etc.) est
 *  gérée par l'appelant via useNumpadValue(). */
export default function Numpad({ onKey }: Props) {
    return (
        <div className="numpad">
            {KEYS.map((k) => (
                <button
                    key={k}
                    type="button"
                    className={k === '⌫' ? 'numpad-key numpad-key-back' : 'numpad-key'}
                    onClick={() => onKey(k)}
                >
                    {k}
                </button>
            ))}
        </div>
    )
}
