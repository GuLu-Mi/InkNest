# NSIS extraction regression fixtures

Generated locally with pinned electron-builder NSIS toolset 1.2.1 (NSIS 3.12) from `probe.nsi`. The script's uninstall section is empty. These binaries are test data, never executed by tests.

Compile without SAME_ICON then extract with app-builder-lib 26.15.3 `UninstallerReader.exec` to obtain `bad-icon-uninstaller.exe`; compile with `-DSAME_ICON` then extract to obtain `valid-uninstaller.exe`. Only the icon setting differs. The first file retains a CRC for the icon-patched native stub, while the Mac extractor copied the original stub.

NSIS stub: Copyright Nullsoft and Contributors, zlib/libpng license. The unmodified toolset license is included as [LICENSE.NSIS.txt](LICENSE.NSIS.txt); file identities are listed in [SHA256SUMS](SHA256SUMS). See the [official NSIS license appendix](https://nsis.sourceforge.io/Docs/AppendixI.html). `scripts/nsis-integrity.mjs` follows the native CRC range in https://github.com/kichik/nsis/blob/master/Source/exehead/fileform.c, not a checksum chosen to fit this fixture.

The included files are locally generated regression data, not production installers. `bad-icon-uninstaller.exe` deliberately preserves the extractor-induced icon/CRC mismatch; it is not represented as an unmodified upstream executable. `probe.nsi` selects zlib compression, and its uninstall section is empty. No test executes either executable.

`extraction-installer.exe` is compiled with the same NSIS toolset from `extraction.nsi`. It contains the existing `valid-uninstaller.exe` as `Uninstall InkNest.exe`, including the space in its name. Tests extract it with the platform's real tool and compare its identity and CRC. On Windows, tests also confirm that builder's limited `7za.exe` is rejected instead of being mistaken for an NSIS extractor. Generate with `makensis extraction.nsi` from this directory; no installer is executed.
