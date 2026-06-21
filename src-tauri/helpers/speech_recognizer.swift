#!/usr/bin/env swift
//
// speech_recognizer.swift
// o8 — Live speech-to-text helper (daemon mode)
//
// Spawned ONCE by the Rust backend at app startup and kept alive idle
// between dictations. The parent sends commands on stdin:
//   "start" → begin a new dictation session
//   "stop"  → end current session, emit final + audio_file, return to idle
//   "quit"  → graceful exit
//
// One-shot utility modes:
//   "--permissions-json"   → print current mic/speech statuses and exit
//   "--request-permissions" → request mic/speech if needed, print statuses, exit
//
// Uses Apple's SFSpeechRecognizer for streaming partial transcripts.
// Auto-chains recognition sessions for unlimited dictation length.
// Records audio at 16kHz via AVAudioConverter for Whisper post-processing.
// SIGTERM → handleQuit() (same as "quit" command).
//

import Foundation
import Speech
import AVFoundation
import CoreAudio
import AudioToolbox

// MARK: - Globals

let audioEngine = AVAudioEngine()
var recognitionTask: SFSpeechRecognitionTask?
var currentRequest: SFSpeechAudioBufferRecognitionRequest?

// Accumulated transcript across chained sessions
var accumulatedTranscript = ""
var sessionTranscript = ""

// Audio recording for Whisper — samples are already at 16kHz mono Float32
var recordedSamples: [Float] = []
var audioConverter: AVAudioConverter?
var converterSourceSampleRate: Double = 0
var converterSourceChannelCount: AVAudioChannelCount = 0

// Target format for Whisper: 16kHz mono Float32
let whisperFormat = AVAudioFormat(
    commonFormat: .pcmFormatFloat32,
    sampleRate: 16000,
    channels: 1,
    interleaved: false
)!

// Flag to prevent restart during shutdown of the current session
var isShuttingDown = false
// Set once the final transcript has been emitted (either via callback or safety net)
var shutdownEmitted = false
var shutdownGeneration: UInt64 = 0
// When true, after emitting final and audio_file we exit() instead of going idle.
var isQuitting = false
// Current Rust-assigned session ID. Used to fence late callbacks.
var currentSessionId: UInt64 = 0
// Session ID currently being finalized after the live audio gate closes.
var finalizingSessionId: UInt64 = 0
// If a new start arrives while we're still finalizing the previous session,
// queue it and begin immediately after we emit the final result.
var pendingStartSessionId: UInt64?
// Active / preferred recognizer locale. Defaults to US English until the
// parent explicitly selects another locale.
var currentLocaleIdentifier = "en-US"
var pendingLocaleIdentifier: String?
var requiresOnDeviceRecognition = false
var appleSpeechRecognitionEnabled = false
var selectedInputDeviceUID: String?
// Empty string means "switch back to system default"; nil means no pending change.
var pendingInputDeviceUID: String?
var audioTapInstalled = false

// Flush stdout after every write
setbuf(stdout, nil)

// MARK: - Output helpers

/// Write a line to stdout using POSIX write() to bypass all buffering.
func rawWrite(_ s: String) {
    var str = s + "\n"
    str.withUTF8 { buf in
        _ = Darwin.write(STDOUT_FILENO, buf.baseAddress!, buf.count)
    }
}

func emit(_ type: String, _ text: String, sessionId: UInt64? = nil) {
    let escaped = text
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
        .replacingOccurrences(of: "\n", with: "\\n")
    if let sessionId {
        rawWrite("{\"type\":\"\(type)\",\"text\":\"\(escaped)\",\"session_id\":\(sessionId)}")
    } else {
        rawWrite("{\"type\":\"\(type)\",\"text\":\"\(escaped)\"}")
    }
}

func emitLevel(_ level: Float, sessionId: UInt64) {
    let clamped = max(0.0, min(1.0, level))
    rawWrite("{\"type\":\"level\",\"text\":\"\(String(format: "%.3f", clamped))\",\"session_id\":\(sessionId)}")
}

func emitError(_ msg: String, sessionId: UInt64? = nil) {
    let escaped = msg
        .replacingOccurrences(of: "\\", with: "\\\\")
        .replacingOccurrences(of: "\"", with: "\\\"")
    if let sessionId {
        rawWrite("{\"type\":\"error\",\"text\":\"\(escaped)\",\"session_id\":\(sessionId)}")
    } else {
        rawWrite("{\"type\":\"error\",\"text\":\"\(escaped)\"}")
    }
}

func emitReady() {
    rawWrite("{\"type\":\"ready\",\"text\":\"\"}")
}

func rawWriteJSON(_ object: [String: Any]) {
    guard
        let data = try? JSONSerialization.data(withJSONObject: object, options: []),
        let text = String(data: data, encoding: .utf8)
    else {
        emitError("Failed to serialize helper JSON payload.")
        return
    }
    rawWrite(text)
}

func coreAudioPropertyAddress(
    selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope = kAudioObjectPropertyScopeGlobal,
    element: AudioObjectPropertyElement = kAudioObjectPropertyElementMain
) -> AudioObjectPropertyAddress {
    AudioObjectPropertyAddress(mSelector: selector, mScope: scope, mElement: element)
}

func inputDeviceHasChannels(_ deviceID: AudioDeviceID) -> Bool {
    var address = coreAudioPropertyAddress(
        selector: kAudioDevicePropertyStreamConfiguration,
        scope: kAudioDevicePropertyScopeInput
    )
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(deviceID, &address, 0, nil, &dataSize) == noErr,
          dataSize > 0 else {
        return false
    }

    let rawBuffer = UnsafeMutableRawPointer.allocate(
        byteCount: Int(dataSize),
        alignment: MemoryLayout<AudioBufferList>.alignment
    )
    defer { rawBuffer.deallocate() }

    let bufferList = rawBuffer.bindMemory(to: AudioBufferList.self, capacity: 1)
    guard AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, bufferList) == noErr else {
        return false
    }

    let buffers = UnsafeMutableAudioBufferListPointer(bufferList)
    let channelCount = buffers.reduce(0) { count, buffer in
        count + Int(buffer.mNumberChannels)
    }
    return channelCount > 0
}

func inputDeviceIDs() -> [AudioDeviceID] {
    var address = coreAudioPropertyAddress(selector: kAudioHardwarePropertyDevices)
    var dataSize: UInt32 = 0
    guard AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize
    ) == noErr else {
        return []
    }

    let count = Int(dataSize) / MemoryLayout<AudioDeviceID>.size
    guard count > 0 else { return [] }

    var devices = [AudioDeviceID](repeating: 0, count: count)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &devices
    ) == noErr else {
        return []
    }

    return devices.filter(inputDeviceHasChannels)
}

func defaultInputDeviceID() -> AudioDeviceID? {
    var address = coreAudioPropertyAddress(selector: kAudioHardwarePropertyDefaultInputDevice)
    var deviceID = AudioDeviceID(kAudioObjectUnknown)
    var dataSize = UInt32(MemoryLayout<AudioDeviceID>.size)
    guard AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address,
        0,
        nil,
        &dataSize,
        &deviceID
    ) == noErr, deviceID != AudioDeviceID(kAudioObjectUnknown) else {
        return nil
    }
    return deviceID
}

func stringProperty(
    deviceID: AudioDeviceID,
    selector: AudioObjectPropertySelector
) -> String? {
    var address = coreAudioPropertyAddress(selector: selector)
    var value: CFString?
    var dataSize = UInt32(MemoryLayout<CFString?>.size)
    let status = withUnsafeMutablePointer(to: &value) { valuePtr in
        AudioObjectGetPropertyData(deviceID, &address, 0, nil, &dataSize, valuePtr)
    }
    guard status == noErr, let value else { return nil }
    return value as String
}

func audioDeviceUID(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(deviceID: deviceID, selector: kAudioDevicePropertyDeviceUID)
}

func audioDeviceName(_ deviceID: AudioDeviceID) -> String? {
    stringProperty(deviceID: deviceID, selector: kAudioObjectPropertyName)
}

func inputDeviceID(forUID uid: String) -> AudioDeviceID? {
    inputDeviceIDs().first { audioDeviceUID($0) == uid }
}

func emitInputDevicesAndExit() {
    let defaultID = defaultInputDeviceID()
    let devices = inputDeviceIDs().compactMap { deviceID -> [String: Any]? in
        guard let uid = audioDeviceUID(deviceID) else { return nil }
        let name = audioDeviceName(deviceID) ?? "Microphone"
        return [
            "uid": uid,
            "name": name,
            "is_default": defaultID == deviceID,
        ]
    }
    rawWriteJSON([
        "type": "input_devices",
        "devices": devices,
    ])
    exit(0)
}

func applySelectedInputDevice(sessionId: UInt64? = nil) -> Bool {
    guard let uid = selectedInputDeviceUID, !uid.isEmpty else {
        return true
    }

    guard let deviceID = inputDeviceID(forUID: uid) else {
        emitError("Selected microphone is not connected. Falling back to System Default.", sessionId: sessionId)
        selectedInputDeviceUID = nil
        return true
    }

    // If the selected mic IS the current system default, do NOT force it onto the
    // engine's input unit. Setting kAudioOutputUnitProperty_CurrentDevice to the
    // already-default device leaves the AUHAL pulling ZERO buffers — no audio
    // levels, empty transcripts — verified live on a default USB mic that worked
    // everywhere else. The engine's natural inputNode already follows the system
    // default, and that path captures fine. Only force-switch for a genuinely
    // non-default device.
    if let defaultID = defaultInputDeviceID(), defaultID == deviceID {
        return true
    }

    guard let audioUnit = audioEngine.inputNode.audioUnit else {
        emitError("Audio input unit is unavailable.", sessionId: sessionId)
        return false
    }

    var mutableDeviceID = deviceID
    let status = AudioUnitSetProperty(
        audioUnit,
        kAudioOutputUnitProperty_CurrentDevice,
        kAudioUnitScope_Global,
        0,
        &mutableDeviceID,
        UInt32(MemoryLayout<AudioDeviceID>.size)
    )
    if status != noErr {
        emitError("Failed to switch microphone (CoreAudio \(status)).", sessionId: sessionId)
        return false
    }
    return true
}

func normalizeInputDeviceCommand(_ raw: String) -> String? {
    let trimmed = raw.trimmingCharacters(in: .whitespacesAndNewlines)
    if trimmed.isEmpty || trimmed.lowercased() == "default" || trimmed.lowercased() == "system" {
        return nil
    }
    return trimmed
}

func handleInputDeviceUpdate(_ raw: String) {
    let normalized = normalizeInputDeviceCommand(raw)
    let pendingValue = normalized ?? ""

    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        pendingInputDeviceUID = pendingValue
        emit("status", "input_device_pending:\(pendingValue.isEmpty ? "default" : pendingValue)")
        return
    }

    selectedInputDeviceUID = normalized
    if configureAudioInputGraph() {
        emit("status", "input_device:\(normalized ?? "default")")
    }
}

func configureRecognizer(localeIdentifier: String, sessionId: UInt64? = nil) -> Bool {
    let normalized = localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        emitError("Speech recognition locale cannot be empty.", sessionId: sessionId)
        return false
    }

    guard appleSpeechRecognitionEnabled else {
        recognizer = nil
        currentLocaleIdentifier = normalized
        return true
    }

    guard let rec = SFSpeechRecognizer(locale: Locale(identifier: normalized)) else {
        emitError("SFSpeechRecognizer not available for \(normalized) locale.", sessionId: sessionId)
        return false
    }

    guard rec.isAvailable else {
        emitError("Speech recognizer is not currently available for \(normalized).", sessionId: sessionId)
        return false
    }

    if requiresOnDeviceRecognition {
        if #available(macOS 13.0, *) {
            guard rec.supportsOnDeviceRecognition else {
                emitError("On-device speech recognition is not available for \(normalized).", sessionId: sessionId)
                return false
            }
        } else {
            emitError("On-device speech recognition requires macOS 13 or newer.", sessionId: sessionId)
            return false
        }
    }

    recognizer = rec
    currentLocaleIdentifier = normalized
    return true
}

func handleLocaleUpdate(_ localeIdentifier: String) {
    let normalized = localeIdentifier.trimmingCharacters(in: .whitespacesAndNewlines)
    guard !normalized.isEmpty else {
        emitError("Speech recognition locale cannot be empty.")
        return
    }

    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        pendingLocaleIdentifier = normalized
        return
    }

    if configureRecognizer(localeIdentifier: normalized) {
        emit("status", "locale:\(normalized)")
    }
}

func handleOnDeviceUpdate(_ enabled: Bool) {
    requiresOnDeviceRecognition = enabled
    if audioEngine.isRunning || recognitionTask != nil || isShuttingDown {
        emit("status", "on_device:\(enabled)")
        return
    }

    if configureRecognizer(localeIdentifier: currentLocaleIdentifier) {
        emit("status", "on_device:\(enabled)")
    }
}

func speechAuthorizationLabel(_ status: SFSpeechRecognizerAuthorizationStatus) -> String {
    switch status {
    case .authorized:
        return "authorized"
    case .denied:
        return "denied"
    case .restricted:
        return "restricted"
    case .notDetermined:
        return "not_determined"
    @unknown default:
        return "restricted"
    }
}

func microphoneAuthorizationLabel(_ status: AVAuthorizationStatus) -> String {
    switch status {
    case .authorized:
        return "authorized"
    case .denied:
        return "denied"
    case .restricted:
        return "restricted"
    case .notDetermined:
        return "not_determined"
    @unknown default:
        return "restricted"
    }
}

func emitPermissionsAndExit(microphone: String, speech: String) {
    rawWrite("{\"type\":\"permissions\",\"microphone\":\"\(microphone)\",\"speech\":\"\(speech)\"}")
    exit(0)
}

func emitCurrentPermissionsAndExit() {
    emitPermissionsAndExit(
        microphone: microphoneAuthorizationLabel(AVCaptureDevice.authorizationStatus(for: .audio)),
        speech: speechAuthorizationLabel(SFSpeechRecognizer.authorizationStatus())
    )
}

func requestPermissionsAndExit() {
    func requestMicrophone(after speechStatus: String) {
        let currentMic = AVCaptureDevice.authorizationStatus(for: .audio)
        if currentMic == .notDetermined {
            AVCaptureDevice.requestAccess(for: .audio) { _ in
                let micStatus = microphoneAuthorizationLabel(AVCaptureDevice.authorizationStatus(for: .audio))
                emitPermissionsAndExit(microphone: micStatus, speech: speechStatus)
            }
        } else {
            emitPermissionsAndExit(
                microphone: microphoneAuthorizationLabel(currentMic),
                speech: speechStatus
            )
        }
    }

    // `SFSpeechRecognizer.requestAuthorization` can hard-crash a bare dev
    // sidecar on newer macOS TCC builds even when the helper has an embedded
    // usage string. Report the current Speech status here and let the Settings
    // pane link handle manual recovery; recording still works through Whisper.
    requestMicrophone(after: speechAuthorizationLabel(SFSpeechRecognizer.authorizationStatus()))
}

// MARK: - WAV writing

/// Write recorded 16kHz mono Float32 samples as a 16-bit PCM WAV file.
func writeWavFile(sessionId: UInt64) -> String? {
    guard !recordedSamples.isEmpty else { return nil }

    let tempDir = NSTemporaryDirectory()
    let wavPath = (tempDir as NSString)
        .appendingPathComponent("o8_dictation_\(sessionId)_\(UUID().uuidString).wav")

    let numSamples = UInt32(recordedSamples.count)
    let sampleRate: UInt32 = 16000
    let bitsPerSample: UInt16 = 16
    let numChannels: UInt16 = 1
    let byteRate = sampleRate * UInt32(numChannels) * UInt32(bitsPerSample / 8)
    let blockAlign = numChannels * (bitsPerSample / 8)
    let dataSize = numSamples * UInt32(bitsPerSample / 8)
    let fileSize = 36 + dataSize

    var data = Data()
    data.reserveCapacity(Int(44 + dataSize))

    data.append(contentsOf: "RIFF".utf8)
    data.append(contentsOf: withUnsafeBytes(of: fileSize.littleEndian) { Array($0) })
    data.append(contentsOf: "WAVE".utf8)
    data.append(contentsOf: "fmt ".utf8)
    data.append(contentsOf: withUnsafeBytes(of: UInt32(16).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: UInt16(1).littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: numChannels.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: sampleRate.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: byteRate.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: blockAlign.littleEndian) { Array($0) })
    data.append(contentsOf: withUnsafeBytes(of: bitsPerSample.littleEndian) { Array($0) })
    data.append(contentsOf: "data".utf8)
    data.append(contentsOf: withUnsafeBytes(of: dataSize.littleEndian) { Array($0) })

    var pcmSamples = [Int16]()
    pcmSamples.reserveCapacity(recordedSamples.count)
    for sample in recordedSamples {
        let clamped = max(-1.0, min(1.0, sample))
        pcmSamples.append(Int16(clamped * 32767).littleEndian)
    }
    pcmSamples.withUnsafeBytes { rawBuffer in
        data.append(rawBuffer.bindMemory(to: UInt8.self))
    }

    do {
        try data.write(to: URL(fileURLWithPath: wavPath))
        return wavPath
    } catch {
        emitError("Failed to write audio file: \(error.localizedDescription)")
        return nil
    }
}

// MARK: - Session lifecycle

/// End the current dictation session. Does NOT exit and does NOT stop the
/// audio engine — the mic stays hot for the next session so the following
/// Fn press doesn't pay cold-start latency. `currentSessionId = 0` is the
/// gate that makes the live tap discard all subsequent buffers until
/// handleStart opens it again.
func stopSession(requestedSessionId: UInt64? = nil) {
    guard !isShuttingDown else { return }
    if let requestedSessionId, requestedSessionId != currentSessionId {
        return
    }
    isShuttingDown = true
    shutdownGeneration &+= 1
    finalizingSessionId = currentSessionId
    let shutdownSessionId = finalizingSessionId
    let shutdownGenerationAtStop = shutdownGeneration

    // Close the gate — new buffers from the still-running tap now hit the
    // early-return and go nowhere. The last few buffers that arrive before
    // finish() processes have already been appended to currentRequest and
    // will show up in the final result.
    currentSessionId = 0

    // Ask for the final result. The callback on the main queue will fire
    // with isFinal=true (or an error). We emit the full transcript from
    // THERE, not here — otherwise we lose the tail of the current session.
    if let recognitionTask {
        recognitionTask.finish()
    } else {
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.05) {
            if isShuttingDown
                && !shutdownEmitted
                && finalizingSessionId == shutdownSessionId
                && shutdownGeneration == shutdownGenerationAtStop {
                emitFinalAndReturnToIdle()
            }
        }
    }

    // Safety net: if no callback fires within 1.5s, emit what we have and idle.
    // Rapid Fn double-tap can cancel this shutdown and start a fresh session
    // before the timer fires; fence the timer so it cannot finalize the new
    // long-form dictation.
    DispatchQueue.main.asyncAfter(deadline: .now() + 1.5) {
        if isShuttingDown
            && !shutdownEmitted
            && finalizingSessionId == shutdownSessionId
            && shutdownGeneration == shutdownGenerationAtStop {
            emitFinalAndReturnToIdle()
        }
    }
}

/// Emit the final transcript + audio file, then return to idle state
/// (or exit if isQuitting is set).
func emitFinalAndReturnToIdle() {
    guard !shutdownEmitted else { return }
    shutdownEmitted = true
    let sessionId = finalizingSessionId != 0 ? finalizingSessionId : currentSessionId

    let fullTranscript: String
    if !sessionTranscript.isEmpty {
        fullTranscript = accumulatedTranscript.isEmpty
            ? sessionTranscript
            : accumulatedTranscript + " " + sessionTranscript
    } else {
        fullTranscript = accumulatedTranscript
    }
    if !fullTranscript.isEmpty {
        emit("final", fullTranscript, sessionId: sessionId)
    }
    if let wavPath = writeWavFile(sessionId: sessionId) {
        emit("audio_file", wavPath, sessionId: sessionId)
    }
    emit("complete", "", sessionId: sessionId)
    finalizingSessionId = 0
    if isQuitting {
        exit(0)
    }
    let pendingStart = pendingStartSessionId
    pendingStartSessionId = nil

    // Turn the mic off between sessions. If a pending start was queued
    // (rapid Fn tap), skip the stop unless Settings queued a microphone
    // change that requires rebuilding the input graph.
    if (pendingStart == nil || pendingInputDeviceUID != nil) && audioEngine.isRunning {
        audioEngine.stop()
    }

    // Reset session state and return to idle.
    resetSessionState()
    if let pendingInputDevice = pendingInputDeviceUID {
        pendingInputDeviceUID = nil
        selectedInputDeviceUID = pendingInputDevice.isEmpty ? nil : pendingInputDevice
        _ = configureAudioInputGraph(sessionId: sessionId)
    }
    if let pendingLocale = pendingLocaleIdentifier {
        pendingLocaleIdentifier = nil
        _ = configureRecognizer(localeIdentifier: pendingLocale, sessionId: sessionId)
    }
    if let pendingStart {
        handleStart(sessionId: pendingStart)
    } else {
        emitReady()
    }
}

/// Reset all per-session state. Called before starting a new session AND
/// after cleanly ending one.
func resetSessionState() {
    sessionTranscript = ""
    accumulatedTranscript = ""
    isShuttingDown = false
    shutdownEmitted = false
    recordedSamples.removeAll(keepingCapacity: true)
    recognitionTask = nil
    currentRequest = nil
    currentSessionId = 0
}

// MARK: - Signal handling

func handleQuit() {
    // If a session is active, stop it first — the final callback will see
    // isQuitting and exit(0) after emitting.
    if recognitionTask != nil && audioEngine.isRunning {
        isQuitting = true
        stopSession()
        return
    }
    // No session active — exit immediately.
    exit(0)
}

let sigTermSource = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
signal(SIGTERM, SIG_IGN)
sigTermSource.setEventHandler { handleQuit() }
sigTermSource.resume()

let sigIntSource = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
signal(SIGINT, SIG_IGN)
sigIntSource.setEventHandler { handleQuit() }
sigIntSource.resume()

// MARK: - Authorization

func requestAuthorization(completion: @escaping (Bool) -> Void) {
    switch SFSpeechRecognizer.authorizationStatus() {
    case .authorized:
        appleSpeechRecognitionEnabled = true
        completion(true)
    case .denied:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:denied")
        completion(true)
    case .restricted:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:restricted")
        completion(true)
    case .notDetermined:
        // Brand-new app identity (o8 has NEVER been granted, unlike the legacy
        // Symon bundle whose status is already .authorized): actually PROMPT for
        // Speech Recognition. The prior report-only branch left a fresh install
        // permanently notDetermined → appleSpeechRecognitionEnabled stayed false →
        // startRecognitionSession early-returned → EMPTY transcripts (apple=0).
        // This is SAFE to call here: the helper embeds NSSpeechRecognitionUsage-
        // Description in its OWN __info_plist section (build.rs -sectcreate) and
        // runs a main run loop, so the standard Apple API neither crashes (the
        // "bare dev sidecar" crash needed a missing usage string) nor no-ops.
        emit("status", "speech_recognition:requesting")
        SFSpeechRecognizer.requestAuthorization { newStatus in
            DispatchQueue.main.async {
                switch newStatus {
                case .authorized:
                    appleSpeechRecognitionEnabled = true
                    emit("status", "speech_recognition:authorized")
                case .denied:
                    emit("status", "speech_recognition:denied")
                default:
                    emit("status", "speech_recognition:restricted")
                }
                // Proceed regardless — even with speech denied the audio engine
                // still records the WAV for the Whisper finalize fallback path.
                completion(true)
            }
        }
    @unknown default:
        appleSpeechRecognitionEnabled = false
        emit("status", "speech_recognition:restricted")
        completion(true)
    }
}

// MARK: - Recognition (restartable)

var recognizer: SFSpeechRecognizer?
var inputNode: AVAudioInputNode!
var nativeFormat: AVAudioFormat!

/// Start or restart a recognition session. The audio engine stays running;
/// only the recognition task and request are recreated.
func startRecognitionSession(sessionId: UInt64) {
    guard !isShuttingDown else { return }
    guard appleSpeechRecognitionEnabled else {
        currentRequest = nil
        recognitionTask = nil
        sessionTranscript = ""
        return
    }
    guard let recognizer = recognizer, recognizer.isAvailable else {
        emitError("Speech recognizer not available for restart.", sessionId: sessionId)
        return
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true

    if #available(macOS 13.0, *) {
        request.requiresOnDeviceRecognition = requiresOnDeviceRecognition
        request.addsPunctuation = true
    }

    currentRequest = request
    sessionTranscript = ""

    recognitionTask = recognizer.recognitionTask(with: request) { result, error in
        let isCurrentSession = sessionId == currentSessionId
        let isFinalizingSession = isShuttingDown && sessionId == finalizingSessionId
        guard isCurrentSession || isFinalizingSession else { return }

        if let result = result {
            let text = result.bestTranscription.formattedString
            sessionTranscript = text

            // Emit the full accumulated transcript + current session
            let fullText = accumulatedTranscript.isEmpty
                ? text
                : accumulatedTranscript + " " + text

            if result.isFinal {
                // Session ended (hit ~60s limit OR we asked finish()).
                accumulatedTranscript = fullText
                if isShuttingDown {
                    // This final is the result of our finish() during shutdown.
                    // fullText (and thus accumulatedTranscript) already includes
                    // this session's text — clear sessionTranscript so the
                    // emit path doesn't concatenate the tail twice.
                    sessionTranscript = ""
                    emitFinalAndReturnToIdle()
                    return
                }
                emit("partial", fullText, sessionId: sessionId)
                // Chain to next session — no delay to minimize audio gap.
                DispatchQueue.main.async {
                    startRecognitionSession(sessionId: sessionId)
                }
            } else {
                emit("partial", fullText, sessionId: sessionId)
            }
        }

        if let error = error as NSError? {
            if isShuttingDown {
                // finish() delivered an error instead of a final — still emit
                // whatever we have accumulated and idle.
                emitFinalAndReturnToIdle()
                return
            }
            if error.code != 216 && error.code != 1110 {
                // Recognition timed out or errored — chain to next session
                DispatchQueue.main.async {
                    startRecognitionSession(sessionId: sessionId)
                }
            }
        }
    }
}

// MARK: - Audio engine setup (once at startup)

/// Rebuild the input graph for the selected microphone. The engine must be
/// stopped before this runs.
func configureAudioInputGraph(sessionId: UInt64? = nil) -> Bool {
    if audioEngine.isRunning {
        audioEngine.stop()
    }
    if audioTapInstalled {
        inputNode.removeTap(onBus: 0)
        audioTapInstalled = false
    }

    inputNode = audioEngine.inputNode

    guard applySelectedInputDevice(sessionId: sessionId) else {
        return false
    }

    nativeFormat = inputNode.outputFormat(forBus: 0)

    guard nativeFormat.sampleRate > 0 else {
        emitError("No audio input available. Check microphone permissions.", sessionId: sessionId)
        return false
    }

    audioConverter = nil
    converterSourceSampleRate = 0
    converterSourceChannelCount = 0

    // Pre-allocate for ~5 minutes of 16kHz audio
    recordedSamples.reserveCapacity(16000 * 300)

    // Prepare the engine (negotiates hardware format, allocates buffers)
    audioEngine.prepare()

    // Install the tap ONCE so the format + buffer processing callback is
    // ready to go the moment we start the engine. The engine itself is NOT
    // started here — that would light the macOS "mic in use" orange dot
    // for the app's entire lifetime, which is what Intel users were
    // (correctly) calling out as invasive. Instead, handleStart kicks the
    // engine on, stopSession kicks it off. Cold-start latency for
    // AVAudioEngine.start() is ~30–80ms on modern macOS — well under the
    // user's natural press-to-speak gap.
    var frameCount = 0
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: nil) { buffer, _ in
        // Pre-session idle: mic is hot but we're not recording.
        // Drop every buffer until handleStart flips the gate.
        if currentSessionId == 0 {
            return
        }

        // Feed audio to the current recognition request
        currentRequest?.append(buffer)

        // Convert to 16kHz mono for Whisper recording. Build the converter
        // from the actual buffer format so external mics with different
        // hardware formats do not invalidate the tap.
        let sourceFormat = buffer.format
        let sourceRate = sourceFormat.sampleRate
        guard sourceRate > 0 else { return }
        if audioConverter == nil ||
            converterSourceSampleRate != sourceRate ||
            converterSourceChannelCount != sourceFormat.channelCount {
            audioConverter = AVAudioConverter(from: sourceFormat, to: whisperFormat)
            converterSourceSampleRate = sourceRate
            converterSourceChannelCount = sourceFormat.channelCount
        }
        guard let converter = audioConverter else { return }
        let ratio = 16000.0 / sourceRate
        let outputFrameCapacity = AVAudioFrameCount(ceil(Double(buffer.frameLength) * ratio))
        guard let outputBuffer = AVAudioPCMBuffer(pcmFormat: whisperFormat, frameCapacity: outputFrameCapacity) else {
            return
        }

        var conversionError: NSError?
        var inputConsumed = false
        converter.convert(to: outputBuffer, error: &conversionError) { _, outStatus in
            if inputConsumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            inputConsumed = true
            outStatus.pointee = .haveData
            return buffer
        }

        if conversionError == nil, let channelData = outputBuffer.floatChannelData {
            let frames = Int(outputBuffer.frameLength)
            if frames > 0 {
                recordedSamples.append(contentsOf: UnsafeBufferPointer(start: channelData[0], count: frames))
            }
        }

        // Compute RMS audio level every ~6 buffers (~150ms at 44.1kHz)
        frameCount += 1
        if frameCount % 6 == 0 {
            guard let channelData = buffer.floatChannelData else { return }
            let frames = buffer.frameLength
            let samples = channelData[0]
            var sumOfSquares: Float = 0
            for i in 0..<Int(frames) {
                let sample = samples[i]
                sumOfSquares += sample * sample
            }
            let rms = sqrt(sumOfSquares / Float(frames))
            let normalized = min(1.0, rms / 0.12)
            emitLevel(normalized, sessionId: currentSessionId)
        }
    }
    audioTapInstalled = true

    // Engine stays off until the user actually presses Fn. The speculative
    // SFSpeechRecognizer warmup request that used to live here was removed
    // too — it leaked a live TLS session to Apple's speech backend for the
    // app's full lifetime and is dubious value vs. paying 300ms once on
    // the user's first real dictation.

    return true
}

/// Prepare the audio engine + recognizer + converter + recording buffer.
/// Does NOT start the engine or start recognition — those happen in
/// handleStart() when the parent sends "start".
func prepareAudioEngine() {
    guard configureRecognizer(localeIdentifier: currentLocaleIdentifier),
          configureAudioInputGraph() else {
        exit(1)
    }
    emitReady()
}

/// Begin a new dictation session in response to the "start" command.
/// The audio engine + tap are ALREADY running (installed in prepareAudioEngine);
/// all we do here is reset per-session state, create a fresh recognition task,
/// and flip `currentSessionId` so the hot tap starts routing audio into it.
func handleStart(sessionId: UInt64) {
    // Rapid-tap recovery. If a previous session is mid-finalize (isShuttingDown
    // is true, the recognition task has been asked to finish(), and the final
    // callback hasn't fired yet), the OLD behavior was to queue this new start
    // and only honor it after the old session emitted "complete". That meant
    // the user's next Fn press → panel → first spoken words all hit a
    // currentSessionId=0 gate and were discarded. Under rapid tapping this
    // read as "the app just broke — nothing's happening."
    //
    // Instead: force-cancel the old task, emit a best-effort complete so the
    // Rust side doesn't sit on a session it will never see finalize, and fall
    // through to the fresh-session setup below.
    if isShuttingDown {
        recognitionTask?.cancel()
        recognitionTask = nil
        currentRequest = nil
        shutdownGeneration &+= 1
        if !shutdownEmitted {
            let stoppedId = finalizingSessionId != 0 ? finalizingSessionId : currentSessionId
            shutdownEmitted = true
            // Recover the interrupted session's words instead of dropping them.
            // Emit whatever was accumulated as a final (same logic as the normal
            // finalize path) before the complete, so the Rust side can still
            // paste it rather than seeing a bare complete with no transcript.
            let recovered: String
            if !sessionTranscript.isEmpty {
                recovered = accumulatedTranscript.isEmpty
                    ? sessionTranscript
                    : accumulatedTranscript + " " + sessionTranscript
            } else {
                recovered = accumulatedTranscript
            }
            if !recovered.isEmpty {
                emit("final", recovered, sessionId: stoppedId)
            }
            emit("complete", "", sessionId: stoppedId)
        }
        isShuttingDown = false
        finalizingSessionId = 0
        pendingStartSessionId = nil
    }

    // Reset per-session state BEFORE opening the gate. We want the first
    // buffer the tap delivers for this session to land in a clean slate.
    sessionTranscript = ""
    accumulatedTranscript = ""
    isShuttingDown = false
    shutdownEmitted = false
    recordedSamples.removeAll(keepingCapacity: true)

    guard audioTapInstalled, nativeFormat != nil else {
        emitError("Audio engine not prepared.", sessionId: sessionId)
        return
    }

    // Safety: if the hot engine died for any reason, bring it back before
    // opening the session gate. Normal path: this is a no-op.
    if !audioEngine.isRunning {
        do {
            try audioEngine.start()
        } catch {
            emitError("Failed to restart audio engine: \(error.localizedDescription)", sessionId: sessionId)
            return
        }
    }

    // Create the recognition task FIRST, then flip the session id. The tap
    // callback is already live and will start routing audio the moment
    // `currentSessionId` becomes non-zero.
    startRecognitionSession(sessionId: sessionId)
    currentSessionId = sessionId

    emit("status", "listening", sessionId: sessionId)
}

// MARK: - Main

if CommandLine.arguments.contains("--permissions-json") {
    emitCurrentPermissionsAndExit()
}

if CommandLine.arguments.contains("--request-permissions") {
    requestPermissionsAndExit()
    RunLoop.main.run()
}

if CommandLine.arguments.contains("--input-devices-json") {
    emitInputDevicesAndExit()
}

requestAuthorization { authorized in
    guard authorized else { exit(1) }
    DispatchQueue.main.async {
        prepareAudioEngine()
    }
}

// Stdin reader loop — runs on a background queue, dispatches commands to main.
DispatchQueue.global(qos: .utility).async {
    while let line = readLine() {
        let cmd = line.trimmingCharacters(in: .whitespacesAndNewlines)
        DispatchQueue.main.async {
            if cmd == "quit" {
                handleQuit()
                return
            }

            if cmd == "start" {
                handleStart(sessionId: 0)
                return
            }

            if cmd == "stop" {
                stopSession()
                return
            }

            if cmd.hasPrefix("start:"),
               let sessionId = UInt64(cmd.dropFirst("start:".count)) {
                handleStart(sessionId: sessionId)
                return
            }

            if cmd.hasPrefix("stop:"),
               let sessionId = UInt64(cmd.dropFirst("stop:".count)) {
                stopSession(requestedSessionId: sessionId)
                return
            }

            if cmd.hasPrefix("locale:") {
                handleLocaleUpdate(String(cmd.dropFirst("locale:".count)))
                return
            }

            if cmd.hasPrefix("on_device:") {
                let raw = String(cmd.dropFirst("on_device:".count)).lowercased()
                handleOnDeviceUpdate(raw == "true" || raw == "1")
                return
            }

            if cmd.hasPrefix("input_device:") {
                handleInputDeviceUpdate(String(cmd.dropFirst("input_device:".count)))
                return
            }
        }
    }
    // stdin closed → parent died, exit gracefully
    DispatchQueue.main.async { handleQuit() }
}

RunLoop.main.run()
