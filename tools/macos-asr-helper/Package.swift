// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "macos-asr-helper",
  platforms: [
    .macOS("14.0")
  ],
  products: [
    .executable(
      name: "openwhispr-asr-helper",
      targets: ["OpenwhisprAsrHelper"]
    )
  ],
  dependencies: [
    // Pinned: FluidAudio ships Parakeet TDT 0.6B v3 (Core ML / ANE). Bump deliberately and re-run the benchmark.
    .package(url: "https://github.com/FluidInference/FluidAudio.git", exact: "0.17.4")
  ],
  targets: [
    .executableTarget(
      name: "OpenwhisprAsrHelper",
      dependencies: [
        .product(name: "FluidAudio", package: "FluidAudio")
      ],
      path: "Sources/OpenwhisprAsrHelper"
    )
  ],
  swiftLanguageVersions: [.v5]
)
