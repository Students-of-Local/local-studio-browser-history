// swift-tools-version: 5.9
import PackageDescription

let package = Package(
    name: "TychicusHands",
    platforms: [.macOS(.v13)],
    targets: [
        // The protocol: tools, arguments, envelopes, policies. Foundation only.
        .target(name: "HandsCore"),
    ]
)
