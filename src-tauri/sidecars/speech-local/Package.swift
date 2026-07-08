// swift-tools-version: 5.10
// o8 local transcription sidecar — FluidAudio (Apache-2.0) Parakeet on the
// Apple Neural Engine. Apple Silicon only; the Rust side gates on aarch64.
import PackageDescription

let package = Package(
    name: "speech-local",
    platforms: [.macOS(.v14)],
    dependencies: [
        .package(url: "https://github.com/FluidInference/FluidAudio.git", from: "0.12.4"),
    ],
    targets: [
        .executableTarget(
            name: "speech-local",
            dependencies: [.product(name: "FluidAudio", package: "FluidAudio")],
            path: "Sources"
        ),
    ]
)
