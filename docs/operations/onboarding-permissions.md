# Onboarding permissions

Choose **Check voice & permissions** from the project screen in the macOS app.
Microphone, Accessibility, Input Monitoring, and Screen Recording are optional.
Each row explains its feature and reads the native permission state. A Ready badge
means access is granted; a failed read stays Not verified.

**Test microphone** checks audio levels locally for eight seconds. It saves and
sends no audio. Success confirms audio input, not transcription or a voice provider.
Stop, leaving the app, and closing the page release the microphone.

**Restart and return** saves the current project, choices, and permissions step
before restarting. The app reopens that step and checks permissions again, including
on an installation that previously completed setup. A failed save prevents restart.
Operating system permission prompts still require the user's choice.
