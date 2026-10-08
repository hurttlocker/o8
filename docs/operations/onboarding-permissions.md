# Onboarding permissions

Choose **Check voice & permissions** from the project screen in the macOS app.
Microphone, Accessibility, Input Monitoring, and Screen Recording are optional.
Each row explains its feature and reads the native permission state. A Ready badge
means access is granted; a failed read stays Not verified.

The Symon page starts with Microphone. **Shortcuts & screen access** contains
Accessibility, Input Monitoring, and Screen Recording. Browser, Linux, and Windows
surfaces explain that native voice permissions are checked in the macOS app and
keep **Back to projects** available. Opening a page or disclosure requests no new
permission.

**Test microphone** checks audio levels locally for eight seconds. It saves and
sends no audio. Success confirms audio input, not transcription or a voice provider.
Stop, leaving the app, and closing the page release the microphone.

The test stays disabled until microphone access is verified. UI sound cues are
suppressed on the test controls. Setup sounds start off and can be enabled from
the persistent footer toggle. The toggle affects feedback cues, not Symon audio.

**Try the iPhone app** opens an optional installation page with the shared public
TestFlight link. Its QR contains that link only; installation creates no pairing
or credentials. The desktop phone button remains the separate pairing entry point.

**Restart and return** saves the current project, choices, and permissions step
before restarting. The app reopens that step and checks permissions again, including
on an installation that previously completed setup. A failed save prevents restart.
Operating system permission prompts still require the user's choice.
