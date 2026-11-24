// tychicus-vm: runs one Linux guest on Virtualization.framework, with no window and no Dock icon.
//
//   tychicus-vm serve <guest-dir> [--cold]   boot or restore the guest, then answer on <guest-dir>/control.sock
//   tychicus-vm version
//
// The tychicus CLI (cli/src/vm.ts) prepares the guest folder and talks to the control socket.

import Foundation

let version = "0.1.0"

func fail(_ message: String, code: Int32 = 1) -> Never {
	FileHandle.standardError.write("tychicus-vm: \(message)\n".data(using: .utf8)!)
	exit(code)
}

// A client that hangs up before its reply must not kill the helper, and the guest with it.
signal(SIGPIPE, SIG_IGN)

let args = Array(CommandLine.arguments.dropFirst())
switch args.first {
case "serve":
	guard args.count >= 2 else { fail("usage: tychicus-vm serve <guest-dir> [--cold]", code: 2) }
	let dir = URL(fileURLWithPath: args[1], isDirectory: true)
	let cold = args.dropFirst(2).contains("--cold")
	let guest: Guest
	do {
		guest = try Guest(dir: dir)
	} catch {
		fail("\(error)")
	}
	let server: ControlServer
	do {
		server = try ControlServer(path: dir.appendingPathComponent("control.sock").path, guest: guest)
	} catch {
		fail("\(error)")
	}
	server.run()
	Task { @MainActor in await guest.boot(cold: cold) }
	dispatchMain()
case "version", "--version":
	print(version)
default:
	fail("usage: tychicus-vm serve <guest-dir> [--cold] | version", code: 2)
}
