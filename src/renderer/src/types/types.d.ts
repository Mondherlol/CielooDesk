export { }

import type { AppSettings, ShortcutMap, PrintSettings } from '../../../modules/settings/main'
import type { PrintServerStatus } from '../../../modules/print-server/main'

declare global {
    interface Window {
        cieloo: {
            config: {
                get: () => Promise<{ instance?: string }>
<<<<<<< HEAD
                getBootstrapInstance: () => Promise<{ instance: string; source: 'clipboard' | 'exe' } | null>
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
                saveInstance: (instance: string) => Promise<void>
                clear: () => Promise<void>
            }
            autoLogin: {
                hasCredentials: () => Promise<boolean>
                getCredentials: () => Promise<{ username: string; password: string } | null>
                saveCredentials: (username: string, password: string) => Promise<void>
                clearCredentials: () => Promise<void>
            }
            settings: {
                get: () => Promise<AppSettings>
                set: (key: string, value: boolean | string) => Promise<AppSettings>
                setShortcuts: (shortcuts: ShortcutMap) => Promise<AppSettings>
                resetShortcuts: () => Promise<AppSettings>
                open: () => Promise<void>
            }
            print: {
                getPrinters: () => Promise<Array<{ name: string; isDefault: boolean }>>
                getConfig: () => Promise<PrintSettings>
                getStatus: () => Promise<PrintServerStatus>
                saveConfig: (print: Partial<PrintSettings>) => Promise<{ config: PrintSettings; status: PrintServerStatus }>
            }
            nav: {
                goBack: () => Promise<void>
                goForward: () => Promise<void>
                canGoBack: () => Promise<boolean>
                canGoForward: () => Promise<boolean>
            }
            net: {
                reloadLast: () => Promise<void>
                check: () => Promise<boolean>
            }
<<<<<<< HEAD
            app: {
                version: () => Promise<string>
            }
=======
>>>>>>> 2ebdac883576851199e5d6fb221c8ae7350462be
        }
    }
}
