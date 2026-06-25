<#
.SYNOPSIS
    Assemble le "pack local" CielooPos : PHP portable + MariaDB portable + Dolibarr,
    le tout dans un seul .zip que CaisLà telechargera et fera tourner en localhost.

.DESCRIPTION
    Aucune dependance systeme (pas de XAMPP, pas de service Windows). Le pack contient
    uniquement des binaires portables. Dolibarr n'est PAS pre-installe ici : c'est le
    module Electron qui lance l'install automatique (install.forced.php) au 1er boot.

    Sortie : release/local-pack/cieloo-local-pack-<version>.zip  (+ .json manifeste)

.EXAMPLE
    powershell -ExecutionPolicy Bypass -File scripts/build-local-pack.ps1
#>

[CmdletBinding()]
param(
    # Version Dolibarr a embarquer (tag GitHub)
    [string]$DolibarrVersion = '21.0.1',
    # MariaDB LTS portable (zip winx64). archive.mariadb.org garde toutes les versions.
    [string]$MariaDbVersion  = '11.4.4',
    # Branche PHP a embarquer (NTS x64). La version exacte est resolue via releases.json.
    [string]$PhpBranch       = '8.3',
    # Repertoire de travail (telechargements + staging). HORS OneDrive et chemin COURT
    # pour eviter la limite MAX_PATH (260) sur les fichiers Dolibarr profondement imbriques.
    [string]$WorkDir         = 'C:/cieloo-pack-build',
    # Repertoire de sortie du zip final. Vide = resolu dans le corps ($PSScriptRoot
    # n'est PAS fiable dans une valeur par defaut de parametre sous -File).
    [string]$OutDir          = '',
    [switch]$Clean
)

$ErrorActionPreference = 'Stop'
$ProgressPreference     = 'SilentlyContinue'   # accelere Invoke-WebRequest (pas de barre)
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

function Info($m)  { Write-Host "[pack] $m" -ForegroundColor Cyan }
function Ok($m)    { Write-Host "[pack] $m" -ForegroundColor Green }
function Warn($m)  { Write-Host "[pack] $m" -ForegroundColor Yellow }

# 7za gere les chemins longs et est bien plus rapide qu'Expand-Archive / ZipFile.
$Sevenzip = Join-Path $PSScriptRoot '../node_modules/7zip-bin/win/x64/7za.exe'
if (-not (Test-Path $Sevenzip)) { throw "7za introuvable: $Sevenzip (npm install ?)" }

function Download($url, $dest) {
    if (Test-Path $dest) { Info "deja telecharge: $(Split-Path $dest -Leaf)"; return }
    Info "telechargement: $url"
    Invoke-WebRequest -Uri $url -OutFile $dest -UseBasicParsing
}

function Expand($zip, $dest) {
    if (Test-Path $dest) { Remove-Item $dest -Recurse -Force }
    Info "extraction: $(Split-Path $zip -Leaf)"
    & $Sevenzip x $zip "-o$dest" -y -bso0 -bsp0 | Out-Null
    if ($LASTEXITCODE -ne 0) { throw "7za extraction a echoue ($LASTEXITCODE): $zip" }
}

# Copie robuste (chemins longs, rapide) via robocopy. Codes < 8 = succes.
function CopyTree($src, $dst) {
    robocopy $src $dst /E /NFL /NDL /NJH /NJS /NP /MT:16 | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "robocopy a echoue ($LASTEXITCODE): $src -> $dst" }
    $global:LASTEXITCODE = 0
}

# ─── Preparation des dossiers ───────────────────────────────────────────────
if (-not $OutDir) { $OutDir = Join-Path $PSScriptRoot '..\release\local-pack' }
$OutDir = [System.IO.Path]::GetFullPath($OutDir)   # chemin absolu propre
if ($Clean -and (Test-Path $WorkDir)) { Remove-Item $WorkDir -Recurse -Force }
$dl       = Join-Path $WorkDir 'downloads'
$staging  = Join-Path $WorkDir 'staging'
New-Item -ItemType Directory -Force -Path $dl, $staging, $OutDir | Out-Null
if (Test-Path $staging) { Remove-Item $staging -Recurse -Force }
New-Item -ItemType Directory -Force -Path $staging | Out-Null

# ─── 1) PHP portable (NTS x64) ──────────────────────────────────────────────
Info "resolution de la derniere version PHP $PhpBranch (NTS x64)..."
$releases = Invoke-RestMethod -Uri 'https://windows.php.net/downloads/releases/releases.json' -UseBasicParsing
$branch   = $releases.$PhpBranch
if (-not $branch) { throw "Branche PHP $PhpBranch introuvable dans releases.json" }
# On cherche l'asset NTS x64 (vs16/vs17). La structure: $branch.<vsXX>.<archX>.nts.zip / .path
$phpAsset = $null
foreach ($prop in $branch.PSObject.Properties) {
    $v = $prop.Value
    if ($v -is [psobject] -and $v.PSObject.Properties.Name -contains 'zip') {
        if ($prop.Name -match 'nts' -and $prop.Name -match 'x64') { $phpAsset = $v.zip; break }
    }
}
if (-not $phpAsset) {
    # fallback: parcourir les sous-objets pour trouver un zip nts x64
    foreach ($prop in $branch.PSObject.Properties) {
        $z = $prop.Value.zip
        if ($z -and $z.path -match 'nts' -and $z.path -match 'x64') { $phpAsset = $z; break }
    }
}
if (-not $phpAsset) { throw "Impossible de resoudre l'asset PHP NTS x64 pour $PhpBranch." }
$phpUrl  = "https://windows.php.net/downloads/releases/$($phpAsset.path)"
$phpZip  = Join-Path $dl "php-$PhpBranch-nts-x64.zip"
Download $phpUrl $phpZip
$phpStage = Join-Path $staging 'php'
Expand $phpZip $phpStage
Ok "PHP: $($phpAsset.path)"

# ─── 2) MariaDB portable (winx64) ───────────────────────────────────────────
$mdbName = "mariadb-$MariaDbVersion-winx64"
$mdbUrl  = "https://archive.mariadb.org/mariadb-$MariaDbVersion/winx64-packages/$mdbName.zip"
$mdbZip  = Join-Path $dl "$mdbName.zip"
Download $mdbUrl $mdbZip
$mdbTmp  = Join-Path $WorkDir 'mariadb-extract'
Expand $mdbZip $mdbTmp
$mdbSrc  = Join-Path $mdbTmp $mdbName
$mdbStage = Join-Path $staging 'mariadb'
New-Item -ItemType Directory -Force -Path $mdbStage | Out-Null
# On garde bin/ + share/ (share contient les SQL systeme requis par install-db).
# On allege uniquement le bin/ des binaires inutiles a une caisse (debug, bench, clients exotiques).
Info "trim MariaDB (bin/ allege, share/ conserve entier)..."
CopyTree (Join-Path $mdbSrc 'bin')   (Join-Path $mdbStage 'bin')
CopyTree (Join-Path $mdbSrc 'share') (Join-Path $mdbStage 'share')
# bin: on ne garde que les .exe indispensables (les .dll sont toutes conservees).
# IMPORTANT: mariadb-install-db.exe (Windows) invoque 'mysqld.exe' en dur → a garder.
$binKeep = @(
    'mariadbd.exe','mysqld.exe','mariadb-install-db.exe','mariadb.exe','mysql.exe',
    'mariadb-admin.exe','mysqladmin.exe','mariadb-dump.exe','mysqldump.exe',
    'mariadb-check.exe','mysqlcheck.exe'
)
Get-ChildItem (Join-Path $mdbStage 'bin') -File -Filter *.exe |
    Where-Object { $binKeep -notcontains $_.Name } |
    Remove-Item -Force -ErrorAction SilentlyContinue
Remove-Item $mdbTmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "MariaDB $MariaDbVersion"

# ─── 3) Dolibarr (htdocs uniquement) ────────────────────────────────────────
$dolUrl = "https://github.com/Dolibarr/dolibarr/archive/refs/tags/$DolibarrVersion.zip"
$dolZip = Join-Path $dl "dolibarr-$DolibarrVersion.zip"
Download $dolUrl $dolZip
$dolTmp = Join-Path $WorkDir 'dolibarr-extract'
Expand $dolZip $dolTmp
$dolSrc = Join-Path $dolTmp "dolibarr-$DolibarrVersion"
if (-not (Test-Path $dolSrc)) { $dolSrc = (Get-ChildItem $dolTmp -Directory | Select-Object -First 1).FullName }
$dolStage = Join-Path $staging 'dolibarr'
New-Item -ItemType Directory -Force -Path $dolStage | Out-Null
CopyTree (Join-Path $dolSrc 'htdocs') (Join-Path $dolStage 'htdocs')
# conf/ doit exister et etre inscriptible pour que l'installeur ecrive conf.php
New-Item -ItemType Directory -Force -Path (Join-Path $dolStage 'htdocs/conf') | Out-Null
Remove-Item $dolTmp -Recurse -Force -ErrorAction SilentlyContinue
Ok "Dolibarr $DolibarrVersion (htdocs)"

# ─── 4) php.ini generique (chemins absolus injectes au runtime via -d) ──────
$phpIni = @"
; php.ini genere par build-local-pack.ps1 (CielooPos local)
; Les chemins inscriptibles (session, tmp, upload) sont surcharges au runtime
; par le module Electron via l'option -c <ini runtime>.
engine = On
short_open_tag = Off
display_errors = Off
log_errors = On
max_execution_time = 300
max_input_time = 300
memory_limit = 512M
post_max_size = 64M
upload_max_filesize = 64M
date.timezone = Europe/Paris
cgi.fix_pathinfo = 1
extension_dir = "ext"

extension=mysqli
extension=pdo_mysql
extension=curl
extension=gd
extension=mbstring
extension=intl
extension=openssl
extension=zip
extension=fileinfo
extension=exif
extension=soap
extension=sodium

zend_extension=opcache
opcache.enable = 1
opcache.enable_cli = 0
opcache.validate_timestamps = 1
"@
Set-Content -Path (Join-Path $phpStage 'php.ini') -Value $phpIni -Encoding UTF8
Ok "php.ini ecrit"

# ─── 5) Manifeste + zip final ───────────────────────────────────────────────
$phpFullVersion = ($phpAsset.path -replace '^php-','' -replace '-nts.*$','')
$manifest = [ordered]@{
    pack            = 'cieloo-local'
    schema          = 1
    builtAt         = (Get-Date).ToString('o')
    dolibarrVersion = $DolibarrVersion
    mariadbVersion  = $MariaDbVersion
    phpVersion      = $phpFullVersion
    layout          = @{ php = 'php'; mariadb = 'mariadb'; dolibarr = 'dolibarr/htdocs' }
}
$manifest | ConvertTo-Json -Depth 5 | Set-Content -Path (Join-Path $staging 'pack.json') -Encoding UTF8

$zipName = "cieloo-local-pack-$DolibarrVersion.zip"
$zipPath = Join-Path $OutDir $zipName
if (Test-Path $zipPath) { Remove-Item $zipPath -Force }
Info "compression -> $zipName (7za)..."
# On zippe le CONTENU de staging (pas le dossier parent) : '.\*' depuis staging.
Push-Location $staging
& $Sevenzip a -tzip -mx=5 -mmt=on $zipPath '.\*' -bso0 -bsp0 | Out-Null
$zipCode = $LASTEXITCODE
Pop-Location
if ($zipCode -ne 0) { throw "7za compression a echoue ($zipCode)" }

$hash = (Get-FileHash $zipPath -Algorithm SHA256).Hash.ToLower()
$sizeMb = [math]::Round((Get-Item $zipPath).Length / 1MB, 1)
$outManifest = [ordered]@{
    file   = $zipName
    sha256 = $hash
    sizeMb = $sizeMb
} + $manifest
$outManifest | ConvertTo-Json -Depth 5 | Set-Content -Path ($zipPath -replace '\.zip$','.json') -Encoding UTF8

Ok "TERMINE -> $zipPath  ($sizeMb Mo)"
Ok "sha256: $hash"
Info "Heberge le .zip + le .json sur ton serveur, puis pointe LOCAL_PACK_URL dessus."
