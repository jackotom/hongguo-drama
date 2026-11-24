#!/bin/sh
set -eu

ROOT="$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)"
WORK="$ROOT/build/sdk-playback"
STAGE="$ROOT/build/sdk-playback-work"
ARCH="${1:-$(uname -m)}"
PYTHON="${PYTHON:-python3.11}"
SOURCE_SHA="beebd9847e3214ca280cfe71320fb89eb2d5b4db18659803a3404ddac75dd5db"
SOURCE_URL="https://github.com/waligoraamodio288-rgb/hongguo-desktop-releases/releases/download/v1.0.104/hongguo-1.0.104-third-party-sources.zip"

if [ "$(uname -s)" != "Darwin" ]; then
    printf '%s\n' "This helper build currently supports macOS only." >&2
    exit 1
fi
if [ "$ARCH" != "arm64" ] && [ "$ARCH" != "x64" ]; then
    printf '%s\n' "Architecture must be arm64 or x64." >&2
    exit 1
fi
# `uname -m` reports x86_64 on Intel and under Rosetta, while this script names the target x64.
TARGET_ARCH="$ARCH"
if [ "$ARCH" = "x64" ]; then
    TARGET_ARCH="x86_64"
fi
if [ "$TARGET_ARCH" != "$(uname -m)" ]; then
    printf '%s\n' "Build $ARCH on a matching host architecture." >&2
    exit 1
fi
PYTHON_ARCH="$("$PYTHON" -c 'import platform; print(platform.machine())')"
if [ "$PYTHON_ARCH" != "$TARGET_ARCH" ]; then
    printf '%s\n' "Python architecture $PYTHON_ARCH does not match target $TARGET_ARCH." >&2
    exit 1
fi

command -v "$PYTHON" >/dev/null
mkdir -p "$STAGE/source" "$STAGE/build-$ARCH" "$WORK/darwin-$ARCH"
ARCHIVE="$STAGE/source/hongguo-1.0.104-third-party-sources.zip"
VENDOR="$ROOT/scripts/sdk-playback/vendor/phone_account"

BUILD_ROOT="$STAGE/build-$ARCH"
rm -rf "$BUILD_ROOT/phone_account"
if [ -d "$VENDOR" ]; then
    cp -R "$VENDOR" "$BUILD_ROOT/phone_account"
else
    if [ ! -f "$ARCHIVE" ]; then
        curl -L --fail --silent --show-error "$SOURCE_URL" -o "$ARCHIVE"
    fi
    if ! printf '%s  %s\n' "$SOURCE_SHA" "$ARCHIVE" | shasum -a 256 -c -; then
        rm -f "$ARCHIVE"
        exit 1
    fi
    rm -rf "$STAGE/source/expanded"
    mkdir -p "$STAGE/source/expanded"
    ditto -x -k "$ARCHIVE" "$STAGE/source/expanded"
    cp -R "$STAGE/source/expanded/desktop-app-1.0.59/source-tree/work/library-search/scripts/phone-account-protocol" "$BUILD_ROOT/phone_account"
    cp "$STAGE/source/expanded/desktop-account-1.0.19/medusa_wire_tables.json" "$BUILD_ROOT/phone_account/"
fi
cp "$ROOT/scripts/sdk-playback/resolve_cli.py" "$BUILD_ROOT/resolve_cli.py"

rm -rf "$STAGE/venv-$ARCH"
"$PYTHON" -m venv "$STAGE/venv-$ARCH"
"$STAGE/venv-$ARCH/bin/pip" install --quiet \
    pyinstaller==6.22.3 unicorn==2.1.4 requests==2.34.2 pycryptodome==4.6.0

(
    cd "$BUILD_ROOT"
    "$STAGE/venv-$ARCH/bin/pyinstaller" --noconfirm --clean --onefile \
        --name hongguo-sdk-playback \
        --collect-all unicorn --collect-all Crypto \
        --paths "$BUILD_ROOT/phone_account" \
        --add-data "$BUILD_ROOT/phone_account/vendor:vendor" \
        --add-data "$BUILD_ROOT/phone_account/medusa_wire_tables.json:." \
        "$BUILD_ROOT/resolve_cli.py"
)

cp "$BUILD_ROOT/dist/hongguo-sdk-playback" "$WORK/darwin-$ARCH/hongguo-sdk-playback"
chmod 755 "$WORK/darwin-$ARCH/hongguo-sdk-playback"
printf '%s\n' "$WORK/darwin-$ARCH/hongguo-sdk-playback"
