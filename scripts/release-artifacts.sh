#!/usr/bin/env bash
# Unified artifact builder: compiles the Android APK and the Linux AppImage
# and drops BOTH into <repo>/releases/ with stable, self-describing names —
# no more digging through gen/android/... and target/release/bundle/...
#
# Usage (from anywhere):
#   ./scripts/release-artifacts.sh          # both artifacts
#   ./scripts/release-artifacts.sh apk      # Android only
#   ./scripts/release-artifacts.sh appimage # Linux only
#
# Prerequisites are the container's documented toolchain (JDK17, Android
# SDK/NDK, keystore, gdk-pixbuf loaders dir — see FORK-GUIDE §0).
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
APP_DIR="$REPO_ROOT/apps/readest-app"
OUT_DIR="$REPO_ROOT/releases"
VERSION="$(node -e "console.log(require('$APP_DIR/package.json').version)")"

WHAT="${1:-both}"
mkdir -p "$OUT_DIR"

export PATH="$HOME/.cargo/bin:$PATH"

build_apk() {
  echo "==> [1/2] Android APK (aarch64)"
  export JAVA_HOME=/usr/lib/jvm/java-17-openjdk
  export ANDROID_HOME=/opt/android-sdk
  export NDK_HOME=/opt/android-sdk/ndk/29.0.14206865
  # ic_launcher_background colour resources must exist or the gradle
  # resource-link step fails (FORK-GUIDE §0).
  (cd "$APP_DIR" && pnpm tauri icon ../../data/icons/readest-book.png >/dev/null)
  (cd "$APP_DIR" && pnpm tauri android build --target aarch64 --apk)
  # Revert the icon regeneration jitter so the tree stays clean.
  git -C "$REPO_ROOT" checkout -- apps/readest-app/src-tauri/icons \
    apps/readest-app/src-tauri/gen/android/app/src/main/res 2>/dev/null || true
  cp "$APP_DIR/src-tauri/gen/android/app/build/outputs/apk/universal/release/app-universal-release.apk" \
    "$OUT_DIR/Readest-${VERSION}-android-arm64.apk"
  echo "    -> releases/Readest-${VERSION}-android-arm64.apk"
}

build_appimage() {
  echo "==> [2/2] Linux AppImage (x86_64)"
  export NO_STRIP=true
  (cd "$APP_DIR" \
    && pnpm tauri build --bundles appimage \
       --config '{"bundle":{"createUpdaterArtifacts":false}}')
  # The workspace-level target dir holds the bundle (not the app dir's).
  cp "$REPO_ROOT/target/release/bundle/appimage/Readest_${VERSION}_amd64.AppImage" \
    "$OUT_DIR/Readest-${VERSION}-linux-amd64.AppImage"
  echo "    -> releases/Readest-${VERSION}-linux-amd64.AppImage"
}

case "$WHAT" in
  apk) build_apk ;;
  appimage) build_appimage ;;
  both) build_apk; build_appimage ;;
  *) echo "unknown target: $WHAT (apk | appimage | both)"; exit 1 ;;
esac

echo "==> done. Artifacts in $OUT_DIR:"
ls -la "$OUT_DIR"
