
export { }

import type { AppSettings, ShortcutMap, PrintSettings, PrinterConfig, CustomerDisplaySettings } from '../../../modules/settings/main'
import type { PrintServerStatus } from '../../../modules/print-server/main'

export type MultiprintSection = {
    rowid: number
    label: string
    position: number
    is_caisse: boolean
    fk_template: string | null
}

declare global {
    interface Window {
        cieloo: {
            config: {
                get: () => Promise<{ instance?: string; freeInstance?: boolean }>
                getBootstrapInstance: () => Promise<{ instance: string; source: 'clipboard' | 'exe' } | null>
                saveInstance: (instance: string) => Promise<void>
                toggleFreeInstance: () => Promise<boolean>
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
            secondDisplay: {
                openSettings: () => Promise<void>
                openEditor: () => Promise<void>
                selectMediaFolder: () => Promise<string | null>
                clearMediaFolder: () => Promise<void>
            }
            customerDisplay: {
                listPorts: () => Promise<Array<{ path: string; label: string }>>
                getConfig: () => Promise<CustomerDisplaySettings>
                saveConfig: (config: Partial<CustomerDisplaySettings>) => Promise<CustomerDisplaySettings>
                send: (line1: string, line2: string, override?: Partial<CustomerDisplaySettings>) => Promise<{ success: boolean; message?: string }>
            }
            print: {
                getPrinters: () => Promise<Array<{ name: string; isDefault: boolean }>>
                getConfig: () => Promise<PrintSettings>
                getStatus: () => Promise<PrintServerStatus>
                saveConfig: (print: Partial<PrintSettings>) => Promise<{ config: PrintSettings; status: PrintServerStatus }>
                printerCheck: () => Promise<{ configured: boolean; connected: boolean }>
                printTest: (config: PrinterConfig) => Promise<{ success: boolean; message?: string }>
                printBarcodeTest: (config: PrinterConfig, mode: 'label' | 'sheet') => Promise<{ success: boolean; message?: string }>
                openPrinterProperties: (printerName: string) => Promise<void>
                openPrinterOptions: (printerName: string) => Promise<void>
                installDriver: () => Promise<{ launched: boolean; reason?: string }>
                downloadDriver: (url: string) => Promise<{ launched: boolean; reason?: string }>
                openSettings: () => Promise<void>
                openBarcodeSettings: () => Promise<void>
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
            app: {
                version: () => Promise<string>
                isDev: () => Promise<boolean>
            }
            dev: {
                copyText: (text: string) => Promise<void>
                navigate: (url: string) => Promise<void>
                closeUrlEditor: () => Promise<void>
                onSetUrl: (cb: (url: string) => void) => void
            }
            device: {
                getNetworkInfo: () => Promise<{ mac: string; ip: string }>
            }
            multiprint: {
                getSections: () => Promise<{ sections: MultiprintSection[] | null; error?: string }>
            }
        }
    }
}
