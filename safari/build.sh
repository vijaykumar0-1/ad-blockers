#!/bin/bash
# Builds LocalBlock for Safari on this Mac, installs it in ~/Applications and opens it so
# Safari can find the extension.
#
# Needs: macOS with Safari 26 or later, Xcode (from the App Store; the Command Line Tools
# alone don't include the converter), and Node.js 20+.
#
# Signing: if Xcode has an Apple ID signed in (a free one is enough: Xcode > Settings >
# Accounts), the app is signed with its "Apple Development" certificate and Safari keeps
# LocalBlock enabled across restarts. Without one, the app is unsigned and Safari only
# shows it while "Allow unsigned extensions" is ticked, which resets whenever Safari quits.
#
# Usage: bash safari/build.sh
#   TEAM_ID=XXXXXXXXXX bash safari/build.sh   use a specific team instead of detecting it
#   UNSIGNED=1 bash safari/build.sh           skip signing
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode is required (the full app from the App Store, not just the Command Line Tools)."
  echo "After installing it, run: sudo xcode-select -s /Applications/Xcode.app"
  exit 1
fi

# Find the team of an "Apple Development" certificate in the keychain (its subject's OU).
detect_team() {
  security find-certificate -c "Apple Development" -p 2>/dev/null \
    | openssl x509 -noout -subject 2>/dev/null \
    | sed -n 's/.*OU *= *\([A-Z0-9]\{10\}\).*/\1/p' | head -1
}

TEAM="${TEAM_ID:-}"
if [ -z "$TEAM" ] && [ -z "${UNSIGNED:-}" ]; then TEAM="$(detect_team || true)"; fi

# A personal team needs a bundle identifier no one else has registered, so make it per user.
USER_ID=$(whoami | tr -cd 'a-zA-Z0-9' | tr 'A-Z' 'a-z')
BUNDLE_ID="${BUNDLE_ID:-com.${USER_ID:-local}.localblock}"

node tools/build-safari.mjs

# Wrap the extension in a Mac app (the converter writes an Xcode project).
rm -rf safari/xcode
xcrun safari-web-extension-converter dist/safari \
  --project-location safari/xcode \
  --app-name LocalBlock \
  --bundle-identifier "$BUNDLE_ID" \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

PROJECT=$(find safari/xcode -maxdepth 2 -name "*.xcodeproj" | head -1)
SCHEME=$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{getline; gsub(/^[ \t]+/, ""); print; exit}')

if [ -n "$TEAM" ]; then
  echo "Building $SCHEME, signed with team $TEAM ($BUNDLE_ID)"
  SIGNING=(CODE_SIGN_STYLE=Automatic DEVELOPMENT_TEAM="$TEAM" -allowProvisioningUpdates)
else
  echo "Building $SCHEME unsigned (no Apple Development certificate found)"
  SIGNING=(CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual DEVELOPMENT_TEAM="")
fi
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -derivedDataPath safari/build "${SIGNING[@]}" -quiet build

# Install to a fixed place, so Safari keeps finding the same app after rebuilds.
BUILT=$(find safari/build/Build/Products/Release -maxdepth 1 -name "*.app" | head -1)
mkdir -p "$HOME/Applications"
rm -rf "$HOME/Applications/LocalBlock.app"
cp -R "$BUILT" "$HOME/Applications/LocalBlock.app"
open "$HOME/Applications/LocalBlock.app"

if [ -n "$TEAM" ]; then
  cat <<'MSG'

LocalBlock.app is installed in ~/Applications and signed, so Safari keeps it enabled
across restarts. To turn it on (first time only):
  Safari > Settings > Extensions: tick LocalBlock, then click
  "Always Allow on Every Website" so it can hide ads and stop popups.
You can untick "Allow unsigned extensions" in Safari's Developer settings; it isn't needed.
MSG
else
  cat <<'MSG'

LocalBlock.app is installed in ~/Applications, unsigned. To turn it on:
  1. Safari > Settings > Advanced: tick "Show features for web developers".
  2. Safari > Settings > Developer: tick "Allow unsigned extensions"
     (Safari turns this off again each time it quits).
  3. Safari > Settings > Extensions: tick LocalBlock, then "Always Allow on Every Website".

To stop redoing step 2, sign in to Xcode with your Apple ID (free is fine):
  Xcode > Settings > Accounts > + > Apple ID, then run this script again.
MSG
fi
