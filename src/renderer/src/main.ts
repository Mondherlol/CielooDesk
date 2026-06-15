import './styles/style.css'

const form = document.getElementById('setup-form') as HTMLFormElement
const input = document.getElementById('instance-input') as HTMLInputElement
const hint = document.getElementById('field-hint') as HTMLParagraphElement
const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement
const btnLabel = document.getElementById('btn-label') as HTMLSpanElement
const btnArrow = document.getElementById('btn-arrow') as HTMLSpanElement
const btnSpinner = document.getElementById('btn-spinner') as HTMLSpanElement
const fieldInner = input.closest('.field-inner') as HTMLDivElement
const fieldSuffix = document.getElementById('field-suffix') as HTMLSpanElement
const fieldLabel = document.getElementById('field-label') as HTMLLabelElement
const setupSub = document.getElementById('setup-sub') as HTMLParagraphElement
const setupFooter = document.getElementById('setup-footer') as HTMLParagraphElement

let isFreeInstance = false

function setLoading(loading: boolean): void {
    submitBtn.disabled = loading
    if (loading) {
        btnLabel.textContent = 'Connexion en cours…'
        btnArrow.classList.add('hidden')
        btnSpinner.classList.remove('hidden')
    } else {
        btnLabel.textContent = 'Démarrer la caisse'
        btnArrow.classList.remove('hidden')
        btnSpinner.classList.add('hidden')
    }
}

function setError(msg: string): void {
    hint.textContent = msg
    fieldInner.classList.add('has-error')
}

function clearError(): void {
    if (fieldInner.classList.contains('has-info')) {
        fieldInner.classList.remove('has-info')
    }
    hint.textContent = ''
    fieldInner.classList.remove('has-error')
}

function setDetectedInfo(source: 'clipboard' | 'exe'): void {
    const suffix = source === 'clipboard'
        ? 'depuis votre presse-papiers.'
        : 'depuis le nom de l\'executable.'
    hint.textContent = `Instance detectee automatiquement ${suffix}`
    fieldInner.classList.add('has-info')
}

async function prefillInstance(): Promise<void> {
    const suggestion = await window.cieloo.config.getBootstrapInstance()
    if (!suggestion) return

    input.value = suggestion.instance
    setDetectedInfo(suggestion.source)
}

input.addEventListener('input', () => {
    const pos = input.selectionStart
    input.value = input.value.toLowerCase()
    input.setSelectionRange(pos, pos)
    clearError()
})

form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()

    const raw = input.value.trim()

    if (!raw) {
        setError(isFreeInstance ? 'Veuillez saisir une URL.' : 'Veuillez saisir un nom d\'instance.')
        input.focus()
        return
    }

    if (isFreeInstance) {
        try { new URL(raw) } catch {
            setError('URL invalide. Exemple : http://localhost:3000')
            input.focus()
            return
        }
    } else {
        // Only allow lowercase letters, numbers and hyphens
        if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(raw) && !/^[a-z0-9]$/.test(raw)) {
            setError('Caractères autorisés : lettres minuscules, chiffres, tirets.')
            input.focus()
            return
        }
    }

    setLoading(true)

    try {
        await window.cieloo.config.saveInstance(raw)
        // The main process will loadURL — no need to do anything else
    } catch {
        setLoading(false)
        setError('Impossible d\'enregistrer la configuration. Réessayez.')
    }
})

// Auto-focus
input.focus()

void window.cieloo.config.get().then(config => {
    if (!config.freeInstance) return
    isFreeInstance = true
    fieldSuffix.style.display = 'none'
    fieldLabel.textContent = 'URL de l\'instance'
    input.placeholder = 'http://localhost:3000'
    setupSub.textContent = 'Entrez l\'URL complète de votre instance pour démarrer.'
    setupFooter.style.display = 'none'
}).catch(() => { /* garder l'UI par défaut */ })

void prefillInstance().catch(() => {
    // Non-blocking: manual entry remains available if auto-detection fails.
})
