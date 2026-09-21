!include "MUI2.nsh"
Name "InkNest probe"
OutFile "probe-installer.exe"
SetCompressor zlib
RequestExecutionLevel user
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
!ifdef SAME_ICON
UninstallIcon "${MUI_ICON}"
!endif
Section
WriteUninstaller "$TEMP\probe-uninstall.exe"
SectionEnd
Section "Uninstall"
SectionEnd
