#!/usr/bin/env bash
# AMD AMF headers only; the encoder loads the user's existing AMD driver at runtime.
set -euo pipefail
ROOT=${1:?Usage: prepare-amf-headers.sh BUILD_DIRECTORY}
SCRIPT=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
COMMIT=57ee0cfb0e1a08d9041f77435653794c1b012be0
VERSION=v1.5.3
HEADERS_SHA256=0f521ad98041f8001147cded4a660127f18b1c27a801a5cd691bda1fa48381be
LICENSE_SHA256=eb297397aaa455b5668ab67d216b83828466152dab123fa92384c6ec16b74170
mkdir -p "$ROOT"/{archives,sources,prefix,artifacts/bin,corresponding-source}
ROOT=$(cd "$ROOT" && pwd)
ARCHIVE="$ROOT/archives/AMF-headers-$VERSION.tar.gz"
[[ -f "$ARCHIVE" ]] || curl -fsSL --retry 2 "https://github.com/GPUOpen-LibrariesAndSDKs/AMF/releases/download/$VERSION/AMF-headers-$VERSION.tar.gz" -o "$ARCHIVE"
python3 - "$ARCHIVE" "$HEADERS_SHA256" <<'PY'
import hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == sys.argv[2], 'AMF headers archive mismatch'
PY
[[ -d "$ROOT/sources/amf-headers-$VERSION" ]] || tar -xzf "$ARCHIVE" -C "$ROOT/sources"
# FFmpeg and Librempeg configure gate --enable-amf on AMF/core/Version.h.
grep -q 'AMF_VERSION_MAJOR' "$ROOT/sources/amf-headers-$VERSION/AMF/core/Version.h"
test -f "$ROOT/sources/amf-headers-$VERSION/AMF/core/Factory.h"
test -f "$ROOT/sources/amf-headers-$VERSION/AMF/components/VideoEncoderVCE.h"
mkdir -p "$ROOT/prefix/include"
cp -R "$ROOT/sources/amf-headers-$VERSION/AMF" "$ROOT/prefix/include/"
LICENSE="$ROOT/archives/AMF-LICENSE.txt"
[[ -f "$LICENSE" ]] || curl -fsSL --retry 2 "https://raw.githubusercontent.com/GPUOpen-LibrariesAndSDKs/AMF/$COMMIT/LICENSE.txt" -o "$LICENSE"
python3 - "$LICENSE" "$LICENSE_SHA256" <<'PY'
import hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == sys.argv[2], 'AMF license mismatch'
PY
cp "$LICENSE" "$ROOT/artifacts/bin/WINDOWS-AMF-LICENSE.txt"
cp "$ARCHIVE" "$SCRIPT" "$LICENSE" "$ROOT/corresponding-source/"
