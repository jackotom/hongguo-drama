#!/usr/bin/env bash
# Linux x64 tools, built on Ubuntu 22.04 or newer from the same pinned source as Windows.
set -euo pipefail
[[ $(uname -s) == Linux && $(uname -m) == x86_64 ]] || { echo 'Requires Linux x64' >&2; exit 1; }
ROOT=${1:?Usage: build-ffmpeg-source-linux.sh BUILD_DIRECTORY [JOBS]}
JOBS=${2:-4}
[[ "$JOBS" =~ ^[1-9][0-9]*$ ]] || exit 1
SCRIPT=$(realpath "$0")
mkdir -p "$ROOT"
ROOT=$(cd "$ROOT" && pwd)
FFMPEG_VERSION=9.0.2
FFMPEG_SHA256=8c3850283eb25fa026482078a04051e0be17347b09ef81a0849bec15a96e002e
X264_COMMIT=b35605ace3ddf7c1a5d67a2eb553f034aef41d55
X264_SHA256=df62afece4eecef8ddf196f115dfec6e936a21b04ec2117a0f4e412de29b20e5
mkdir -p "$ROOT"/{archives,sources,prefix,build-x264,build-ffmpeg,logs,artifacts/bin,corresponding-source}
bash "$(dirname "$SCRIPT")/prepare-nv-codec-headers.sh" "$ROOT"
FFMPEG_ARCHIVE="$ROOT/archives/ffmpeg-$FFMPEG_VERSION.tar.xz"
X264_ARCHIVE="$ROOT/archives/x264-$X264_COMMIT.tar.gz"
[[ -f "$FFMPEG_ARCHIVE" ]] || curl -fsSL --retry 2 "https://ffmpeg.org/releases/ffmpeg-$FFMPEG_VERSION.tar.xz" -o "$FFMPEG_ARCHIVE"
if [[ ! -f "$X264_ARCHIVE" ]]; then
  FETCH_DIR=$(mktemp -d "$ROOT/x264-fetch.XXXXXX")
  git -C "$FETCH_DIR" init --quiet
  git -C "$FETCH_DIR" fetch --quiet --depth 1 https://code.videolan.org/videolan/x264.git "$X264_COMMIT"
  git -C "$FETCH_DIR" archive --format=tar --prefix="x264-$X264_COMMIT/" FETCH_HEAD | gzip -n > "$X264_ARCHIVE"
fi
printf '%s  %s\n' "$FFMPEG_SHA256" "$FFMPEG_ARCHIVE" | sha256sum -c -
[[ $(gzip -dc "$X264_ARCHIVE" | sha256sum | cut -d' ' -f1) == "$X264_SHA256" ]] || exit 1
[[ -d "$ROOT/sources/ffmpeg-$FFMPEG_VERSION" ]] || tar -xf "$FFMPEG_ARCHIVE" -C "$ROOT/sources"
[[ -d "$ROOT/sources/x264-$X264_COMMIT" ]] || tar -xf "$X264_ARCHIVE" -C "$ROOT/sources"
export PKG_CONFIG_PATH=
export PKG_CONFIG_LIBDIR="$ROOT/prefix/lib/pkgconfig"
cd "$ROOT/build-x264"
"../sources/x264-$X264_COMMIT/configure" --prefix=../prefix --host=x86_64-linux-gnu \
  --enable-static --enable-pic --disable-cli --disable-opencl --disable-avs \
  --disable-swscale --disable-lavf --disable-ffms --disable-gpac --disable-lsmash \
  > "$ROOT/logs/x264-configure.log" 2>&1
make -j "$JOBS" > "$ROOT/logs/x264-build.log" 2>&1
make install-lib-static > "$ROOT/logs/x264-install.log" 2>&1
cd "$ROOT/build-ffmpeg"
"../sources/ffmpeg-$FFMPEG_VERSION/configure" --prefix=../prefix --arch=x86_64 --target-os=linux \
  --disable-autodetect --disable-shared --enable-static --disable-doc --disable-debug \
  --disable-ffplay --disable-network --disable-indevs --disable-outdevs --enable-indev=lavfi \
  --enable-gpl --enable-version3 --enable-libx264 --pkg-config=pkg-config --pkg-config-flags=--static \
  --enable-ffnvcodec --enable-nvenc --enable-encoder=h264_nvenc \
  --extra-cflags=-I../prefix/include --extra-ldflags=-L../prefix/lib \
  > "$ROOT/logs/ffmpeg-configure.log" 2>&1
make -j "$JOBS" ffmpeg ffprobe > "$ROOT/logs/ffmpeg-build.log" 2>&1
install -m 755 ffmpeg ffprobe "$ROOT/artifacts/bin/"
"$ROOT/artifacts/bin/ffmpeg" -hide_banner -encoders 2>/dev/null | awk '$2 == "h264_nvenc" { found=1 } END { exit !found }'
for tool in ffmpeg ffprobe; do
  ldd "$ROOT/artifacts/bin/$tool" > "$ROOT/logs/$tool.imports.txt"
  ! grep -q 'not found' "$ROOT/logs/$tool.imports.txt"
done
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/"COPYING* "$ROOT/artifacts/bin/"
cp "$ROOT/sources/ffmpeg-$FFMPEG_VERSION/LICENSE.md" "$ROOT/artifacts/bin/"
cp "$ROOT/sources/x264-$X264_COMMIT/COPYING" "$ROOT/artifacts/bin/LINUX-X264-LICENSE.txt"
cp "$FFMPEG_ARCHIVE" "$X264_ARCHIVE" "$SCRIPT" "$ROOT/corresponding-source/"
cp "$ROOT/build-ffmpeg/ffbuild/config.log" "$ROOT/corresponding-source/ffmpeg-config.log"
cp "$ROOT/build-x264/config.log" "$ROOT/corresponding-source/x264-config.log"
gcc --version > "$ROOT/corresponding-source/TOOLCHAIN.txt"
tar -czf "$ROOT/artifacts/ffmpeg-9.0.2-x264-b35605a-linux-x64-corresponding-source.tar.gz" -C "$ROOT" corresponding-source
echo 'PASS Linux x64 FFmpeg/FFprobe and corresponding source built'
