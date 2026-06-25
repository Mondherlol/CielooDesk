const style = document.createElement('style')
style.textContent = `
  :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
  html, body { overflow: hidden; }
  body { margin: 0; background: #f8fafc; color: #1f2937; }
  .ue-shell { display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; box-sizing: border-box; }
  .ue-label { font-size: .8rem; font-weight: 600; color: #6b7280; }
  .ue-input {
    width: 100%; box-sizing: border-box; padding: 9px 11px;
    border: 1.5px solid #d1d5db; border-radius: 8px;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: .85rem; color: #111827; background: #fff; outline: none;
    transition: border-color .15s;
  }
  .ue-input:focus { border-color: #3b82f6; }
  .ue-actions { display: flex; gap: 8px; margin-top: 4px; }
  .ue-btn {
    padding: 8px 14px; border-radius: 8px; font-size: .85rem; font-weight: 600;
    cursor: pointer; border: 1.5px solid transparent; font-family: inherit;
  }
  .ue-btn-primary { background: #3b82f6; color: #fff; }
  .ue-btn-primary:hover { background: #2563eb; }
  .ue-btn-default { background: #fff; border-color: #d1d5db; color: #374151; }
  .ue-btn-default:hover { background: #f3f4f6; }
  .ue-btn-ghost { background: transparent; color: #6b7280; margin-left: auto; }
  .ue-btn-ghost:hover { color: #111827; }
  .ue-toast {
    font-size: .8rem; color: #059669; height: 1em; opacity: 0;
    transition: opacity .2s;
  }
  .ue-toast.visible { opacity: 1; }
`
document.head.appendChild(style)

const input = document.getElementById('ue-input') as HTMLInputElement
const toastEl = document.getElementById('ue-toast') as HTMLDivElement

function toast(msg: string): void {
    toastEl.textContent = msg
    toastEl.classList.add('visible')
    setTimeout(() => toastEl.classList.remove('visible'), 1600)
}

// URL initiale passée en query (?url=...) + mise à jour si la fenêtre est réutilisée.
const initialUrl = new URLSearchParams(window.location.search).get('url') ?? ''
input.value = initialUrl
window.cieloo.dev.onSetUrl((url) => { input.value = url })

input.focus()
input.select()

document.getElementById('ue-copy')?.addEventListener('click', async () => {
    await window.cieloo.dev.copyText(input.value)
    toast('URL copiée')
})

document.getElementById('ue-go')?.addEventListener('click', async () => {
    const url = input.value.trim()
    if (url) await window.cieloo.dev.navigate(url)
})

document.getElementById('ue-close')?.addEventListener('click', () => {
    void window.cieloo.dev.closeUrlEditor()
})

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('ue-go')?.dispatchEvent(new MouseEvent('click'))
    if (e.key === 'Escape') document.getElementById('ue-close')?.dispatchEvent(new MouseEvent('click'))
})
