import { useRef } from 'react'

interface Props {
    value: string
    onChange: (v: string) => void
    onSubmit: (v: string) => void // Entrée : tentative de correspondance code-barres exacte
}

export default function SearchBar({ value, onChange, onSubmit }: Props) {
    const inputRef = useRef<HTMLInputElement>(null)

    return (
        <div className="searchbar">
            <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                <path d="M3 5v14" /><path d="M7 5v14" /><path d="M11 5v14" /><path d="M15 5v14" /><path d="M19 5v14" strokeWidth="2.6" />
            </svg>
            <input
                ref={inputRef}
                type="text"
                placeholder="Rechercher"
                value={value}
                onChange={(e) => onChange(e.target.value)}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') onSubmit(value)
                    if (e.key === 'Escape') onChange('')
                }}
            />
            {value && (
                <button
                    className="searchbar-clear"
                    onClick={() => {
                        onChange('')
                        inputRef.current?.focus()
                    }}
                >
                    ×
                </button>
            )}
        </div>
    )
}
