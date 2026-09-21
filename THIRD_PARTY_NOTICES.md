# Third-party materials

InkNest currently declares UNLICENSED. The following materials retain their own notices and are not relicensed by that declaration.

## NSIS regression fixtures

`tests/fixtures/nsis/valid-uninstaller.exe` and `bad-icon-uninstaller.exe` were generated locally from the included `probe.nsi` with electron-builder NSIS toolset 1.2.1 / NSIS 3.12. `extraction-installer.exe` was generated from `extraction.nsi` with the same toolset and contains the valid uninstaller as an extraction sample. They contain NSIS stub code and use zlib compression. They are test data and are never executed by the tests.

Copyright (C) 1999–2026 NSIS Contributors. The full, unchanged license supplied by that pinned toolset is included as [LICENSE.NSIS.txt](tests/fixtures/nsis/LICENSE.NSIS.txt). The [official license appendix](https://nsis.sourceforge.io/Docs/AppendixI.html) describes the applicable NSIS and compression-module licenses. Fixture provenance, the intentionally invalid extraction result, and checksums are documented [with the fixtures](tests/fixtures/nsis/README.md).

## Dependencies installed by npm

JavaScript packages, Electron, sharp and platform libraries are installed from the locked dependencies and are not vendored into this source repository. Top-level versions and package license declarations are listed in [dependencies.md](docs/dependencies.md). Dependency packages retain their own LICENSE/NOTICE files.

A binary application distribution includes additional third-party components. Its release review must retain the notices for the actual Electron/Chromium, sharp/libvips and codec payloads; this source-repository notice is not a complete notice bundle for an installer.

## Other fixed fixtures

The small images and large viewer checkerboard were generated locally from fixed data; their origins are described in [the image fixture README](tests/fixtures/images/README.md). Markdown and encoding samples are fixed test data, not user documents or recovery drafts.
