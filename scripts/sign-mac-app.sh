#!/bin/sh
# Sign a built macOS app bundle bottom-up with a Developer ID identity.
# `codesign --deep` alone leaves binaries under Contents/Resources (ffmpeg,
# librempeg, the SDK playback helper) ad-hoc signed, which Apple's notary
# service rejects. Sign every Mach-O file first, then the bundles, then the app.
set -eu

APP="${1:?usage: sign-mac-app.sh <app> <identity>}"
SIGN_ID="${2:?usage: sign-mac-app.sh <app> <identity>}"

if [ ! -d "$APP" ]; then
    printf '%s\n' "App bundle not found: $APP" >&2
    exit 1
fi

# Apple's timestamp service intermittently returns "not available"; retry.
sign_path() {
    attempt=1
    while [ "$attempt" -le 4 ]; do
        if codesign --force --options runtime --timestamp --sign "$SIGN_ID" "$1"; then
            return 0
        fi
        printf '%s\n' "retry $attempt: $1" >&2
        attempt=$((attempt + 1))
        sleep 3
    done
    return 1
}

find "$APP/Contents" -type f -print0 | while IFS= read -r -d '' file; do
    if file -b "$file" | grep -q 'Mach-O'; then
        sign_path "$file" || exit 1
    fi
done

for bundle in "$APP/Contents/Frameworks/"*.framework "$APP/Contents/Frameworks/"*.app; do
    [ -e "$bundle" ] || continue
    sign_path "$bundle" || exit 1
done

sign_path "$APP"
codesign --verify --deep --strict --verbose=2 "$APP"
