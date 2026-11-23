# SDK playback corresponding source

This directory contains the exact `phone_account` source subset used to build
the macOS arm64/x64 `hongguo-sdk-playback` executables shipped by this release.

Upstream reference:

- Project: `waligoraamodio288-rgb/hongguo-desktop-releases`
- Release: `v1.0.104`
- Archive: `hongguo-1.0.104-third-party-sources.zip`
- Previously verified archive SHA256:
  `beebd9847e3214ca280cfe71320fb89eb2d5b4db18659803a3404ddac75dd5db`
- Current archive SHA256 observed 2026-11-23:
  `7e6660313554ba388347397c1f551b93b419d27473c1f0718a5b76463b84d3b5`

The current upstream archive contains an older 74332 SDK-material set and is
not automatically accepted. The vendored 74532 source subset is retained as
the build input for the tested release executable. The git commit containing
this file and the release `SHA256SUMS.txt` bind the exact bytes and build.

Third-party licenses and attribution are recorded in the repository's
`THIRD-PARTY-NOTICES.md` and the release source archive.
