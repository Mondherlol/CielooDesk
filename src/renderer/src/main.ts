import './styles/style.css'

const form = document.getElementById('setup-form') as HTMLFormElement
const input = document.getElementById('instance-input') as HTMLInputElement
const hint = document.getElementById('field-hint') as HTMLParagraphElement
const submitBtn = document.getElementById('submit-btn') as HTMLButtonElement
const btnLabel = document.getElementById('btn-label') as HTMLSpanElement
const btnArrow = document.getElementById('btn-arrow') as HTMLSpanElement
const btnSpinner = document.getElementById('btn-spinner') as HTMLSpanElement
const fieldInner = input.closest('.field-inner') as HTMLDivElement

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

input.addEventListener('input', clearError)

form.addEventListener('submit', async (e) => {
    e.preventDefault()
    clearError()

    const raw = input.value.trim()

    if (!raw) {
        setError('Veuillez saisir un nom d\'instance.')
        input.focus()
        return
    }

    // Only allow lowercase letters, numbers and hyphens
    if (!/^[a-z0-9][a-z0-9-]*[a-z0-9]$/.test(raw) && !/^[a-z0-9]$/.test(raw)) {
        setError('Caractères autorisés : lettres minuscules, chiffres, tirets.')
        input.focus()
        return
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

void prefillInstance().catch(() => {
    // Non-blocking: manual entry remains available if auto-detection fails.
})
