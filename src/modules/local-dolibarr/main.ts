// ─────────────────────────────────────────────────────────────────────────────
// Mode caisse LOCAL : fait tourner un Dolibarr/CielooPos en localhost a partir
// d'un "pack" portable (PHP + MariaDB + Dolibarr) telecharge depuis notre serveur.
//
// Aucune install systeme : tout vit dans userData, tout est spawn par Electron.
// Ports choisis dynamiquement (zero conflit) puis persistes. L'install Dolibarr
// utilise install.forced.php (mecanisme officiel integrateur) → champs pre-remplis.
// ─────────────────────────────────────────────────────────────────────────────

import { app, net } from 'electron'
import { spawn, type ChildProcess } from 'node:child_process'
import http from 'node:http'
import netModule from 'node:net'
import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import zlib from 'node:zlib'
import { Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export interface LocalState {
    installed: boolean       // Dolibarr a fini son install (install.lock present)
    packVersion: string | null
    phpPort: number | null
    dbPort: number | null
    dbPassword: string | null
    cloudSeeded?: boolean        // la base a deja ete remplacee par celle du cloud
    cloudWatermark?: string | null  // dernier point de synchro (horloge serveur DB)
}

export interface LocalStatus {
    packPresent: boolean
    running: boolean
    installed: boolean
    url: string | null       // URL a charger dans la fenetre (POS ou wizard /install)
    message: string
}

type ProgressFn = (info: { phase: string; pct?: number; message?: string }) => void

// ─── Chemins ────────────────────────────────────────────────────────────────

function rootDir(): string { return path.join(app.getPath('userData'), 'cieloo-local') }
function runtimeDir(): string { return path.join(rootDir(), 'runtime') }      // pack extrait
function dataDir(): string { return path.join(rootDir(), 'mysql-data') }      // datadir MariaDB
function documentsDir(): string { return path.join(rootDir(), 'documents') } // data_root Dolibarr
function tmpDir(): string { return path.join(rootDir(), 'tmp') }             // sessions/upload php
function statePath(): string { return path.join(rootDir(), 'state.json') }

function phpDir(): string { return path.join(runtimeDir(), 'php') }
function phpExe(): string { return path.join(phpDir(), 'php.exe') }
function mariadbDir(): string { return path.join(runtimeDir(), 'mariadb') }
function mariadbdExe(): string { return path.join(mariadbDir(), 'bin', 'mariadbd.exe') }
function mariadbInstallExe(): string { return path.join(mariadbDir(), 'bin', 'mariadb-install-db.exe') }
function mariadbClientExe(): string { return path.join(mariadbDir(), 'bin', 'mariadb.exe') }
function htdocsDir(): string { return path.join(runtimeDir(), 'dolibarr', 'htdocs') }
function confDir(): string { return path.join(htdocsDir(), 'conf') }
function confPhpPath(): string { return path.join(confDir(), 'conf.php') }
function installLockPath(): string { return path.join(documentsDir(), 'install.lock') }

// ─── Etat persiste ──────────────────────────────────────────────────────────

function readState(): LocalState {
    try {
        const raw = JSON.parse(fs.readFileSync(statePath(), 'utf-8')) as Partial<LocalState>
        return {
            installed: Boolean(raw.installed),
            packVersion: raw.packVersion ?? null,
            phpPort: raw.phpPort ?? null,
            dbPort: raw.dbPort ?? null,
            dbPassword: raw.dbPassword ?? null,
            cloudSeeded: Boolean(raw.cloudSeeded),
            cloudWatermark: raw.cloudWatermark ?? null,
        }
    } catch {
        return { installed: false, packVersion: null, phpPort: null, dbPort: null, dbPassword: null, cloudSeeded: false, cloudWatermark: null }
    }
}

function writeState(patch: Partial<LocalState>): LocalState {
    const next = { ...readState(), ...patch }
    fs.mkdirSync(rootDir(), { recursive: true })
    fs.writeFileSync(statePath(), JSON.stringify(next, null, 2))
    return next
}

// ─── Detection ──────────────────────────────────────────────────────────────

export function isPackPresent(): boolean {
    return fs.existsSync(phpExe()) && fs.existsSync(mariadbdExe()) && fs.existsSync(htdocsDir())
}

export function isInstalled(): boolean {
    return fs.existsSync(installLockPath())
}

// ─── Telechargement + extraction du pack ────────────────────────────────────

const PACK_URL = process.env.LOCAL_PACK_URL ?? ''  // ex: https://dl.cieloo.io/local/cieloo-local-pack-21.0.1.zip

/**
 * Telecharge le pack (si absent) et l'extrait dans runtimeDir.
 * `expectedSha256` (optionnel) verifie l'integrite.
 */
export async function ensurePack(opts: { url?: string; expectedSha256?: string; onProgress?: ProgressFn } = {}): Promise<void> {
    if (isPackPresent()) return
    const url = opts.url ?? PACK_URL
    if (!url) throw new Error('LOCAL_PACK_URL non configure : impossible de telecharger le pack local.')

    fs.mkdirSync(rootDir(), { recursive: true })
    const zipPath = path.join(rootDir(), 'pack-download.zip')

    // Source locale (chemin Windows ou file://) → on copie au lieu de telecharger.
    // Pratique pour tester avec un zip construit par build-local-pack.ps1.
    const localSource = toLocalPath(url)
    if (localSource) {
        if (!fs.existsSync(localSource)) throw new Error(`Pack introuvable : ${localSource}`)
        opts.onProgress?.({ phase: 'download', pct: 50, message: 'Copie du pack local…' })
        await fsp.copyFile(localSource, zipPath)
    } else {
        opts.onProgress?.({ phase: 'download', pct: 0, message: 'Téléchargement du pack…' })
        const startedAt = Date.now()
        await downloadFile(url, zipPath, (received, total) => {
            const pct = total > 0 ? Math.round((received / total) * 100) : undefined
            const elapsed = (Date.now() - startedAt) / 1000
            const speed = elapsed > 0 ? received / elapsed : 0
            const eta = total > 0 && speed > 0 ? Math.round((total - received) / speed) : null
            const msg = total > 0
                ? `Téléchargement du pack… ${fmtMb(received)} / ${fmtMb(total)}${eta !== null ? ` · ~${fmtEta(eta)}` : ''}`
                : `Téléchargement du pack… ${fmtMb(received)}`
            opts.onProgress?.({ phase: 'download', pct, message: msg })
        })
    }

    if (opts.expectedSha256) {
        const got = await sha256(zipPath)
        if (got.toLowerCase() !== opts.expectedSha256.toLowerCase()) {
            await fsp.rm(zipPath, { force: true })
            throw new Error('Empreinte du pack invalide (telechargement corrompu ?).')
        }
    }

    opts.onProgress?.({ phase: 'extract', message: 'Extraction du pack (PHP, MariaDB, Dolibarr)…' })
    if (fs.existsSync(runtimeDir())) await fsp.rm(runtimeDir(), { recursive: true, force: true })
    fs.mkdirSync(runtimeDir(), { recursive: true })
    await extractZip(zipPath, runtimeDir())
    await fsp.rm(zipPath, { force: true })

    // pack.json -> on memorise la version
    try {
        const manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir(), 'pack.json'), 'utf-8'))
        writeState({ packVersion: manifest.dolibarrVersion ?? null })
    } catch { /* manifeste optionnel */ }

    if (!isPackPresent()) throw new Error('Pack extrait mais structure inattendue (php/mariadb/dolibarr manquants).')
    opts.onProgress?.({ phase: 'done', pct: 100, message: 'Pack prêt.' })
}

// Renvoie un chemin de fichier local si `url` est un chemin Windows ou une URL file://, sinon null.
function toLocalPath(url: string): string | null {
    if (/^file:\/\//i.test(url)) {
        try { return decodeURIComponent(new URL(url).pathname.replace(/^\/([A-Za-z]:)/, '$1')) } catch { return null }
    }
    if (/^[A-Za-z]:[\\/]/.test(url) || url.startsWith('\\\\')) return url
    return null
}

function fmtMb(bytes: number): string {
    const mb = bytes / 1048576
    return mb >= 1024 ? `${(mb / 1024).toFixed(2)} Go` : `${mb.toFixed(1)} Mo`
}

function fmtEta(seconds: number): string {
    if (seconds >= 60) return `${Math.floor(seconds / 60)} min ${seconds % 60}s`
    return `${seconds}s`
}

function downloadFile(url: string, dest: string, onBytes?: (received: number, total: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
        const request = net.request(url)
        request.on('response', (response) => {
            if (response.statusCode && response.statusCode >= 300 && response.statusCode < 400 && response.headers.location) {
                const loc = Array.isArray(response.headers.location) ? response.headers.location[0] : response.headers.location
                resolve(downloadFile(loc, dest, onBytes))
                return
            }
            if (response.statusCode !== 200) { reject(new Error(`HTTP ${response.statusCode} sur le pack`)); return }
            const total = Number(response.headers['content-length'] ?? 0)
            let received = 0
            const out = fs.createWriteStream(dest)
            out.on('error', reject)
            response.on('data', (chunk: Buffer) => {
                received += chunk.length
                out.write(chunk)
                onBytes?.(received, total)
            })
            response.on('end', () => out.end(() => resolve()))
            response.on('error', reject)
        })
        request.on('error', reject)
        request.end()
    })
}

async function sha256(file: string): Promise<string> {
    const hash = crypto.createHash('sha256')
    await pipeline(fs.createReadStream(file), hash)
    return hash.digest('hex')
}

// Extraction via tar.exe (bsdtar, integre a Windows 10+ : rapide, gere les chemins
// longs et les milliers de fichiers Dolibarr bien mieux qu'Expand-Archive).
// Fallback PowerShell si tar absent (vieux Windows).
function extractZip(zip: string, dest: string): Promise<void> {
    fs.mkdirSync(dest, { recursive: true })
    const tar = path.join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe')
    if (fs.existsSync(tar)) {
        return new Promise((resolve, reject) => {
            const proc = spawn(tar, ['-xf', zip, '-C', dest], { windowsHide: true })
            let err = ''
            proc.stderr.on('data', (d) => { err += d.toString() })
            proc.on('error', reject)
            proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`tar a echoue (${code}): ${err}`)))
        })
    }
    return new Promise((resolve, reject) => {
        const ps = spawn('powershell.exe', [
            '-NoProfile', '-NonInteractive', '-Command',
            `Expand-Archive -LiteralPath '${zip.replace(/'/g, "''")}' -DestinationPath '${dest.replace(/'/g, "''")}' -Force`,
        ], { windowsHide: true })
        let err = ''
        ps.stderr.on('data', (d) => { err += d.toString() })
        ps.on('error', reject)
        ps.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Expand-Archive a echoue (${code}): ${err}`)))
    })
}

// ─── Ports ──────────────────────────────────────────────────────────────────

function isPortFree(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const srv = netModule.createServer()
        srv.once('error', () => resolve(false))
        srv.once('listening', () => srv.close(() => resolve(true)))
        srv.listen(port, '127.0.0.1')
    })
}

async function pickPort(preferred: number | null, fallbackStart: number): Promise<number> {
    if (preferred && await isPortFree(preferred)) return preferred
    for (let p = fallbackStart; p < fallbackStart + 200; p++) {
        if (await isPortFree(p)) return p
    }
    throw new Error('Aucun port libre trouve pour le mode local.')
}

// ─── Processus ──────────────────────────────────────────────────────────────

let mariadbProc: ChildProcess | null = null
let phpProc: ChildProcess | null = null
let currentUrl: string | null = null

// ─── Chemins Windows dans Dolibarr : antislashs → slashs avant ───────────────
//
// CAUSE RACINE. L'installeur Dolibarr detecte le document_root via
// dirname(dirname($_SERVER["SCRIPT_FILENAME"])) → un chemin a ANTISLASHS sous
// Windows, qu'il ecrit dans conf.php entre GUILLEMETS DOUBLES :
//     $dolibarr_main_document_root="C:\…\runtime\dolibarr\htdocs";
// PHP interprete alors les sequences d'echappement : \r (de \runtime) devient un
// retour-chariot, \t un tabulateur… → le chemin est casse, l'include du noyau
// echoue et l'etape « Fichier de configuration » meurt sans bouton « Suivant »
// (et la prerequisite « document_root … that seems wrong »).
//
// CORRECTION PRINCIPALE : patcher detect_dolibarr_main_document_root() dans
// install/inc.php pour qu'il renvoie des SLASHS AVANT (valides sous Windows, sans
// echappement). Comme le document_root est ecrit ET relu dans la meme requete,
// corriger conf.php apres coup (sanitizeConfPhp / watcher) ne suffit pas : la
// valeur fautive est deja chargee en memoire. Le patch agit a la source.

/**
 * Patche install/inc.php : detect_dolibarr_main_document_root() renvoie des
 * slashs avant. Idempotent. A relancer a chaque demarrage (un re-telechargement
 * du pack ecraserait le patch). Renvoie true si le fichier a ete modifie.
 */
export function patchDolibarrInstallPaths(): boolean {
    const file = path.join(htdocsDir(), 'install', 'inc.php')
    let content: string
    try { content = fs.readFileSync(file, 'utf-8') } catch { return false }
    const anchor = 'return $dolibarr_main_document_root;'
    const replacement = 'return str_replace(chr(92), "/", $dolibarr_main_document_root);'
    if (content.includes(replacement)) return false       // deja patche
    // Cible uniquement le return de detect_dolibarr_main_document_root, repere via
    // l'assignation qui le precede dans cette fonction.
    const ctx = '$dolibarr_main_document_root = dirname(dirname($_SERVER["SCRIPT_FILENAME"]));'
    const ctxIdx = content.indexOf(ctx)
    if (ctxIdx < 0) return false
    const retIdx = content.indexOf(anchor, ctxIdx)
    if (retIdx < 0) return false
    const fixed = content.slice(0, retIdx) + replacement + content.slice(retIdx + anchor.length)
    try { fs.writeFileSync(file, fixed); return true } catch { return false }
}

/** Corrige conf.php (document_root en slashs avant). Renvoie true si modifie. */
export function sanitizeConfPhp(): boolean {
    const file = confPhpPath()
    let content: string
    try { content = fs.readFileSync(file, 'utf-8') } catch { return false }
    const fixed = content.replace(
        /(\$dolibarr_main_document_root(?:_alt)?\s*=\s*")([^"]*)(")/g,
        (_m: string, p1: string, val: string, p3: string) => p1 + val.replace(/\\/g, '/') + p3,
    )
    if (fixed === content) return false
    try { fs.writeFileSync(file, fixed); return true } catch { return false }
}

// Surveille conf.php pendant le mode local : l'installeur le (re)ecrit au fil des
// etapes du wizard ; on le corrige aussitot pour que l'install puisse aboutir.
let confWatcher: fs.FSWatcher | null = null
let confSanitizeTimer: NodeJS.Timeout | null = null

function startConfWatcher(): void {
    stopConfWatcher()
    try {
        confWatcher = fs.watch(confDir(), (_evt, filename) => {
            if (!filename || String(filename).toLowerCase() !== 'conf.php') return
            // Debounce : laisser l'ecriture se terminer avant de relire/reecrire.
            if (confSanitizeTimer) clearTimeout(confSanitizeTimer)
            confSanitizeTimer = setTimeout(() => { try { sanitizeConfPhp() } catch { /* */ } }, 40)
        })
    } catch { /* le dossier conf existe dans le pack ; en cas d'echec on ignore */ }
}

function stopConfWatcher(): void {
    if (confSanitizeTimer) { clearTimeout(confSanitizeTimer); confSanitizeTimer = null }
    if (confWatcher) { try { confWatcher.close() } catch { /* */ } confWatcher = null }
}

function logFile(name: string): fs.WriteStream {
    fs.mkdirSync(rootDir(), { recursive: true })
    return fs.createWriteStream(path.join(rootDir(), name), { flags: 'a' })
}

async function startMariadb(port: number, rootPassword: string): Promise<void> {
    const freshInstall = !fs.existsSync(path.join(dataDir(), 'mysql'))
    fs.mkdirSync(dataDir(), { recursive: true })

    if (freshInstall) {
        // Initialise un datadir vierge. Sur Windows, mariadb-install-db.exe pose
        // directement le mot de passe root via --password (PAS --auth-root-* qui
        // est une option Linux). Les comptes root@localhost / root@127.0.0.1 sont
        // crees par defaut avec ce mot de passe.
        await runToCompletion(mariadbInstallExe(), [
            `--datadir=${dataDir()}`,
            `--password=${rootPassword}`,
            `--port=${port}`,
        ], 'mariadb-install.log')
    }

    const log = logFile('mariadbd.log')
    mariadbProc = spawn(mariadbdExe(), [
        '--no-defaults',
        `--datadir=${dataDir()}`,
        `--port=${port}`,
        '--bind-address=127.0.0.1',
        '--skip-name-resolve',
    ], { cwd: mariadbDir(), windowsHide: true })
    mariadbProc.stdout?.pipe(log)
    mariadbProc.stderr?.pipe(log)
    mariadbProc.on('exit', () => { mariadbProc = null })

    await waitForDb(port)

    // Prepare la base + l'utilisateur applicatif pour l'hote 127.0.0.1 (cf. note sur
    // provisionDatabase). Indispensable avant l'install Dolibarr (createuser=false).
    await provisionDatabase(port, rootPassword)
}

function waitForDb(port: number, timeoutMs = 30_000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            const sock = netModule.connect({ host: '127.0.0.1', port }, () => { sock.destroy(); resolve() })
            sock.on('error', () => {
                sock.destroy()
                if (Date.now() - start > timeoutMs) reject(new Error('MariaDB ne demarre pas (timeout).'))
                else setTimeout(tick, 400)
            })
        }
        tick()
    })
}

function runSql(port: number, password: string, statements: string[]): Promise<void> {
    const args = ['-h', '127.0.0.1', '-P', String(port), '-u', 'root']
    if (password) args.push(`-p${password}`)
    return new Promise((resolve, reject) => {
        const proc = spawn(mariadbClientExe(), args, { windowsHide: true })
        let err = ''
        proc.stderr.on('data', (d) => { err += d.toString() })
        proc.on('error', reject)
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`SQL a echoue (${code}): ${err}`)))
        proc.stdin.end(statements.join('\n') + '\n')
    })
}

// Provisionne la base + l'utilisateur applicatif NOUS-MEMES (en root), au lieu de
// laisser Dolibarr le faire. Raison : MariaDB tourne en sql_mode NO_AUTO_CREATE_USER
// et l'install Dolibarr cree l'utilisateur en `@'%'`/`@'localhost'` mais fait le GRANT
// vers `@'127.0.0.1'` (l'hote de connexion) — ce compte-la n'existe pas → erreur 1133,
// l'utilisateur n'obtient aucun privilege et « Connexion a la base » echoue.
// En creant explicitement l'utilisateur pour l'hote 127.0.0.1 (+ localhost) avec ses
// privileges, l'install se connecte ensuite directement a une base prete. Idempotent.
async function provisionDatabase(port: number, dbPassword: string): Promise<void> {
    await runSql(port, dbPassword, [
        `CREATE DATABASE IF NOT EXISTS \`${LOCAL_DB_NAME}\` CHARACTER SET utf8;`,
        `CREATE USER IF NOT EXISTS '${LOCAL_DB_USER}'@'127.0.0.1' IDENTIFIED BY '${dbPassword}';`,
        `CREATE USER IF NOT EXISTS '${LOCAL_DB_USER}'@'localhost' IDENTIFIED BY '${dbPassword}';`,
        `GRANT ALL PRIVILEGES ON \`${LOCAL_DB_NAME}\`.* TO '${LOCAL_DB_USER}'@'127.0.0.1';`,
        `GRANT ALL PRIVILEGES ON \`${LOCAL_DB_NAME}\`.* TO '${LOCAL_DB_USER}'@'localhost';`,
        `FLUSH PRIVILEGES;`,
    ])
}

function runToCompletion(exe: string, args: string[], logName: string): Promise<void> {
    return new Promise((resolve, reject) => {
        const log = logFile(logName)
        const proc = spawn(exe, args, { windowsHide: true })
        proc.stdout?.pipe(log)
        proc.stderr?.pipe(log)
        proc.on('error', reject)
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${path.basename(exe)} a echoue (code ${code}). Voir ${logName}.`)))
    })
}

// ─── install.forced.php + ini runtime ───────────────────────────────────────

function writeInstallForced(phpPort: number, dbPort: number, dbPassword: string): void {
    const dataRoot = documentsDir().replace(/\\/g, '/')
    const content = `<?php
// Genere par CaisLà — install Dolibarr automatique (mode local).
$force_install_noedit = 2;
$force_install_type = 'mysqli';
$force_install_dbserver = '127.0.0.1';
$force_install_port = '${dbPort}';
$force_install_database = 'cielooposlocal';
$force_install_prefix = 'llx_';
// La base et l'utilisateur sont deja crees par l'app (cf. provisionDatabase) : on
// demande a Dolibarr de NE PAS les recreer (sinon GRANT vers @127.0.0.1 → err 1133).
$force_install_createdatabase = false;
$force_install_databaselogin = 'cieloolocal';
$force_install_databasepass = '${dbPassword}';
$force_install_createuser = false;
$force_install_databaserootlogin = 'root';
$force_install_databaserootpass = '${dbPassword}';
$force_install_dolibarrlogin = 'admin';
$force_install_mainforcehttps = false;
$force_install_main_data_root = '${dataRoot}';
$force_install_lockinstall = true;
$force_install_message = 'Installation locale CielooPos';
`
    fs.mkdirSync(path.join(htdocsDir(), 'install'), { recursive: true })
    fs.writeFileSync(path.join(htdocsDir(), 'install', 'install.forced.php'), content)
}

function writeRuntimeIni(): string {
    fs.mkdirSync(tmpDir(), { recursive: true })
    const sess = path.join(tmpDir(), 'sessions'); fs.mkdirSync(sess, { recursive: true })
    const ini = path.join(rootDir(), 'php.runtime.ini')
    const baseIni = path.join(phpDir(), 'php.ini')
    const extDir = path.join(phpDir(), 'ext').replace(/\\/g, '/')
    const content = `[PHP]
; herite du php.ini du pack puis surcharge les chemins inscriptibles
extension_dir = "${extDir}"
session.save_path = "${sess.replace(/\\/g, '/')}"
sys_temp_dir = "${tmpDir().replace(/\\/g, '/')}"
upload_tmp_dir = "${tmpDir().replace(/\\/g, '/')}"
`
    // On concatene le php.ini du pack pour garder les extensions activees.
    const packIni = fs.existsSync(baseIni) ? fs.readFileSync(baseIni, 'utf-8') : ''
    fs.writeFileSync(ini, packIni + '\n' + content)
    return ini
}

async function startPhp(phpPort: number, iniPath: string): Promise<void> {
    const log = logFile('php.log')
    phpProc = spawn(phpExe(), [
        '-c', iniPath,
        '-S', `127.0.0.1:${phpPort}`,
        '-t', htdocsDir(),
    ], { cwd: htdocsDir(), windowsHide: true })
    phpProc.stdout?.pipe(log)
    phpProc.stderr?.pipe(log)
    phpProc.on('exit', () => { phpProc = null })

    await waitForHttp(`http://127.0.0.1:${phpPort}/`)
}

function waitForHttp(url: string, timeoutMs = 20_000): Promise<void> {
    const start = Date.now()
    return new Promise((resolve, reject) => {
        const tick = (): void => {
            const req = http.get(url, (res) => { res.resume(); resolve() })
            req.on('error', () => {
                if (Date.now() - start > timeoutMs) reject(new Error('PHP ne repond pas (timeout).'))
                else setTimeout(tick, 400)
            })
        }
        tick()
    })
}

// ─── Install silencieuse (sans wizard) ──────────────────────────────────────
//
// Les scripts d'install Dolibarr (step1/step2/step5) lisent leurs parametres via
// GETPOST(...) OU $argv[...] : on peut donc les enchainer en LIGNE DE COMMANDE PHP,
// sans navigateur, sans session ni jeton CSRF. C'est la methode d'install
// non-attendue des integrateurs. install.forced.php fournit le reste.

/** Execute un script d'etape Dolibarr en CLI et renvoie sa sortie (stdout+stderr). */
function runInstallStep(script: string, args: string[], iniPath: string): Promise<string> {
    const installDir = path.join(htdocsDir(), 'install')
    return new Promise((resolve, reject) => {
        const proc = spawn(phpExe(), ['-c', iniPath, script, ...args], { cwd: installDir, windowsHide: true })
        let out = ''
        proc.stdout?.on('data', (d) => { out += d.toString() })
        proc.stderr?.on('data', (d) => { out += d.toString() })
        proc.on('error', reject)
        proc.on('exit', () => resolve(out))   // les scripts ne fixent pas de code retour
    })
}

/**
 * Installe Dolibarr en silence : step1 (conf+connexion), step2 (tables+donnees de
 * reference), step5 (compte admin + install.lock). La base et l'utilisateur ayant
 * deja ete provisionnes (provisionDatabase), Dolibarr ne cree ni base ni user.
 */
async function runSilentInstall(phpPort: number, dbPort: number, dbPassword: string, iniPath: string, onProgress?: ProgressFn): Promise<void> {
    const htdocs = htdocsDir().replace(/\\/g, '/')
    const dataRoot = documentsDir().replace(/\\/g, '/')
    const baseUrl = `http://127.0.0.1:${phpPort}`

    // check.php cree normalement un conf.php vide pour le rendre inscriptible. En CLI
    // on saute check.php, donc on le fait nous-memes : sinon step1 refuse de demarrer
    // (is_writable echoue sur un fichier absent).
    fs.mkdirSync(confDir(), { recursive: true })
    if (!fs.existsSync(confPhpPath())) fs.writeFileSync(confPhpPath(), '')

    onProgress?.({ phase: 'install-config', pct: 60, message: 'Installation Dolibarr — configuration (step1)…' })
    await runInstallStep('step1.php', [
        'set', 'auto',
        htdocs, dataRoot, baseUrl,
        'root', dbPassword,
        'mysqli', '127.0.0.1', LOCAL_DB_NAME, LOCAL_DB_USER, dbPassword,
        String(dbPort), 'llx_',
        '', '',                       // db_create_database / db_create_user = off (deja provisionne)
    ], iniPath)
    sanitizeConfPhp()                 // step1 vient d'ecrire conf.php

    onProgress?.({ phase: 'install-db', pct: 78, message: 'Installation Dolibarr — création des tables et données (step2)…' })
    await runInstallStep('step2.php', ['set', 'auto'], iniPath)

    onProgress?.({ phase: 'install-admin', pct: 92, message: 'Installation Dolibarr — compte administrateur (step5)…' })
    await runInstallStep('step5.php', [
        '', '', 'auto', 'set',
        LOCAL_ADMIN_LOGIN, LOCAL_ADMIN_PASSWORD, LOCAL_ADMIN_PASSWORD,
        '1',                          // installlock
    ], iniPath)

    if (!isInstalled()) {
        throw new Error('Installation silencieuse de la caisse locale échouée (install.lock absent).')
    }
}

// ─── API publique : start / stop / status ───────────────────────────────────

/**
 * Demarre le mode local et renvoie l'URL a charger.
 * - 1er lancement : URL = /install/ (wizard Dolibarr pre-rempli via install.forced).
 * - ensuite        : URL = racine du POS.
 */
export async function startLocal(onProgress?: ProgressFn): Promise<string> {
    if (!isPackPresent()) throw new Error('Pack local absent. Lance ensurePack() d\'abord.')
    if (currentUrl && phpProc && mariadbProc) return currentUrl

    // Correction a la source : document_root en slashs avant (cf. bloc plus haut).
    patchDolibarrInstallPaths()
    // Filets de securite : corrige un conf.php existant et surveille les ecritures.
    sanitizeConfPhp()
    startConfWatcher()

    fs.mkdirSync(documentsDir(), { recursive: true })

    const state = readState()
    const dbPassword = state.dbPassword ?? crypto.randomBytes(16).toString('hex')

    onProgress?.({ phase: 'db', pct: 20, message: 'Démarrage de la base de données MariaDB…' })
    const dbPort = await pickPort(state.dbPort, 33060)
    await startMariadb(dbPort, dbPassword)

    onProgress?.({ phase: 'web', pct: 40, message: 'Démarrage du serveur web PHP / Dolibarr…' })
    const phpPort = await pickPort(state.phpPort, 8765)
    writeInstallForced(phpPort, dbPort, dbPassword)
    const ini = writeRuntimeIni()
    await startPhp(phpPort, ini)

    writeState({ phpPort, dbPort, dbPassword, installed: isInstalled() })

    // L'install a pu (re)ecrire conf.php pendant le demarrage : on le recorrige.
    sanitizeConfPhp()

    // 1er lancement : on installe Dolibarr en SILENCE (aucun wizard visible) puis on
    // charge directement le POS. Sinon on va droit a la racine.
    if (!isInstalled()) {
        await runSilentInstall(phpPort, dbPort, dbPassword, ini, onProgress)
        writeState({ installed: true })
    }

    // Explorateur de base accessible via le serveur PHP local (http://…/db-admin.php).
    writeDbAdmin(dbPort, dbPassword)

    const base = `http://127.0.0.1:${phpPort}`
    currentUrl = base
    onProgress?.({ phase: 'ready', pct: 100, message: 'Caisse locale prête.' })
    return currentUrl
}

/** A appeler quand l'install Dolibarr vient de se terminer (install.lock pose). */
export function markInstalledIfDone(): boolean {
    const done = isInstalled()
    if (done) writeState({ installed: true })
    return done
}

export async function stopLocal(): Promise<void> {
    stopConfWatcher()
    const kill = (p: ChildProcess | null): Promise<void> => new Promise((resolve) => {
        if (!p || p.exitCode !== null) return resolve()
        p.once('exit', () => resolve())
        p.kill()
        setTimeout(() => { try { p.kill('SIGKILL') } catch { /* */ } resolve() }, 4000)
    })
    // PHP d'abord, MariaDB ensuite (arret propre).
    await kill(phpProc)
    if (mariadbProc) {
        const st = readState()
        try { await runSql(st.dbPort ?? 33060, st.dbPassword ?? '', ['SHUTDOWN;']) } catch { /* fallback kill */ }
    }
    await kill(mariadbProc)
    phpProc = null; mariadbProc = null; currentUrl = null
}

export function getLocalStatus(): LocalStatus {
    const present = isPackPresent()
    return {
        packPresent: present,
        running: Boolean(phpProc && mariadbProc),
        installed: isInstalled(),
        url: currentUrl,
        message: !present ? 'Pack local non installe'
            : currentUrl ? 'Mode local actif'
            : 'Pret a demarrer',
    }
}

export function getLocalBaseUrl(): string | null {
    const st = readState()
    return st.phpPort ? `http://127.0.0.1:${st.phpPort}` : null
}

// ─── Synchro Cloud → Local : etat + import SQL ───────────────────────────────

export interface SyncState { seeded: boolean; watermark: string | null }

export function getSyncState(): SyncState {
    const st = readState()
    return { seeded: Boolean(st.cloudSeeded), watermark: st.cloudWatermark ?? null }
}

export function setSyncState(patch: Partial<SyncState>): void {
    const next: Partial<LocalState> = {}
    if (patch.seeded !== undefined) next.cloudSeeded = patch.seeded
    if (patch.watermark !== undefined) next.cloudWatermark = patch.watermark
    writeState(next)
}

/** Vide et recree la base locale (avant un seed complet depuis le cloud). */
export async function recreateLocalDatabase(): Promise<void> {
    const st = readState()
    if (!st.dbPort || !st.dbPassword) throw new Error('Base locale non initialisée.')
    await runSql(st.dbPort, st.dbPassword, [`DROP DATABASE IF EXISTS \`${LOCAL_DB_NAME}\`;`])
    // Recree la base + l'utilisateur applicatif + les droits (idempotent).
    await provisionDatabase(st.dbPort, st.dbPassword)
}

export type TableProgressFn = (done: number, total: number, table: string) => void

// Transform pass-through qui repère les marqueurs « -- CIELOO_TABLE i/total nom »
// emis par le serveur, pour suivre la progression table par table — sans toucher
// au flux transmis a mariadb (les marqueurs sont des commentaires SQL ignores).
class TableMarkerTap extends Transform {
    private carry = ''
    constructor(private readonly onTable?: TableProgressFn) { super() }
    override _transform(chunk: Buffer, _enc: BufferEncoding, cb: () => void): void {
        this.push(chunk)                       // transmis tel quel a mariadb
        if (this.onTable) {
            this.carry += chunk.toString('utf8')
            let nl: number
            while ((nl = this.carry.indexOf('\n')) >= 0) {
                const line = this.carry.slice(0, nl)
                this.carry = this.carry.slice(nl + 1)
                const m = line.match(/^-- CIELOO_TABLE (\d+)\/(\d+) (.+)$/)
                if (m) this.onTable(Number(m[1]), Number(m[2]), m[3].trim())
            }
            if (this.carry.length > 1_000_000) this.carry = this.carry.slice(-1024)
        }
        cb()
    }
}

/**
 * Importe un fichier SQL gzip (dump cloud ou upserts incrementaux) dans la base
 * locale en streaming : gunzip → repère des tables → client mariadb (stdin).
 * FK desactivees par le dump. `onTable` est appele a chaque table traitee.
 */
export function importSqlGz(gzPath: string, onTable?: TableProgressFn): Promise<void> {
    const st = readState()
    if (!st.dbPort || !st.dbPassword) return Promise.reject(new Error('Base locale non initialisée.'))
    return new Promise((resolve, reject) => {
        // --force : ne pas tout interrompre sur une erreur isolée (ex: table absente
        // côté local lors d'un incrément). Les autres requêtes s'appliquent quand même.
        const args = ['--force', '-h', '127.0.0.1', '-P', String(st.dbPort), '-u', 'root', `-p${st.dbPassword}`, LOCAL_DB_NAME]
        const proc = spawn(mariadbClientExe(), args, { windowsHide: true })
        let err = ''
        proc.stderr.on('data', (d) => { err += d.toString() })
        proc.on('error', reject)
        proc.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`Import SQL échoué (code ${code}): ${err.slice(0, 2000)}`)))
        const gunzip = zlib.createGunzip()
        gunzip.on('error', reject)
        fs.createReadStream(gzPath).on('error', reject)
            .pipe(gunzip)
            .pipe(new TableMarkerTap(onTable))
            .pipe(proc.stdin)
    })
}

// ─── Explorateur de base de donnees (mini phpMyAdmin maison) ─────────────────
//
// On depose un unique fichier PHP (db-admin.php) dans le htdocs deja servi par
// le serveur PHP local. Il se connecte avec les identifiants de la caisse locale
// et permet de parcourir les tables / lancer du SQL — accessible uniquement en
// 127.0.0.1 (le serveur PHP n'ecoute que la boucle locale).

function dbAdminPath(): string { return path.join(htdocsDir(), 'db-admin.php') }

/** Renvoie l'URL de l'explorateur de base (ou null si le serveur n'est pas lance). */
export function getDbAdminUrl(): string | null {
    const st = readState()
    return st.phpPort ? `http://127.0.0.1:${st.phpPort}/db-admin.php` : null
}

/** (Re)ecrit db-admin.php avec les identifiants courants. Idempotent. */
export function writeDbAdmin(dbPort: number, dbPassword: string): void {
    if (!fs.existsSync(htdocsDir())) return
    try { fs.writeFileSync(dbAdminPath(), dbAdminPhp(dbPort, dbPassword)) } catch { /* non bloquant */ }
}

// Le corps PHP est ecrit en evitant toute sequence `${` (réservée au template JS)
// et tout antislash ; les backticks SQL sont echappes. Mot de passe = hex pur.
function dbAdminPhp(dbPort: number, dbPassword: string): string {
    return `<?php
// CaisLà — Explorateur de base de données (caisse locale). Accès localhost uniquement.
error_reporting(E_ALL & ~E_DEPRECATED & ~E_NOTICE & ~E_WARNING);
$HOST='127.0.0.1'; $PORT=${dbPort}; $NAME='${LOCAL_DB_NAME}'; $USER='${LOCAL_DB_USER}'; $PASS='${dbPassword}';
$cn=@new mysqli($HOST,$USER,$PASS,$NAME,(int)$PORT);
if($cn->connect_errno){http_response_code(500);die('<p style="font-family:sans-serif;color:#b91c1c;padding:24px">Connexion à la base impossible : '.htmlspecialchars($cn->connect_error).'</p>');}
$cn->set_charset('utf8mb4');
function h($s){return htmlspecialchars((string)$s,ENT_QUOTES,'UTF-8');}
$t=isset($_GET['t'])?preg_replace('/[^A-Za-z0-9_]/','',$_GET['t']):'';
$p=isset($_GET['p'])?max(0,(int)$_GET['p']):0;
$per=50;
$sqlInput=isset($_POST['sql'])?trim($_POST['sql']):'';

$tables=array();
if($r=$cn->query('SHOW TABLES')){while($row=$r->fetch_row()){$tables[]=$row[0];}$r->free();}

function renderResult($cn,$res){
  if($res===true){echo '<p class="ok">Requête exécutée. Lignes affectées : '.$cn->affected_rows.'</p>';return;}
  if(!$res){echo '<p class="err">'.h($cn->error).'</p>';return;}
  $cols=array(); foreach($res->fetch_fields() as $f){$cols[]=$f->name;}
  echo '<div class="tablewrap"><table><thead><tr>';
  foreach($cols as $c){echo '<th>'.h($c).'</th>';}
  echo '</tr></thead><tbody>';
  $n=0;
  while($row=$res->fetch_assoc()){
    $n++; echo '<tr>';
    foreach($cols as $c){
      $v=$row[$c];
      if($v===null){echo '<td class="null">NULL</td>';}
      else{$s=(string)$v; if(strlen($s)>200){$s=substr($s,0,200).'…';} echo '<td>'.h($s).'</td>';}
    }
    echo '</tr>';
  }
  echo '</tbody></table></div>';
  if($n===0){echo '<p class="muted">Aucune ligne.</p>';}
}
?><!doctype html><html lang="fr"><head><meta charset="utf-8"><title>Base — Caisse locale</title>
<style>
:root{--bg:#f4f6fb;--surface:#fff;--border:#e3e8f2;--text:#1f2a3d;--text2:#51607a;--muted:#8a97ad;
  --accent:#f97316;--accent-strong:#ea580c;--accent-soft:#fff4ea;--accent-border:#fbd6b0;}
*{box-sizing:border-box;margin:0;padding:0}
html,body{height:100%}
body{font-family:'Segoe UI',system-ui,sans-serif;background:var(--bg);color:var(--text);padding:22px}
.app{display:flex;height:100%;background:var(--surface);border:1px solid var(--border);border-radius:16px;overflow:hidden;box-shadow:0 12px 32px rgba(20,30,60,.08)}
aside{width:268px;flex-shrink:0;background:#fbfcfe;border-right:1px solid var(--border);display:flex;flex-direction:column}
aside .hd{padding:18px 18px 14px}
aside .hd b{font-size:14px;color:var(--text)}
aside .hd .db{font-size:11.5px;color:var(--muted);margin-top:3px}
aside .search{padding:0 14px 12px;border-bottom:1px solid var(--border)}
aside .search input{width:100%;border:1.5px solid var(--border);border-radius:10px;padding:9px 12px;font-family:inherit;font-size:13px;color:var(--text);background:#f7f9fc;outline:none}
aside .search input:focus{border-color:var(--accent-border);background:#fff}
aside nav{overflow-y:auto;padding:10px}
aside a{display:flex;justify-content:space-between;gap:8px;padding:9px 12px;border-radius:9px;color:var(--text2);text-decoration:none;font-size:13px}
aside a:hover{background:#f4f6fb}
aside a.on{background:var(--accent-soft);color:var(--accent-strong);font-weight:600}
aside .empty{padding:14px;color:var(--muted);font-size:12.5px;text-align:center;display:none}
main{flex:1;overflow-y:auto;padding:28px 32px}
h1{font-size:18px;font-weight:800;margin-bottom:5px;letter-spacing:-.02em}
h1 .accent{color:var(--accent-strong)}
.sub{font-size:12.5px;color:var(--muted);margin-bottom:22px}
form.sql{margin-bottom:24px}
textarea{width:100%;min-height:88px;background:var(--surface);color:var(--text);border:1.5px solid var(--border);border-radius:12px;padding:13px 15px;font-family:Consolas,monospace;font-size:13px;resize:vertical;outline:none}
textarea:focus{border-color:var(--accent-border)}
.btn{margin-top:11px;border:none;border-radius:10px;padding:10px 19px;font-weight:700;font-size:13px;cursor:pointer;background:linear-gradient(135deg,var(--accent),#fb923c);color:#fff;box-shadow:0 4px 14px rgba(249,115,22,.3)}
.btn:hover{filter:brightness(1.05)}
.tablewrap{overflow:auto;border:1px solid var(--border);border-radius:13px;max-height:60vh;background:var(--surface)}
table{border-collapse:collapse;width:100%;font-size:12.5px}
th{position:sticky;top:0;background:#f7f9fc;color:var(--text2);text-align:left;padding:11px 13px;border-bottom:1px solid var(--border);white-space:nowrap;font-weight:700}
td{padding:9px 13px;border-bottom:1px solid #eef1f7;white-space:nowrap;max-width:340px;overflow:hidden;text-overflow:ellipsis;color:var(--text)}
tr:hover td{background:#f9fbfe}
td.null{color:var(--muted);font-style:italic}
.pager{display:flex;gap:8px;align-items:center;margin-top:15px;font-size:13px}
.pager a{color:var(--accent-strong);text-decoration:none;padding:7px 13px;border:1px solid var(--border);border-radius:9px;background:var(--surface)}
.pager a:hover{background:var(--accent-soft);border-color:var(--accent-border)}
.pager .muted{color:var(--muted)}
.ok{color:#16a34a;margin:6px 0}
.err{color:#dc2626;margin:6px 0;font-family:Consolas,monospace}
.muted{color:var(--muted);margin-top:10px}
.count{font-size:13px;color:var(--text2);margin-bottom:13px}
.count b{color:var(--text)}
</style></head><body>
<div class="app">
<aside>
  <div class="hd"><b>Base de données</b><div class="db"><?php echo h($NAME); ?></div></div>
  <div class="search"><input id="tsearch" type="text" placeholder="Rechercher une table…" autocomplete="off" spellcheck="false" /></div>
  <nav id="tnav">
    <?php foreach($tables as $tb){ $on=($tb===$t&&!$sqlInput)?' class="on"':''; echo '<a'.$on.' data-name="'.h(strtolower($tb)).'" href="?t='.h($tb).'"><span>'.h($tb).'</span></a>'; } ?>
    <div class="empty" id="tempty">Aucune table trouvée</div>
  </nav>
</aside>
<main>
  <h1>Caisse <span class="accent">locale</span> — Base de données</h1>
  <div class="sub"><?php echo count($tables); ?> table(s) · utilisateur <?php echo h($USER); ?> · port <?php echo h($PORT); ?></div>

  <form class="sql" method="post">
    <textarea name="sql" placeholder="Écrivez une requête SQL puis Exécuter (Ctrl+Entrée)…"><?php echo h($sqlInput); ?></textarea>
    <button class="btn" type="submit">Exécuter le SQL</button>
  </form>

  <?php
  if($sqlInput!==''){
    echo '<h2 style="font-size:14px;margin-bottom:10px">Résultat</h2>';
    $res=$cn->query($sqlInput);
    renderResult($cn,$res);
    if($res instanceof mysqli_result){$res->free();}
  } elseif($t!==''){
    $total=0; if($cr=$cn->query('SELECT COUNT(*) AS c FROM \`'.$t.'\`')){$total=(int)$cr->fetch_assoc()['c'];$cr->free();}
    echo '<div class="count">Table <b>'.h($t).'</b> — '.$total.' ligne(s)</div>';
    $off=$p*$per;
    $res=$cn->query('SELECT * FROM \`'.$t.'\` LIMIT '.$per.' OFFSET '.$off);
    renderResult($cn,$res);
    if($res instanceof mysqli_result){$res->free();}
    $pages=(int)ceil($total/$per);
    if($pages>1){
      echo '<div class="pager">';
      if($p>0){echo '<a href="?t='.h($t).'&p='.($p-1).'">‹ Précédent</a>';}
      echo '<span class="muted">Page '.($p+1).' / '.$pages.'</span>';
      if($p+1<$pages){echo '<a href="?t='.h($t).'&p='.($p+1).'">Suivant ›</a>';}
      echo '</div>';
    }
  } else {
    echo '<p class="muted">Sélectionnez une table à gauche, ou lancez une requête SQL.</p>';
  }
  ?>
  <script>
    var ta=document.querySelector('textarea[name=sql]');
    if(ta){ta.addEventListener('keydown',function(e){if((e.ctrlKey||e.metaKey)&&e.key==='Enter'){e.preventDefault();ta.form.submit();}});}
    var search=document.getElementById('tsearch');
    var links=Array.prototype.slice.call(document.querySelectorAll('#tnav a'));
    var empty=document.getElementById('tempty');
    if(search){search.addEventListener('input',function(){
      var q=search.value.trim().toLowerCase();var shown=0;
      links.forEach(function(a){var ok=a.getAttribute('data-name').indexOf(q)!==-1;a.style.display=ok?'':'none';if(ok)shown++;});
      if(empty)empty.style.display=shown?'none':'block';
    });}
  </script>
</main>
</div></body></html>`
}

// Identifiants de la base posés par writeInstallForced (mode local).
const LOCAL_DB_NAME = 'cielooposlocal'
const LOCAL_DB_USER = 'cieloolocal'

// Compte administrateur Dolibarr créé par l'install silencieuse (mot de passe fixe
// connu). Modifiable ici en une ligne.
const LOCAL_ADMIN_LOGIN = 'admin'
const LOCAL_ADMIN_PASSWORD = 'cieloopos'

export interface LocalDebugInfo {
    packPresent: boolean
    packVersion: string | null
    installed: boolean
    phpRunning: boolean
    dbRunning: boolean
    phpPort: number | null
    dbPort: number | null
    baseUrl: string | null
    currentUrl: string | null
    dbName: string
    dbUser: string
    dbPassword: string | null
    paths: { root: string; logs: string; data: string; documents: string }
}

/** Infos completes pour le panneau de debug « Statut serveur ». */
export function getLocalDebugInfo(): LocalDebugInfo {
    const st = readState()
    const phpRunning = Boolean(phpProc && phpProc.exitCode === null)
    const dbRunning = Boolean(mariadbProc && mariadbProc.exitCode === null)
    return {
        packPresent: isPackPresent(),
        packVersion: st.packVersion,
        installed: isInstalled(),
        phpRunning,
        dbRunning,
        phpPort: st.phpPort,
        dbPort: st.dbPort,
        baseUrl: st.phpPort ? `http://127.0.0.1:${st.phpPort}` : null,
        currentUrl,
        dbName: LOCAL_DB_NAME,
        dbUser: LOCAL_DB_USER,
        dbPassword: st.dbPassword,
        paths: {
            root: rootDir(),
            logs: rootDir(),            // php.log / mariadbd.log vivent a la racine
            data: dataDir(),
            documents: documentsDir(),
        },
    }
}

/**
 * Desinstalle completement la caisse locale : arrete les serveurs puis supprime
 * tout (pack, base, documents, etat) du userData. Renvoie l'espace libere (octets).
 */
export async function uninstallLocal(): Promise<void> {
    await stopLocal()
    // Petite attente pour que Windows libere les verrous fichiers (mariadbd/php).
    await new Promise((r) => setTimeout(r, 1500))
    if (fs.existsSync(rootDir())) {
        await fsp.rm(rootDir(), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
    }
}

/**
 * Efface la configuration locale sans desinstaller le pack : arrete les serveurs
 * puis supprime la base (mysql-data), les documents Dolibarr (install.lock), le
 * conf.php genere par l'install, l'etat persiste (ports/mot de passe/flag installed),
 * le tmp et les logs. Le runtime (php/mariadb/dolibarr) est conserve : la prochaine
 * bascule en caisse locale relance une installation Dolibarr vierge, sans
 * re-telecharger le pack.
 */
export async function resetLocalConfig(): Promise<void> {
    await stopLocal()
    // Petite attente pour que Windows libere les verrous fichiers (mariadbd/php).
    await new Promise((r) => setTimeout(r, 1500))
    const targets = [
        dataDir(),                              // base MariaDB
        documentsDir(),                         // data_root Dolibarr (install.lock, conf util.)
        confPhpPath(),                          // conf.php genere par l'install Dolibarr
        path.join(confDir(), 'conf.php.old'),   // sauvegarde laissee par l'installeur
        tmpDir(),                               // sessions / uploads php
        statePath(),                            // ports / mot de passe / flag installed
        path.join(rootDir(), 'php.runtime.ini'),
        path.join(rootDir(), 'php.log'),
        path.join(rootDir(), 'mariadbd.log'),
        path.join(rootDir(), 'mariadb-install.log'),
    ]
    for (const t of targets) {
        if (fs.existsSync(t)) {
            await fsp.rm(t, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 })
        }
    }
}
