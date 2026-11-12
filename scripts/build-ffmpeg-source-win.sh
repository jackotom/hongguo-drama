#!/usr/bin/env bash
# Ubuntu + mingw-w64 cross-build; no prebuilt third-party media libraries.
set -euo pipefail
ROOT=${1:?Usage: build-ffmpeg-source-win.sh BUILD_DIRECTORY [JOBS]}
JOBS=${2:-4}
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || exit 1
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
SCRIPT=$(realpath "$0")
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_TAR_SHA256=df62afece4eecef8ddf196f115dfec6e936a21b04ec2117a0f4e412de29b20e5
mkdir -p "$ROOT"/{archives,sources,build-x264,build-ffmpeg,prefix,logs,artifacts/bin,corresponding-source}
bash "$(dirname "$SCRIPT")/prepare-nv-codec-headers.sh" "$ROOT"
FFMPEG_ARCHIVE="$ROOT/archives/ffmpeg-$FFMPEG_VERSION.tar.xz"
X264_ARCHIVE="$ROOT/archives/x264-$X264_COMMIT.tar.gz"
[[ -f "$FFMPEG_ARCHIVE" ]] || curl -fL --retry 2 --silent --show-error "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$FFMPEG_ARCHIVE"
if [[ ! -f "$X264_ARCHIVE" ]]; then
  FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
  git -C "$FETCH_DIR" init --quiet
  git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
  git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" FETCH_HEAD | gzip -n > "$X264_ARCHIVE"
fi
printf '%s  %s\n' "$FFMPEG_SHA256" "$FFMPEG_ARCHIVE" | sha256sum -c -
# Verify exact tar bytes: BSD and GNU gzip may encode identical source differently.
[[ $(gzip -dc "$X264_ARCHIVE" | sha256sum | cut -d' ' -f1) == "$X264_TAR_SHA256" ]] || { echo 'x264 source tar checksum mismatch' >&2; exit 1; }
echo 'x264 source tar SHA256: OK'
[[ -d "$ROOT/sources/ffmpeg-$FFMPEG_VERSION" ]] || tar -xf "$FFMPEG_ARCHIVE" -C "$ROOT/sources"
[[ -d "$ROOT/sources/x264-$X264_COMMIT" ]] || tar -xf "$X264_ARCHIVE" -C "$ROOT/sources"
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$ROOT/prefix/lib/pkgconfig"
cd "$ROOT/build-x264"
# shortcut: portable C implementation; enable NASM when software-encoding speed needs tuning.
"../sources/x264-$X264_COMMIT/configure" --prefix=../prefix --host=x86_64-w64-mingw32 \
  --cross-prefix=x86_64-w64-mingw32- --enable-static --disable-asm --disable-cli \
  --disable-opencl --disable-avs --disable-swscale --disable-lavf --disable-ffms \
  --disable-gpac --disable-lsmash --disable-bashcompletion \
  --extra-ldflags=-static > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-ffmpeg"
"../sources/ffmpeg-$FFMPEG_VERSION/configure" --prefix=../prefix \
  --arch=x86_64 --target-os=mingw32 --enable-cross-compile --cross-prefix=x86_64-w64-mingw32- \
  --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug \
  --disable-ffplay --disable-network --disable-indevs --disable-outdevs --enable-indev=lavfi \
  --disable-x86asm --enable-gpl --enable-version3 --enable-libx264 \
  --enable-ffnvcodec --enable-nvenc --enable-encoder=h264_nvenc \
  --pkg-config=pkg-config --pkg-config-flags=--static \
  --extra-cflags=-I../prefix/include --extra-ldflags='-static -L../prefix/lib' \
  > "$ROOT/logs/ffmpeg-configure.log" 2>&1
make -j "$JOBS" ffmpeg.exe ffprobe.exe > "$ROOT/logs/ffmpeg-build.log" 2>&1
grep -q '^#define CONFIG_H264_NVENC_ENCODER 1' config_components.h
cp ffmpeg.exe ffprobe.exe "$ROOT/artifacts/bin/"
for tool in "$ROOT/artifacts/bin/"*.exe; do
  x86_64-w64-mingw32-objdump -p "$tool" > "$ROOT/logs/$(basename "$tool").imports.txt"
  # Reject accidental MinGW, pthread, codec or package-manager DLL dependencies.
  python3 - "$ROOT/logs/$(basename "$tool").imports.txt" <<'PY'
import re,sys
text=open(sys.argv[1]).read()
assert 'pei-x86-64' in text
deps=re.findall(r'DLL Name:\s*(\S+)',text)
allowed={'kernel32.dll','msvcrt.dll','user32.dll','advapi32.dll','bcrypt.dll','ole32.dll','shell32.dll','secur32.dll','ws2_32.dll','psapi.dll','vfw32.dll','gdi32.dll','winmm.dll','ntdll.dll'}
assert deps and all(d.lower() in allowed for d in deps), deps
print('Windows x64 system DLL check:', ', '.join(deps))
PY
done
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/"COPYING* "$ROOT/artifacts/bin/"
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/LICENSE.md" "$ROOT/artifacts/bin/"
cp "$ROOT/sources/x264-$X264_COMMIT/COPYING" "$ROOT/artifacts/bin/WINDOWS-X264-LICENSE.txt"
cp /usr/share/doc/mingw-w64-common/copyright "$ROOT/artifacts/bin/WINDOWS-MINGW-LICENSE.txt"
cp /usr/share/doc/gcc-mingw-w64-x86-64/copyright "$ROOT/artifacts/bin/WINDOWS-GCC-LICENSE.txt"
(cd "$ROOT/artifacts/bin" && sha256sum ffmpeg.exe ffprobe.exe) > "$ROOT/artifacts/bin/WINDOWS-SHA256SUMS.txt"
cp "$FFMPEG_ARCHIVE" "$X264_ARCHIVE" "$SCRIPT" "$ROOT/corresponding-source/"
cp "$ROOT/build-ffmpeg/ffbuild/config.log" "$ROOT/corresponding-source/ffmpeg-config.log"
cp "$ROOT/build-x264/config.log" "$ROOT/corresponding-source/x264-config.log"
{ x86_64-w64-mingw32-gcc --version; dpkg-query -W gcc-mingw-w64-x86-64 mingw-w64-common mingw-w64-x86-64-dev; } > "$ROOT/corresponding-source/TOOLCHAIN.txt"
cp "$ROOT/artifacts/bin/WINDOWS-SHA256SUMS.txt" "$ROOT/corresponding-source/"
cp "$ROOT/artifacts/bin/WINDOWS-"*-LICENSE.txt "$ROOT/corresponding-source/"
tar -czf "$ROOT/artifacts/ffmpeg-9.0.2-x264-b35605a-win-x64-corresponding-source.tar.gz" -C "$ROOT" corresponding-source
echo 'Built Windows x64 FFmpeg, FFprobe and complete corresponding source.'
