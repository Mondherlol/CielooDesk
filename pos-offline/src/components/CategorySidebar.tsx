import type { Category } from '../types'

interface Props {
    categories: Category[]
    selected: number | null // null = toutes
    onSelect: (id: number | null) => void
    counts: Map<number, number>
    images: Record<string, string> // id catégorie → URL file:// de la vignette
    hideImages: boolean // admin/appearance.php : TAKEPOS_HIDE_CATEGORY_IMAGES
    showCount: boolean  // admin/appearance.php : CIELOOPOS_SHOW_CAT_PRODUCT_COUNT
}

export default function CategorySidebar({ categories, selected, onSelect, counts, images, hideImages, showCount }: Props) {
    return (
        <nav className="sidebar">
            <button
                className={selected === null ? 'cat-all cat-all-active' : 'cat-all'}
                onClick={() => onSelect(null)}
            >
                <span className="cat-all-icon">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                        <rect x="3" y="3" width="7" height="7" rx="1" /><rect x="14" y="3" width="7" height="7" rx="1" />
                        <rect x="3" y="14" width="7" height="7" rx="1" /><rect x="14" y="14" width="7" height="7" rx="1" />
                    </svg>
                </span>
                Toutes catégories
            </button>

            {categories.map((c) => (
                <button
                    key={c.id}
                    className={selected === c.id ? 'cat-item cat-item-active' : 'cat-item'}
                    onClick={() => onSelect(c.id)}
                >
                    <span className="cat-item-icon" style={{ background: `${c.color}1f`, color: c.color }}>
                        {!hideImages && images[String(c.id)]
                            ? <img src={images[String(c.id)]} alt="" draggable={false} />
                            : c.label.charAt(0).toUpperCase()}
                    </span>
                    <span className="cat-item-label">{c.label}</span>
                    {showCount && <span className="cat-item-count">{counts.get(c.id) ?? 0}</span>}
                </button>
            ))}
        </nav>
    )
}
