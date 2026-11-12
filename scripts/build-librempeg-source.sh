#!/usr/bin/env bash
# Build the ByteVC2-only helper from pinned upstream source; normal media stays on FFmpeg.
set -euo pipefail
ROOT=${1:?Usage: build-librempeg-source.sh BUILD_DIRECTORY arm64|x64|win-x64|linux-x64 [JOBS]}
TARGET=${2:?Missing target}
JOBS=${3:-4}
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || exit 1
case "$TARGET" in arm64|x64) [[ $(uname -s) == Darwin ]] || exit 1;; win-x64) command -v x86_64-w64-mingw32-gcc >/dev/null;; linux-x64) [[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || exit 1;; *) exit 1;; esac
SCRIPT=$(cd "$(dirname "$0")" && pwd)/$(basename "$0")
VT_PATCH="$(dirname "$SCRIPT")/librempeg-videotoolbox-prototype.patch"
LIBREMPEG_COMMIT=cb1f8f3eef84999e61b27e2d44664858179bc240
LIBREMPEG_SHA256=fd965e6ef9f745af96142cf118d7c2aa0dce906225c9d3cd2ef19e0221723813
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_TAR_SHA256=df62afece4eecef8ddf196f115dfec6e936a21b04ec2117a0f4e412de29b20e5
PKG_CONFIG_TOOL=$(command -v pkg-config)
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
mkdir -p "$ROOT"/{archives,sources,prefix,build-x264,build-librempeg,logs,artifacts/bin,corresponding-source}
if [[ "$TARGET" == win-x64 || "$TARGET" == linux-x64 ]]; then
  bash "$(dirname "$SCRIPT")/prepare-nv-codec-headers.sh" "$ROOT"
fi
LIBREMPEG_ARCHIVE="$ROOT/archives/librempeg-$LIBREMPEG_COMMIT.tar.gz"
X264_ARCHIVE="$ROOT/archives/x264-$X264_COMMIT.tar.gz"
[[ -f "$LIBREMPEG_ARCHIVE" ]] || curl -fsSL --retry 2 "https://codeload.github.com/librempeg/librempeg/tar.gz/$LIBREMPEG_COMMIT" -o "$LIBREMPEG_ARCHIVE"
if [[ ! -f "$X264_ARCHIVE" ]]; then
  FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
  git -C "$FETCH_DIR" init --quiet
  git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
  git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" FETCH_HEAD | gzip -n > "$X264_ARCHIVE"
fi
python3 - "$LIBREMPEG_ARCHIVE" "$LIBREMPEG_SHA256" "$X264_ARCHIVE" "$X264_TAR_SHA256" <<'PY'
import gzip, hashlib, pathlib, sys
assert hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest() == sys.argv[2], 'Librempeg archive mismatch'
assert hashlib.sha256(gzip.decompress(pathlib.Path(sys.argv[3]).read_bytes())).hexdigest() == sys.argv[4], 'x264 source mismatch'
PY
[[ -d "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT" ]] || tar -xzf "$LIBREMPEG_ARCHIVE" -C "$ROOT/sources"
[[ -d "$ROOT/sources/x264-$X264_COMMIT" ]] || tar -xzf "$X264_ARCHIVE" -C "$ROOT/sources"
# The pinned upstream VideoToolbox implementation omits its internal declaration.
if [[ "$TARGET" == arm64 || "$TARGET" == x64 ]]; then
  if ! grep -q '^int ff_videotoolbox_buffer_append(' "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/libavcodec/vt_internal.h"; then
    patch --batch --forward -p1 -d "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT" < "$VT_PATCH" > "$ROOT/logs/videotoolbox-patch.log" 2>&1
  fi
  grep -q '^int ff_videotoolbox_buffer_append(' "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/libavcodec/vt_internal.h"
fi
ENCODERS=libx264,aac
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$ROOT/prefix/lib/pkgconfig"
unset CPATH C_INCLUDE_PATH CPLUS_INCLUDE_PATH LIBRARY_PATH DYLD_LIBRARY_PATH LDFLAGS CFLAGS CPPFLAGS || true
if [[ "$TARGET" == win-x64 ]]; then
  ENCODERS+=,h264_nvenc
  THREAD_ARGS=(--enable-w32threads --disable-pthreads)
  X264_ARGS=(--host=x86_64-w64-mingw32 --cross-prefix=x86_64-w64-mingw32- --disable-asm --extra-ldflags=-static)
  MEDIA_ARGS=(--arch=x86_64 --target-os=mingw32 --enable-cross-compile --cross-prefix=x86_64-w64-mingw32- --disable-asm --extra-cflags=-I../prefix/include --extra-ldflags='-static -L../prefix/lib')
  MEDIA_ARGS+=(--enable-ffnvcodec --enable-nvenc)
  SUFFIX=.exe
elif [[ "$TARGET" == linux-x64 ]]; then
  ENCODERS+=,h264_nvenc
  THREAD_ARGS=(--enable-pthreads)
  X264_ARGS=(--host=x86_64-linux-gnu)
  MEDIA_ARGS=(--arch=x86_64 --target-os=linux --extra-cflags=-I../prefix/include --extra-ldflags=-L../prefix/lib)
  MEDIA_ARGS+=(--enable-ffnvcodec --enable-nvenc)
  SUFFIX=
else
  THREAD_ARGS=(--enable-pthreads)
  export PATH=/usr/bin:/bin:/usr/sbin:/sbin
  export CC=/usr/bin/clang
  export SDKROOT
  SDKROOT=$(xcrun --sdk macosx --show-sdk-path)
  export MACOSX_DEPLOYMENT_TARGET=13.0
  ARCH=arm64; HOST=aarch64
  [[ "$TARGET" != x64 ]] || { ARCH=x86_64; HOST=x86_64; }
  X264_ARGS=(--host="$HOST-apple-darwin" --extra-cflags="-arch $ARCH -mmacosx-version-min=13.0" --extra-ldflags="-arch $ARCH -mmacosx-version-min=13.0")
  [[ "$TARGET" != x64 ]] || X264_ARGS+=(--disable-asm)
  MEDIA_ARGS=(--arch="$HOST" --target-os=darwin --cc=/usr/bin/clang --extra-cflags="-arch $ARCH -mmacosx-version-min=13.0 -I../prefix/include" --extra-ldflags="-arch $ARCH -mmacosx-version-min=13.0 -L../prefix/lib")
  # Librempeg's x86 init objects require standalone assembly; use its complete C fallback without NASM.
  [[ "$TARGET" != x64 ]] || MEDIA_ARGS+=(--disable-asm)
  ENCODERS+=,h264_videotoolbox
  MEDIA_ARGS+=(--enable-videotoolbox)
  SUFFIX=
fi
cd "$ROOT/build-x264"
"../sources/x264-$X264_COMMIT/configure" --prefix=../prefix "${X264_ARGS[@]}" \
  --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs --disable-swscale \
  --disable-lavf --disable-ffms --disable-gpac --disable-lsmash --disable-bashcompletion > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-librempeg"
"../sources/librempeg-$LIBREMPEG_COMMIT/configure" --prefix=../prefix "${MEDIA_ARGS[@]}" \
  --disable-everything --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug \
  --disable-ffplay --disable-network --enable-ffmpeg --enable-ffprobe "${THREAD_ARGS[@]}" \
  --enable-protocol=file,pipe --enable-demuxer=mov --enable-muxer=mp4,null \
  --enable-decoder=bvc2,vvc,aac --enable-parser=aac --enable-encoder="$ENCODERS" \
  --enable-filter=scale,format,aformat,null,anull \
  --enable-agpl --enable-gpl --enable-version3 --enable-libx264 --pkg-config="$PKG_CONFIG_TOOL" --pkg-config-flags=--static \
  > "$ROOT/logs/librempeg-configure.log" 2>&1
make -j "$JOBS" "ffmpeg$SUFFIX" > "$ROOT/logs/librempeg-build.log" 2>&1
install -m 755 "ffmpeg$SUFFIX" "$ROOT/artifacts/bin/librempeg$SUFFIX"
TOOL="$ROOT/artifacts/bin/librempeg$SUFFIX"
if [[ "$TARGET" == win-x64 ]]; then
  x86_64-w64-mingw32-objdump -p "$TOOL" > "$ROOT/logs/imports.txt"
  python3 - "$ROOT/logs/imports.txt" <<'PY'
import pathlib, re, sys
s = pathlib.Path(sys.argv[1]).read_text()
allowed = {'kernel32.dll','msvcrt.dll','user32.dll','advapi32.dll','bcrypt.dll','ole32.dll','shell32.dll','secur32.dll','ws2_32.dll','psapi.dll','vfw32.dll','gdi32.dll','winmm.dll','ntdll.dll'}
assert 'pei-x86-64' in s
assert all(x.lower() in allowed for x in re.findall(r'DLL Name:\s*(\S+)', s))
PY
  grep -q '^#define CONFIG_H264_NVENC_ENCODER 1' config_components.h
elif [[ "$TARGET" == linux-x64 ]]; then
  ldd "$TOOL" > "$ROOT/logs/imports.txt"
  ! grep -q 'not found' "$ROOT/logs/imports.txt"
  "$TOOL" -hide_banner -decoders 2>/dev/null | awk '$2 == "bvc2" { found=1 } END { exit !found }'
  "$TOOL" -hide_banner -encoders 2>/dev/null | awk '$2 == "h264_nvenc" { found=1 } END { exit !found }'
else
  lipo "$TOOL" -verify_arch "$ARCH"
  otool -L "$TOOL" | tail -n +2 | awk '{print $1}' | while IFS= read -r dep; do
    case "$dep" in /usr/lib/*|/System/Library/*) ;; *) echo 'Non-system helper dependency' >&2; exit 1;; esac
  done
  "$TOOL" -hide_banner -decoders 2>/dev/null | awk '$2 == "bvc2" { found=1 } END { exit !found }'
  "$TOOL" -hide_banner -encoders 2>/dev/null | awk '$2 == "h264_videotoolbox" { found=1 } END { exit !found }'
fi
cp "$LIBREMPEG_ARCHIVE" "$X264_ARCHIVE" "$SCRIPT" "$VT_PATCH" "$ROOT/corresponding-source/"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/COPYING.GPLv3" "$ROOT/artifacts/bin/LIBREMPEG-COPYING.GPLv3"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/COPYING.AGPLv3" "$ROOT/artifacts/bin/LIBREMPEG-COPYING.AGPLv3"
cp "$ROOT/sources/librempeg-$LIBREMPEG_COMMIT/LICENSE.md" "$ROOT/artifacts/bin/LIBREMPEG-LICENSE.md"
cp "$ROOT/sources/x264-$X264_COMMIT/COPYING" "$ROOT/artifacts/bin/LIBREMPEG-X264-LICENSE.txt"
python3 - "$ROOT" "$TARGET" <<'PY'
import gzip, pathlib, sys, tarfile
root = pathlib.Path(sys.argv[1])
target = root / 'artifacts' / ('librempeg-cb1f8f3-x264-b35605a-' + sys.argv[2] + '-corresponding-source.tar.gz')
def public_metadata(info):
    info.uid = info.gid = info.mtime = 0
    info.uname = info.gname = ''
    return info
with target.open('wb') as raw, gzip.GzipFile(fileobj=raw, filename='', mode='wb', mtime=0) as compressed:
    with tarfile.open(fileobj=compressed, mode='w') as archive:
        archive.add(root / 'corresponding-source', arcname='corresponding-source', filter=public_metadata)
PY
echo "PASS pinned ByteVC2 helper built for $TARGET with system-only runtime dependencies"
