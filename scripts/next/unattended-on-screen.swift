// Needs an unattended on-screen run. Never run during an occupied desk session.
// Launches only an explicit experiment binary against an explicit disposable
// server. No activation or OS input. Native scroll dispatch stays in process.
// Captures only that child PID's exact titled window, and terminates that child.
// Compile: swiftc -parse-as-library unattended-on-screen.swift -o <sampler>
// Run: <sampler> <native-binary> <disposable-server-origin> <output.jsonl>
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
    guard CommandLine.arguments.count == 4 else {
      throw NSError(domain: "arguments", code: 1, userInfo: [NSLocalizedDescriptionKey:
        "Needs an unattended desk. Usage: <absolute-native-binary> <disposable-server-origin> <output.jsonl>"])
    }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: CommandLine.arguments[1])
    process.arguments = ["--enable-next", "--server", CommandLine.arguments[2], "--unattended-on-screen"]
    try process.run()
    // Only the child created here can be terminated. The native flag also quits
    // after seven seconds, including when capture permission is unavailable.
    defer { if process.isRunning { process.terminate() } }
    var owned: SCWindow?
    for _ in 0..<20 {
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      owned = content.windows.first { $0.owningApplication?.processID == process.processIdentifier && $0.title == "o8 next" }
      if owned != nil { break }
      try await Task.sleep(nanoseconds: 50_000_000)
    }
    guard let window = owned else { throw NSError(domain: "owned-window", code: 2) }
    FileManager.default.createFile(atPath: CommandLine.arguments[3], contents: nil)
    let file = try FileHandle(forWritingTo: URL(fileURLWithPath: CommandLine.arguments[3]))
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
    try await Task.sleep(nanoseconds: 5_000_000_000)
    try await stream.stopCapture()
  }
}
