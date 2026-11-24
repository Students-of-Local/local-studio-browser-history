// swift-tools-version:5.9
import PackageDescription

let package = Package(
	name: "tychicus-vm",
	platforms: [.macOS(.v14)],
	targets: [
		.executableTarget(name: "tychicus-vm", path: "Sources/tychicus-vm"),
	]
)
