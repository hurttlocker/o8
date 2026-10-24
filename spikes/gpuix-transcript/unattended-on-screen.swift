// Needs an unattended on-screen run. This sampler NEVER creates, focuses,
// resizes, closes, or sends input to an application. Supply the explicit ID of
// an experiment-owned window after preparing it with in-process/page input.
// Usage: swift unattended-on-screen.swift <window-id> <output.jsonl> [seconds<=8]
// Run once per arm/run. No physical keyboard-to-photon claim is possible.
import Foundation
import ScreenCaptureKit
import CoreMedia
import CoreVideo

final class Frames: NSObject, SCStreamOutput {
  let file: FileHandle
  let queue = DispatchQueue(label: "benchmark.capture")
  var previous: UInt64?
  init(_ file: FileHandle) { self.file = file }
  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let status = attachments.first?[.status] as? Int,
      status == SCFrameStatus.complete.rawValue,
      let pixels = sample.imageBuffer else { return }
    CVPixelBufferLockBaseAddress(pixels, .readOnly)
    defer { CVPixelBufferUnlockBaseAddress(pixels, .readOnly) }
    guard let bytes = CVPixelBufferGetBaseAddress(pixels) else { return }
    let width = CVPixelBufferGetWidth(pixels), height = CVPixelBufferGetHeight(pixels)
    let stride = CVPixelBufferGetBytesPerRow(pixels)
    var hash: UInt64 = 14695981039346656037
    // Sample the whole owned content, not the operator's desktop.
    for y in Swift.stride(from: 0, to: height, by: 4) {
      for x in Swift.stride(from: 0, to: width * 4, by: 16) {
        hash = (hash ^ UInt64(bytes.load(fromByteOffset: y * stride + x, as: UInt8.self))) &* 1099511628211
      }
    }
    let row: [String: Any] = ["capturePtsSeconds": sample.presentationTimeStamp.seconds,
      "hostUptimeSeconds": ProcessInfo.processInfo.systemUptime,
      "width": width, "height": height, "contentChanged": previous != hash,
      "signature": String(hash), "boundary": "ScreenCaptureKit complete frame, not photon time"]
    previous = hash
    if let data = try? JSONSerialization.data(withJSONObject: row, options: [.sortedKeys]) {
      file.write(data); file.write(Data([10]))
    }
  }
}

@main struct Unattended {
  static func main() async throws {
    guard CommandLine.arguments.count >= 3,
      let id = UInt32(CommandLine.arguments[1]) else {
      throw NSError(domain: "benchmark", code: 1, userInfo: [NSLocalizedDescriptionKey:
        "Needs unattended desk and an explicit experiment-owned window ID; usage: <id> <output.jsonl> [seconds<=8]"])
    }
    let seconds = CommandLine.arguments.count > 3 ? Double(CommandLine.arguments[3]) ?? 0 : 8
    guard seconds > 0 && seconds <= 8 else { throw NSError(domain: "duration", code: 2) }
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let window = content.windows.first(where: { $0.windowID == id }),
      window.title?.hasPrefix("GPUIX benchmark") == true else {
      throw NSError(domain: "ownership", code: 3, userInfo: [NSLocalizedDescriptionKey:
        "Exact window missing or title lacks GPUIX benchmark prefix; no automatic discovery or activation"])
    }
    FileManager.default.createFile(atPath: CommandLine.arguments[2], contents: nil)
    let file = try FileHandle(forWritingTo: URL(fileURLWithPath: CommandLine.arguments[2]))
    defer { try? file.close() }
    let sink = Frames(file)
    let config = SCStreamConfiguration()
    config.width = Int(window.frame.width); config.height = Int(window.frame.height)
    config.pixelFormat = kCVPixelFormatType_32BGRA
    config.minimumFrameInterval = CMTime(value: 1, timescale: 120)
    config.showsCursor = false; config.queueDepth = 3
    let stream = SCStream(filter: SCContentFilter(desktopIndependentWindow: window), configuration: config, delegate: nil)
    try stream.addStreamOutput(sink, type: .screen, sampleHandlerQueue: sink.queue)
    try await stream.startCapture()
    try await Task.sleep(nanoseconds: UInt64(seconds * 1_000_000_000))
    try await stream.stopCapture()
  }
}
