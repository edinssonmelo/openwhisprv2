// swift-tools-version: 5.9
import PackageDescription

let package = Package(
  name: "macos-coreaudio-tap-helper",
  platforms: [
    .macOS("14.2")
  ],
  products: [
    .executable(
      name: "openwhispr-coreaudio-tap-helper",
      targets: ["OpenwhisprCoreAudioTapHelper"]
    )
  ],
  targets: [
    .executableTarget(
      name: "OpenwhisprCoreAudioTapHelper",
      path: "Sources/OpenwhisprCoreAudioTapHelper"
    )
  ]
)
