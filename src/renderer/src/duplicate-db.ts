const style = document.createElement('style')
style.textContent = `
  :root { font-family: Inter, ui-sans-serif, system-ui, -apple-system, sans-serif; }
  html, body { overflow: hidden; }
  body { margin: 0; background: #f8fafc; color: #1f2937; }
  .dd-shell { display: flex; flex-direction: column; gap: 10px; padding: 18px 20px; box-sizing: border-box; }
  .dd-label { font-size: .8rem; font-weight: 600; color: #6b7280; }
  .dd-input {
    width: 100%; box-sizing: border-box; padding: 9px 11px;
    border: 1.5px solid #d1d5db; border-radius: 8px;
    font-family: ui-monospace, "Cascadia Mono", Consolas, monospace;
    font-size: .85rem; color: #111827; background: #fff; outline: none;
    transition: border-color .15s;
  }
  .dd-input:focus { border-color: #3b82f6; }
  .dd-hint { font-size: .78rem; color: #9ca3af; line-height: 1.4; }
  .dd-actions { display: flex; gap: 8px; margin-top: 6px; justify-content: flex-end; }
  .dd-btn {
    padding: 8px 14px; border-radius: 8px; font-size: .85rem; font-weight: 600;
    cursor: pointer; border: 1.5px solid transparent; font-family: inherit;
  }
  .dd-btn-primary { background: #3b82f6; color: #fff; }
  .dd-btn-primary:hover { background: #2563eb; }
  .dd-btn-ghost { background: transparent; color: #6b7280; }
  .dd-btn-ghost:hover { color: #111827; }
`
document.head.appendChild(style)

const input = document.getElementById('dd-input') as HTMLInputElement

input.focus()

function submit(): void {
    const instance = input.value.trim()
    if (!instance) { input.focus(); return }
    void window.cieloo.dev.duplicateDbSubmit(instance)
}

function cancel(): void {
    void window.cieloo.dev.duplicateDbCancel()
}

document.getElementById('dd-go')?.addEventListener('click', submit)
document.getElementById('dd-cancel')?.addEventListener('click', cancel)

input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') submit()
    if (e.key === 'Escape') cancel()
})

export {}   // fait de ce fichier un module (scope isolé, pas de collision globale)
