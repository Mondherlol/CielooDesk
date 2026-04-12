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
<<<<<<< HEAD
        publicDir: resolve('assets/img'),
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
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
<<<<<<< HEAD
                    offline: resolve('src/renderer/offline.html'),
                    // Support contact page
                    contact: resolve('src/renderer/contact.html')
=======
                    offline: resolve('src/renderer/offline.html')
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
                }
            }
        }
    }
})
