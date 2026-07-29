import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// base './' : le bundle doit marcher chargé en file:// (Electron) ou depuis les
// assets Android (WebView RN), pas seulement depuis la racine d'un serveur.
export default defineConfig({
    plugins: [react()],
    base: './',
    server: { port: 5174 },
    build: { outDir: 'dist' },
})
