// swift-tools-version: 5.9
import Foundation
import PackageDescription

// The hands engine (agent-desktop's C library, built by scripts/build-engine.sh into engine/lib).
// An absolute path, because the linker's working directory isn't always the package's.
let root = URL(fileURLWithPath: #filePath).deletingLastPathComponent().path

let package = Package(
    name: "TychicusHands",
    platforms: [.macOS(.v13)],
    products: [
        .executable(name: "tychicus-hands", targets: ["TychicusHands"]),
    ],
    targets: [
        // The protocol: tools, arguments, envelopes, policies. Foundation only.
        .target(name: "HandsCore"),
        // agent-desktop's C header, for the hands engine.
        .systemLibrary(name: "CAgentDesktop", path: "Sources/CAgentDesktop"),
        // `tychicus-hands mcp [--connector]`: the hands over stdio. The engine's library sits next to the binary
        // in an install (or in ../Frameworks in an app bundle); `engine/lib` is where a `swift build` finds it.
        .executableTarget(
            name: "TychicusHands",
            dependencies: ["HandsCore", "CAgentDesktop"],
            linkerSettings: [
                .unsafeFlags([
                    "-L\(root)/engine/lib", "-lagent_desktop_ffi",
                    "-framework", "ApplicationServices", "-framework", "CoreGraphics", "-framework", "CoreFoundation",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path",
                    "-Xlinker", "-rpath", "-Xlinker", "@executable_path/../Frameworks",
                    "-Xlinker", "-rpath", "-Xlinker", "\(root)/engine/lib",
                ]),
            ]),
    ]
)
