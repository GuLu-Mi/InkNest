; Data-only extraction fixture; tests never execute either executable.
Name "InkNest NSIS extraction probe"
OutFile "extraction-installer.exe"
SetCompressor zlib
RequestExecutionLevel user
Section
  SetOutPath "$INSTDIR"
  File "/oname=Uninstall InkNest.exe" "valid-uninstaller.exe"
SectionEnd
