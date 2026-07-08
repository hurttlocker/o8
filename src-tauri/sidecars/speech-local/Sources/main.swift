// o8 speech-local — on-device transcription sidecar (Apple Silicon / ANE).
//
// Contract (consumed by src-tauri/src/stt/whisper.rs `transcribe_via_local`):
//   speech-local transcribe <audio-path>  → one-line JSON on stdout:
//       {"ok":true,"text":"…","latency_ms":123,"model":"parakeet-tdt-v3"}
//       {"ok":false,"error":"…"}
//   speech-local warmup                   → downloads/loads models, prints ok JSON.
//
// FluidAudio (Apache-2.0) fetches Parakeet CoreML models into its own cache on
// first use (~600MB); `warmup` lets the app pre-download in the background so
// the first dictation doesn't pay it. Exit code is always 0 with ok:false on
// failure — the Rust caller treats ANY non-ok as "fall through to cloud".
// Call shape mirrors FluidAudioCLI's TranscribeCommand (the canonical consumer).

import FluidAudio
import Foundation

struct OkOut: Codable {
    let ok: Bool
    let text: String
    let latency_ms: UInt64
    let model: String
}

struct ErrOut: Codable {
    let ok: Bool
    let error: String
}

func emit<T: Codable>(_ value: T) {
    if let data = try? JSONEncoder().encode(value), let line = String(data: data, encoding: .utf8) {
        print(line)
    } else {
        print("{\"ok\":false,\"error\":\"encode failure\"}")
    }
}

func fail(_ message: String) -> Never {
    emit(ErrOut(ok: false, error: message))
    exit(0)
}

let arguments = CommandLine.arguments
guard arguments.count >= 2 else {
    fail("usage: speech-local <transcribe <audio-path> | warmup>")
}

let command = arguments[1]

let semaphore = DispatchSemaphore(value: 0)
Task {
    do {
        let models = try await AsrModels.downloadAndLoad(version: .v3)
        let manager = AsrManager(config: .default)
        try await manager.loadModels(models)

        switch command {
        case "warmup":
            emit(OkOut(ok: true, text: "", latency_ms: 0, model: "parakeet-tdt-v3"))
        case "transcribe":
            guard arguments.count >= 3 else { fail("transcribe requires an audio path") }
            let url = URL(fileURLWithPath: arguments[2])
            guard FileManager.default.fileExists(atPath: url.path) else {
                fail("audio file not found: \(url.path)")
            }
            let start = DispatchTime.now()
            var decoderState = TdtDecoderState.make(decoderLayers: await manager.decoderLayerCount)
            let result = try await manager.transcribe(url, decoderState: &decoderState)
            let elapsed = (DispatchTime.now().uptimeNanoseconds - start.uptimeNanoseconds) / 1_000_000
            emit(OkOut(ok: true, text: result.text, latency_ms: elapsed, model: "parakeet-tdt-v3"))
        default:
            fail("unknown command: \(command)")
        }
    } catch {
        emit(ErrOut(ok: false, error: String(describing: error)))
    }
    semaphore.signal()
}
semaphore.wait()
exit(0)
