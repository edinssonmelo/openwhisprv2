// swift-tools-version: 6.0

import PackageDescription

let package = Package(
    name: "OpenwhisprSystemAudioHelper",
    platforms: [
        .macOS(.v13)
    ],
    products: [
        .executable(
            name: "openwhispr-system-audio-helper",
            targets: ["OpenwhisprSystemAudioHelper"]
        )
    ],
    targets: [
        .executableTarget(
            name: "OpenwhisprSystemAudioHelper",
            path: "Sources/OpenwhisprSystemAudioHelper"
        )
    ]
)
