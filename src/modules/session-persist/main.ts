// ─────────────────────────────────────────────────────────────────────────────
// Persistance de la session Dolibarr entre les relances de l'app.
//
// Le cookie de session PHP (DOLSESSID_*) n'a PAS de date d'expiration : c'est
// un « session cookie » que Chromium supprime à la fermeture de l'application
// — d'où l'écran de connexion à chaque relance. Ici, dès qu'un cookie de
// session est posé, on le réécrit à l'identique avec une expiration lointaine :
// Chromium le stocke alors sur disque et le renvoie au prochain démarrage.
//
// NB : la réécriture déclenche un nouvel événement 'changed', mais le cookie
// réécrit n'est plus `session` → pas de boucle.
// ─────────────────────────────────────────────────────────────────────────────

import { app, session, type Cookie } from 'electron'

const PERSIST_DAYS = 14

async function persistCookie(cookie: Cookie): Promise<void> {
    const host = (cookie.domain ?? '').replace(/^\./, '')
    if (!host) return
    const url = `${cookie.secure ? 'https' : 'http'}://${host}${cookie.path ?? '/'}`
    // Un cookie host-only (domaine sans point initial) doit être re-posé SANS
    // le champ domain, sinon Chromium le transforme en cookie de domaine.
    const isHostOnly = !(cookie.domain ?? '').startsWith('.')
    try {
        await session.defaultSession.cookies.set({
            url,
            name: cookie.name,
            value: cookie.value,
            ...(isHostOnly ? {} : { domain: cookie.domain }),
            path: cookie.path,
            secure: cookie.secure,
            httpOnly: cookie.httpOnly,
            sameSite: cookie.sameSite,
            expirationDate: Date.now() / 1000 + PERSIST_DAYS * 86_400,
        })
    } catch (err) {
        console.warn('[session-persist] cookie non persistable', cookie.name, (err as Error).message)
    }
}

/** À appeler une fois au démarrage, avant la création de la fenêtre principale. */
export function startSessionCookiePersistence(): void {
    session.defaultSession.cookies.on('changed', (_e, cookie, _cause, removed) => {
        if (removed || !cookie.session) return
        void persistCookie(cookie)
    })

    // Sécurité : force l'écriture disque des cookies avant de quitter (le flush
    // périodique de Chromium peut ne pas avoir tourné sur une fermeture rapide).
    app.on('before-quit', () => {
        void session.defaultSession.cookies.flushStore()
    })
}
