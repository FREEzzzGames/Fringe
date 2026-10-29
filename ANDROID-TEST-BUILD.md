# Android test APK

The `Build Ghost Layer Android APK` workflow creates a debug APK for direct installation on an Android test device.

1. Open the repository Actions tab.
2. Select `Build Ghost Layer Android APK`.
3. Open the latest successful run on branch `ghost-layers-mvp`.
4. Download the `ghost-layer-debug-apk` artifact and extract `app-debug.apk`.

This is a debug test build, not a signed release build. WebXR plane detection depends on browser/device support; GPS/compass fallback is approximate and does not provide true wall tracking.
