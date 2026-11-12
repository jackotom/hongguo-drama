#!/usr/bin/env bash
# Headers only; NVENC loads the user's existing NVIDIA driver dynamically.
set -euo pipefail
ROOT=${1:?Usage: prepare-nv-codec-headers.sh BUILD_DIRECTORY}
SCRIPT=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
COMMIT=1889e62e2d35ff7aa9baca2bceb14f053785e6f1
SHA256=e30d4791fd386de8b5c9f88dec781e546ec148b8808440dd421da5f26c2700ae
mkdir -p "$ROOT"/{archives,sources,prefix,artifacts/bin,corresponding-source}
ROOT=$(cd "$ROOT" && pwd)
ARCHIVE="$ROOT/archives/nv-codec-headers-$COMMIT.tar.gz"
[[ -f "$ARCHIVE" ]] || curl -fsSL --retry 2 "https://codeload.github.com/FFmpeg/nv-codec-headers/tar.gz/$COMMIT" -o "$ARCHIVE"
python3 - "$ARCHIVE" "$SHA256" <<'PY'
import hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == sys.argv[2], 'NVIDIA codec headers archive mismatch'
PY
[[ -d "$ROOT/sources/nv-codec-headers-$COMMIT" ]] || tar -xzf "$ARCHIVE" -C "$ROOT/sources"
make -s -C "$ROOT/sources/nv-codec-headers-$COMMIT" PREFIX="$ROOT/prefix" install
cp "$ARCHIVE" "$SCRIPT" "$ROOT/corresponding-source/"
# Every header carries its own MIT notice; preserve each complete notice.
python3 - "$ROOT" "$COMMIT" <<'PY'
import pathlib, sys
root = pathlib.Path(sys.argv[1])
source = root / 'sources' / ('nv-codec-headers-' + sys.argv[2])
notices = ['NVIDIA codec headers 12.1.14.0\nOfficial source: https://github.com/FFmpeg/nv-codec-headers\nPinned commit: ' + sys.argv[2] + '\nNo NVIDIA runtime or driver is bundled.\n']
for header in sorted((source / 'include/ffnvcodec').glob('*.h')):
    text = header.read_text()
    notice = text[text.index('/*'):text.index('*/') + 2]
    assert 'Copyright' in notice and 'Permission' in notice, header.name
    notices.append(header.name + '\n' + notice)
(root / 'artifacts/bin/NV-CODEC-HEADERS-LICENSE.txt').write_text('\n\n'.join(notices) + '\n')
PY
cp "$ROOT/artifacts/bin/NV-CODEC-HEADERS-LICENSE.txt" "$ROOT/corresponding-source/"
