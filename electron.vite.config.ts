import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'
import { loadEnv } from 'vite'

export default defineConfig(({ mode }) => {
    const env = loadEnv(mode, process.cwd(), '')
    return {
    main: {
        plugins: [externalizeDepsPlugin()],
        define: {
            'process.env.DASHBOARD_API_URL': JSON.stringify(env.DASHBOARD_API_URL || 'http://102.204.206.120'),
            'process.env.TERMINAL_API_KEY': JSON.stringify(env.TERMINAL_API_KEY || ''),
            'process.env.RUSTDESK_SERVER': JSON.stringify(env.RUSTDESK_SERVER || '102.204.206.120'),
            'process.env.RUSTDESK_KEY': JSON.stringify(env.RUSTDESK_KEY || ''),
            'process.env.RUSTDESK_CONFIG': JSON.stringify(env.RUSTDESK_CONFIG || ''),
            // URL (ou chemin local) du pack de la caisse locale (PHP+MariaDB+Dolibarr).
            'process.env.LOCAL_PACK_URL': JSON.stringify(env.LOCAL_PACK_URL || ''),
        }
    },
    preload: {
        plugins: [externalizeDepsPlugin()]
    },
    renderer: {
        publicDir: resolve('assets/img'),
        build: {
            rollupOptions: {
                input: {
                    // Setup screen (instance configuration)
                    main: resolve('src/renderer/index.html'),
                    // Settings window
                    settings: resolve('src/renderer/settings.html'),
                    // Print settings window (POS / cash register printers)
                    printSettings: resolve('src/renderer/print-settings.html'),
                    // Barcode printers settings window (label + A4 sheet)
                    barcodeSettings: resolve('src/renderer/barcode-settings.html'),
                    // Balance (Dibal / LinéoSoft) settings window
                    balanceSettings: resolve('src/renderer/balance-settings.html'),
                    // Second display settings window
                    secondDisplaySettings: resolve('src/renderer/second-display-settings.html'),
                    // Offline fallback page (shown when network fails during navigation)
                    offline: resolve('src/renderer/offline.html'),
                    // Generic error page (message / cause / code)
                    error: resolve('src/renderer/error.html'),
                    // Support contact page
                    contact: resolve('src/renderer/contact.html'),
                    // URL editor (Dev menu)
                    urlEditor: resolve('src/renderer/url-editor.html'),
                    // Local cash register config (loading screen mode)
                    localConfig: resolve('src/renderer/local-config.html'),
                    // Local cash register server status window
                    localStatus: resolve('src/renderer/local-status.html')
                }
            }
        }
    }
    }
})
