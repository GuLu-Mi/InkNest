; app-builder-lib 26.15.3's macOS UninstallerReader omits the NSIS icon patch.
; Match both icons so its extracted PE stub matches the native compiler's CRC.
; Keep CRC checking enabled. scripts/nsis-integrity.mjs validates BOTH layers.
!macro customHeader
  UninstallIcon "${MUI_ICON}"
!macroend
