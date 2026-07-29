
export { }

import type { AppSettings, ShortcutMap, PrintSettings, PrinterConfig, CustomerDisplaySettings, BalanceSettings, NacefSettings } from '../../../modules/settings/main'
import type { PrintServerStatus } from '../../../modules/print-server/main'
import type { BalanceGenResult, BalancePreview } from '../../../modules/balance/main'
import type { NacefStatus } from '../../../modules/nacef/main'
import type { LocalDebugInfo } from '../../../modules/local-dolibarr/main'

export type MultiprintSection = {
    rowid: number
    label: string
    position: number
    is_caisse: boolean
    fk_template: string | null
}

declare global {
    type LocalDebugInfoUI = LocalDebugInfo & { dbAdminUrl: string | null }
    type LocalPackInfoUI = {
        present: boolean
        version: string | null
        paths: LocalDebugInfo['paths']
        baseUrl: string | null
        dbAdminUrl: string | null
        configuredUrl: string | null
        usingDashboard: boolean
        effectiveUrl: string | null
        cloud: { version: string; size: number } | null
        cloudError: string | null
    }

    interface Window {
        cieloo: {
            config: {
                get: () => Promise<{ instance?: string; freeInstance?: boolean }>
                getBootstrapInstance: () => Promise<{ instance: string; source: 'clipboard' | 'exe' } | null>
                isDemo: () => Promise<boolean>
                setup: (instance: string, mode: 'cloud' | 'local') => Promise<void>
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
            errorPage: {
                retry: () => Promise<void>
                copy: (text: string) => Promise<void>
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
                duplicateDbSubmit: (instance: string) => Promise<void>
                duplicateDbCancel: () => Promise<void>
            }
            device: {
                getNetworkInfo: () => Promise<{ mac: string; ip: string }>
            }
            multiprint: {
                getSections: () => Promise<{ sections: MultiprintSection[] | null; error?: string }>
            }
            balance: {
                getConfig: () => Promise<BalanceSettings>
                saveConfig: (payload: Partial<BalanceSettings>) => Promise<BalanceSettings>
                selectFolder: () => Promise<string | null>
                generateNow: () => Promise<BalanceGenResult>
                preview: () => Promise<BalancePreview>
                getStatus: () => Promise<{ lastWrittenAt?: string; lastCount?: number }>
                openSettings: () => Promise<void>
                onStatusUpdated: (cb: (result: BalanceGenResult) => void) => void
            }
            nacef: {
                getConfig: () => Promise<NacefSettings>
                getStatus: () => Promise<NacefStatus>
                saveConfig: (payload: Partial<NacefSettings>) => Promise<NacefSettings>
            }
            local: {
                getLoaderMode: () => Promise<'prod' | 'dev' | 'debug'>
                setLoaderMode: (mode: 'prod' | 'dev' | 'debug') => Promise<'prod' | 'dev' | 'debug'>
                getDebugInfo: () => Promise<LocalDebugInfoUI>
                getPackInfo: () => Promise<LocalPackInfoUI>
                openExternal: (url: string) => Promise<void>
                openPath: (target: string) => Promise<void>
                copy: (text: string) => Promise<void>
                openDbAdmin: () => Promise<string | null>
                onRefresh: (cb: () => void) => void
            }
        }
    }
}
