// Media decoding and timed transcription adapted from Scrawl's helper/Media.swift.
// Copyright (c) 2026 Kit Langton. MIT; see ../third-party/visual-capture-MIT.txt.
@preconcurrency import AVFoundation
import Foundation
import ImageIO
import Speech
import UniformTypeIdentifiers

private struct CaptureMediaError: Error { let message: String }

@main
struct VisualCaptureMedia {
  static func main() async {
    let args = CommandLine.arguments
    guard args.count >= 5 else { exit(2) }
    let source = URL(fileURLWithPath: args[2])
    let output = URL(fileURLWithPath: args[3])
    do {
      let result: [String: Any]
      switch args[1] {
      case "frames":
        guard let data = args[4].data(using: .utf8), let times = try JSONSerialization.jsonObject(with: data) as? [Int],
              !times.isEmpty, times.count <= 12, times.allSatisfy({ $0 >= 0 && $0 <= 90_000 }) else { exit(2) }
        result = try await frames(source, directory: output.deletingLastPathComponent(), times: times)
      case "transcribe":
        if #available(macOS 26.0, *) {
          do { result = try await transcribe(source) }
          catch { result = try await legacyTranscribe(source) }
        } else { result = try await legacyTranscribe(source) }
      default: exit(2)
      }
      let data = try JSONSerialization.data(withJSONObject: result)
      guard data.count <= 2_000_000 else { throw CaptureMediaError(message: "Media result is too large.") }
      try data.write(to: output, options: .atomic)
      try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: output.path)
    } catch {
      let message = (error as? CaptureMediaError)?.message ?? "Media processing failed."
      if let data = try? JSONSerialization.data(withJSONObject: ["error": message]) { try? data.write(to: output, options: .atomic) }
      exit(1)
    }
  }

  private static func frames(_ source: URL, directory: URL, times: [Int]) async throws -> [String: Any] {
    let asset = AVURLAsset(url: source)
    let duration = try await asset.load(.duration).seconds
    guard duration.isFinite, duration > 0 else { throw CaptureMediaError(message: "Recording has no video.") }
    let generator = AVAssetImageGenerator(asset: asset)
    generator.appliesPreferredTrackTransform = true
    generator.requestedTimeToleranceBefore = .zero
    generator.requestedTimeToleranceAfter = .zero
    var items: [[String: Any]] = []
    for (index, time) in times.enumerated() {
      let seconds = Double(time) / 1000
      guard seconds < duration else { throw CaptureMediaError(message: "A marked moment is outside the actual recording.") }
      let (image, _) = try await generator.image(at: CMTime(seconds: seconds, preferredTimescale: 600))
      let name = "source-\(index + 1).png"
      let url = directory.appendingPathComponent(name)
      guard let destination = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else {
        throw CaptureMediaError(message: "Could not create a frame image.")
      }
      CGImageDestinationAddImage(destination, image, nil)
      guard CGImageDestinationFinalize(destination) else { throw CaptureMediaError(message: "Could not decode a frame.") }
      items.append(["atMs": time, "file": name, "width": image.width, "height": image.height])
    }
    return ["frames": items]
  }

  private static func legacyTranscribe(_ source: URL) async throws -> [String: Any] {
    // Use an already-authorized, installed recognizer. Never request access here.
    guard SFSpeechRecognizer.authorizationStatus() == .authorized,
          let recognizer = SFSpeechRecognizer(locale: Locale.current), recognizer.isAvailable,
          recognizer.supportsOnDeviceRecognition else {
      throw CaptureMediaError(message: "On-device speech is unavailable. Use existing dictation.")
    }
    let request = SFSpeechURLRecognitionRequest(url: source)
    request.requiresOnDeviceRecognition = true
    request.shouldReportPartialResults = false
    return try await withCheckedThrowingContinuation { continuation in
      var finished = false
      var task: SFSpeechRecognitionTask?
      task = recognizer.recognitionTask(with: request) { result, error in
        guard !finished else { return }
        if let result, result.isFinal {
          finished = true
          let text = result.bestTranscription.formattedString
          let words = result.bestTranscription.segments.map { segment in
            ["t0": Int((segment.timestamp * 1000).rounded()), "t1": Int(((segment.timestamp + segment.duration) * 1000).rounded()), "text": segment.substring] as [String: Any]
          }
          continuation.resume(returning: ["text": text, "words": words])
          withExtendedLifetime(task) {}
          task = nil
        } else if error != nil {
          finished = true
          continuation.resume(throwing: CaptureMediaError(message: "On-device speech did not finish."))
          withExtendedLifetime(task) {}
          task = nil
        }
      }
    }
  }

  @available(macOS 26.0, *)
  private static func transcribe(_ source: URL) async throws -> [String: Any] {
    let local = await SpeechTranscriber.supportedLocale(equivalentTo: Locale.current)
    let english = await SpeechTranscriber.supportedLocale(equivalentTo: Locale(identifier: "en-US"))
    guard let locale = local ?? english else { throw CaptureMediaError(message: "On-device speech is unavailable for this locale.") }
    let transcriber = SpeechTranscriber(locale: locale, transcriptionOptions: [], reportingOptions: [], attributeOptions: [.audioTimeRange])
    // Existing dictation remains the fallback. A capture never starts a model download.
    if try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) != nil {
      throw CaptureMediaError(message: "On-device speech assets are not installed.")
    }
    let audio = try AVAudioFile(forReading: source)
    let analyzer = try await SpeechAnalyzer(inputAudioFile: audio, modules: [transcriber], finishAfterFile: true)
    var segments: [[String: Any]] = []
    var words: [[String: Any]] = []
    for try await result in transcriber.results {
      let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
      guard !text.isEmpty else { continue }
      for run in result.text.runs {
        guard let range = run.audioTimeRange else { continue }
        let word = String(result.text[run.range].characters).trimmingCharacters(in: .whitespacesAndNewlines)
        if !word.isEmpty { words.append(["t0": ms(range.start), "t1": ms(range.end), "text": word]) }
      }
      segments.append(["t0": ms(result.range.start), "t1": ms(result.range.end), "text": text])
      if words.count > 8_000 || segments.count > 1_000 { throw CaptureMediaError(message: "Speech result is too large.") }
    }
    withExtendedLifetime(analyzer) {}
    return ["text": segments.compactMap { $0["text"] as? String }.joined(separator: " "), "segments": segments, "words": words]
  }

  private static func ms(_ time: CMTime) -> Int { time.seconds.isFinite ? max(0, Int((time.seconds * 1000).rounded())) : 0 }
}
