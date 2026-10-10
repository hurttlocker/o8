# Devices in the workspace

Open **Devices** from the right panel's tab picker. Maximize the panel when you need more room. Its width is remembered separately from Files and Inbox.

## Requirements and setup

- iOS simulators: macOS, Xcode, an installed simulator runtime, and a simulator created in Xcode.
- Android emulators: Android Studio's platform tools and emulator, an installed system image, and an existing virtual device.
- Device viewer setup: Node.js with npm and an internet connection for the optional helper installation.

Opening the panel checks prerequisites. Choose **Set up device viewer** to install the pinned `expo-device-hub` helper, then **Open device workspace** to start it. This setup does not install Xcode, Android Studio, SDKs, simulator runtimes, or system images. Create the devices you need in their platform tools first.

The embedded dashboard provides the installed viewer's device selection, live screens, interaction and capture controls. Available devices and controls depend on the installed platform tools. Closing or hiding the panel releases the embedded viewer; **Stop viewer** terminates o8's viewer helper and leaves simulators running.

The pinned viewer's packaged iOS native module targets Apple Silicon. Intel Macs need an x86_64 build of that module and its matching WebRTC framework; installing the JavaScript helper alone does not supply Intel streaming support. Keep any local native replacement tied to the pinned helper version. Updating or reinstalling the helper can replace it.

## Coding-agent controls

Choose **Set up agent controls** for the optional pinned `agent-device` CLI. **Copy agent command** provides the exact local invocation with `--help`; give it to the coding agent in your workspace to inspect the available commands. The helper lives in o8's data directory and does not replace your global CLI installation. Agent commands still run through that workspace's existing terminal permissions.

## Local access

The viewer binds to this computer's loopback interface and requires a session token. o8 verifies authenticated access before embedding it. The app page must use its local HTTP address (`127.0.0.1` or `localhost`); remote, HTTPS and custom-scheme pages are not supported by this helper's cookie-based embedding.

## Acceptance boundary

The route and process fixtures cover setup, startup, authentication, cancellation, cleanup, development hot reload and the token-to-cookie flow. The UI covers missing tools and hidden-panel cleanup. Native acceptance must separately verify streaming, input and the target mobile app on each supported host architecture. A live viewer does not establish push-notification, signing, physical-device or Android acceptance.
