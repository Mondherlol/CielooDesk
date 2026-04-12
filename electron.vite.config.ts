import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'

export default defineConfig({
    main: {
        plugins: [externalizeDepsPlugin()]
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
                    // Print settings window
                    printSettings: resolve('src/renderer/print-settings.html'),
                    // Offline fallback page (shown when network fails during navigation)
                    offline: resolve('src/renderer/offline.html'),
                    // Support contact page
                    contact: resolve('src/renderer/contact.html')
                }
            }
        }
    }
})
