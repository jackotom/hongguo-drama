#!/bin/sh
# Sign a built macOS app bundle bottom-up with a Developer ID identity.
# `codesign --deep` alone leaves binaries under Contents/Resources (ffmpeg,
# librempeg, the SDK playback helper) ad-hoc signed, which Apple's notary
# service rejects. Sign every Mach-O file first, then the bundles, then the app.
set -eu

APP="${1:?usage: sign-mac-app.sh <app> <identity>}"
SIGN_ID="${2:?usage: sign-mac-app.sh <app> <identity>}"
SCRIPT_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
ENTITLEMENTS="$SCRIPT_DIR/../build/entitlements.mac.plist"
INHERIT_ENTITLEMENTS="$SCRIPT_DIR/../build/entitlements.mac.inherit.plist"

if [ ! -d "$APP" ]; then
    printf '%s\n' "App bundle not found: $APP" >&2
    exit 1
fi
if [ ! -f "$ENTITLEMENTS" ] || [ ! -f "$INHERIT_ENTITLEMENTS" ]; then
    printf '%s\n' "Missing macOS entitlements files" >&2
    exit 1
fi

# Apple's timestamp service intermittently returns "not available"; retry.
sign_path() {
    target="$1"
    entitlements="${2:-}"
    attempt=1
    while [ "$attempt" -le 4 ]; do
        if [ -n "$entitlements" ]; then
            if codesign --force --options runtime --timestamp --entitlements "$entitlements" --sign "$SIGN_ID" "$target"; then
                return 0
            fi
        elif codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$target"; then
            return 0
        fi
        printf '%s\n' "retry $attempt: $target" >&2
        attempt=$((attempt + 1))
        sleep 3
    done
    return 1
}

find "$APP/Contents" -type f -print0 | while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q 'Mach-O'; then
        case "$file" in
            "$APP"/Contents/MacOS/*|*/Contents/MacOS/*|*/hongguo-sdk-playback)
                sign_path "$file" "$INHERIT_ENTITLEMENTS" || exit 1
                ;;
            *)
                sign_path "$file" || exit 1
                ;;
        esac
    fi
done

for bundle in "$APP/Contents/Frameworks/"*.framework "$APP/Contents/Frameworks/"*.app; do
    [ -e "$bundle" ] || continue
    case "$bundle" in
        *.app) sign_path "$bundle" "$INHERIT_ENTITLEMENTS" || exit 1 ;;
        *) sign_path "$bundle" || exit 1 ;;
    esac
done

sign_path "$APP" "$ENTITLEMENTS"
codesign --verify --deep --strict --verbose=2 "$APP"
