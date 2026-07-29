import { useEffect } from 'react'

interface Props {
    html: string // document complet du ticket (même rendu que l'impression)
    saleRef: string
    onPrint: () => void
    onClose: () => void
}

export default function ReceiptModal({ html, saleRef, onPrint, onClose }: Props) {
    useEffect(() => {
        const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])

    return (
        <div className="modal-overlay" onClick={onClose}>
            <div className="modal receipt-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-head">
                    <h3>Ticket {saleRef}</h3>
                    <button className="modal-close" onClick={onClose}>×</button>
                </div>

                {/* iframe : CSS du ticket totalement isolée, rendu identique à l'impression */}
                <iframe className="receipt-frame" srcDoc={html} title={`Ticket ${saleRef}`} />

                <div className="receipt-actions">
                    <button className="receipt-print-btn" onClick={onPrint}>
                        <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="6 9 6 2 18 2 18 9" />
                            <path d="M6 18H4a2 2 0 0 1-2-2v-5a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v5a2 2 0 0 1-2 2h-2" />
                            <rect x="6" y="14" width="12" height="8" />
                        </svg>
                        Imprimer
                    </button>
                    <button className="receipt-close-btn" onClick={onClose}>Fermer</button>
                </div>
            </div>
        </div>
    )
}
