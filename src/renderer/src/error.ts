// Page d'erreur générique : affiche titre / message / cause / code d'erreur.
// Les données arrivent en paramètres d'URL (posés par le process principal).

/// <reference path="./types/types.d.ts" />

export {}

const p = new URLSearchParams(location.search)

const titleEl = document.getElementById('title')!
const msgEl = document.getElementById('message')!
const codeEl = document.getElementById('code')!
const detailEl = document.getElementById('detail')!
const retryBtn = document.getElementById('btn-retry') as HTMLButtonElement
const copyBtn = document.getElementById('btn-copy') as HTMLButtonElement

const title = p.get('title') || 'Une erreur est survenue'
const message = p.get('message') || 'La caisse a rencontré un problème inattendu.'
const detail = p.get('detail') || ''
const code = p.get('code') || ''

titleEl.textContent = title
msgEl.textContent = message
if (code) { codeEl.textContent = `Code : ${code}`; codeEl.classList.add('show') }
if (detail) { detailEl.textContent = detail; detailEl.classList.add('show') }
else { copyBtn.style.display = 'none' }

retryBtn.addEventListener('click', () => {
    retryBtn.disabled = true
    retryBtn.textContent = 'Reconnexion…'
    void window.cieloo.errorPage.retry()
})

copyBtn.addEventListener('click', () => {
    const text = [title, message, code ? `Code: ${code}` : '', detail].filter(Boolean).join('\n')
    void window.cieloo.errorPage.copy(text)
    copyBtn.textContent = 'Copié ✓'
    setTimeout(() => { copyBtn.textContent = 'Copier le détail' }, 1500)
})
