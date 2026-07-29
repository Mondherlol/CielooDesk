; ─────────────────────────────────────────────────────────────────────────────
; Personnalisation de l'installeur NSIS (auto-inclus par electron-builder :
; le fichier build/installer.nsh est détecté et ses macros insérées automatiquement).
;
; Objectif : le dossier de données partagé C:\ProgramData\CielooPosv2 (vers lequel
; l'app redirige userData) doit être LISIBLE ET INSCRIPTIBLE par TOUS les comptes
; Windows du poste (compte admin d'install + comptes caissiers non-admin). Par
; défaut C:\ProgramData n'accorde que la lecture aux comptes standard.
;
; L'install étant perMachine, ce bloc s'exécute élevé (droits admin) → icacls peut
; modifier l'ACL. On cible le groupe "Utilisateurs" par son SID *S-1-5-32-545
; (indépendant de la langue de Windows : « Utilisateurs », « Users », arabe…).
; ─────────────────────────────────────────────────────────────────────────────

!macro customInstall
  ; C:\ProgramData via la variable d'environnement (fiable, indépendant du contexte
  ; ShellVar NSIS — $COMMONAPPDATA n'existe pas en NSIS standard). Le nom du dossier
  ; doit correspondre à SHARED_DATA_FOLDER dans src/main/index.ts.
  ReadEnvStr $0 "ProgramData"
  StrCmp $0 "" cieloo_skip_acl 0
    CreateDirectory "$0\CielooPosv2"
    ; (OI)(CI) = héritage fichiers + sous-dossiers · M = Modifier · /T = arbre existant
    ; /C = continuer malgré les erreurs. icacls appelé par chemin complet ($SYSDIR).
    nsExec::ExecToLog '"$SYSDIR\icacls.exe" "$0\CielooPosv2" /grant "*S-1-5-32-545:(OI)(CI)M" /T /C'
  cieloo_skip_acl:
!macroend
