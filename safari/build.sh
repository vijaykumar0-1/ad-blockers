#!/bin/bash
# Builds LocalBlock for Safari on this Mac and opens the app so Safari can find the extension.
#
# Needs: macOS with Safari 26 or later, Xcode (from the App Store; the Command Line Tools
# alone don't include the converter), and Node.js 20+.
# Usage: bash safari/build.sh
set -euo pipefail
cd "$(dirname "$0")/.."

if ! xcrun --find safari-web-extension-converter >/dev/null 2>&1; then
  echo "Xcode is required (the full app from the App Store, not just the Command Line Tools)."
  echo "After installing it, run: sudo xcode-select -s /Applications/Xcode.app"
  exit 1
fi

node tools/build-safari.mjs

# Wrap the extension in a Mac app (the converter writes an Xcode project).
rm -rf safari/xcode
xcrun safari-web-extension-converter dist/safari \
  --project-location safari/xcode \
  --app-name LocalBlock \
  --bundle-identifier com.localblock.LocalBlock \
  --macos-only --swift --copy-resources --no-open --no-prompt --force

PROJECT=$(find safari/xcode -maxdepth 2 -name "*.xcodeproj" | head -1)
SCHEME=$(xcodebuild -list -project "$PROJECT" | awk '/Schemes:/{getline; gsub(/^[ \t]+/, ""); print; exit}')
echo "Building $SCHEME from $PROJECT"

# Built locally and signed for this Mac only ("-"), so Safari needs unsigned extensions allowed.
xcodebuild -project "$PROJECT" -scheme "$SCHEME" -configuration Release \
  -derivedDataPath safari/build CODE_SIGN_IDENTITY="-" CODE_SIGN_STYLE=Manual \
  DEVELOPMENT_TEAM="" -quiet build

APP=$(find safari/build/Build/Products/Release -maxdepth 1 -name "*.app" | head -1)
open "$APP"

cat <<'MSG'

LocalBlock.app is open. To turn the extension on:
  1. Safari > Settings > Advanced: tick "Show features for web developers".
  2. Safari > Settings > Developer: tick "Allow unsigned extensions"
     (Safari turns this off again each time it quits; just tick it again).
  3. Safari > Settings > Extensions: tick LocalBlock, then click
     "Always Allow on Every Website" so it can hide ads and stop popups.
MSG
