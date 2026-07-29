// Pont exposé par le shell hôte (preload Electron aujourd'hui, WebView React
// Native demain). Absent en dev navigateur → la SPA retombe sur la fixture.

export {}

declare global {
    interface Window {
        cielooOffline?: {
            getSnapshot: () => Promise<unknown | null>
            getSnapshotMeta: () => Promise<unknown | null>
            getContext?: () => Promise<{ terminalName?: string | null; offlineSince?: number | null } | null>
            getImages?: () => Promise<{ products: Record<string, string>; categories: Record<string, string> } | null>
            refreshSnapshot: () => Promise<{ ok: boolean; error?: string }>
            returnOnline: () => Promise<void>
            saveSale?: (sale: unknown) => Promise<{ ok: boolean; ref?: string; error?: string }>
            listSales?: () => Promise<unknown[]>
            syncSale?: (uuid: string) => Promise<{ ok: boolean; ref?: string; error?: string }>
            printReceipt?: (html: string) => Promise<{ ok: boolean; error?: string }>
            saveCustomer?: (input: { name: string; phone: string; email: string }) => Promise<{ ok: boolean; customer?: unknown; error?: string }>
            listCustomers?: () => Promise<unknown[]>
        }
    }
}
