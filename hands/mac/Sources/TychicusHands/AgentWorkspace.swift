import Foundation

/// Where agent windows live. With Polycarp running and its agent workspace on, that is Polycarp's agent workspace,
/// reached through its agent workspace API (Polycarp's spaces/docs/agent-workspace-api.md). Without it there is no
/// workspace to move anything to: the windows of processes this helper started count as the agent's, and nothing moves.
protocol AgentWorkspace {
    /// The agent workspace's number and the ids of the windows on it, or nil when there is none to ask.
    func windows() -> (workspace: Int, ids: Set<UInt32>)?
    /// Asks for window `id` to be moved onto the agent workspace; true when it was.
    func move(_ id: UInt32) -> Bool
}

/// No window manager: nothing is listed and nothing moves.
struct NoAgentWorkspace: AgentWorkspace {
    func windows() -> (workspace: Int, ids: Set<UInt32>)? { nil }
    func move(_ id: UInt32) -> Bool { false }
}

/// Polycarp's agent workspace API: one JSON line each way on its Unix socket. No reply means Polycarp isn't running,
/// and the helper carries on as if there were no agent workspace.
struct PolycarpAgentWorkspace: AgentWorkspace {
    var socket: String = FileManager.default.homeDirectoryForCurrentUser
        .appendingPathComponent("Library/Application Support/Polycarp/polycarp.sock").path
    var timeout: TimeInterval = 0.5

    func windows() -> (workspace: Int, ids: Set<UInt32>)? {
        guard let info = ask(["op": "agent", "text": "windows", "caller": "tychicus"]),
              let n = info["workspace"].flatMap(Int.init),
              let list = info["windows"]?.data(using: .utf8),
              let rows = try? JSONSerialization.jsonObject(with: list) as? [[String: Any]] else { return nil }
        return (n, Set(rows.compactMap { ($0["id"] as? NSNumber)?.uint32Value }))
    }

    func move(_ id: UInt32) -> Bool {
        ask(["op": "agent", "text": "move", "args": [String(id)], "caller": "tychicus"]) != nil
    }

    /// The reply's `info` when `ok` is true; nil for a refusal, no reply, or no Polycarp.
    func ask(_ request: [String: Any]) -> [String: String]? {
        guard FileManager.default.fileExists(atPath: socket),
              var line = try? JSONSerialization.data(withJSONObject: request) else { return nil }
        line.append(0x0A)
        let fd = Darwin.socket(AF_UNIX, SOCK_STREAM, 0)
        guard fd >= 0 else { return nil }
        defer { close(fd) }
        var tv = timeval(tv_sec: Int(timeout), tv_usec: Int32((timeout - floor(timeout)) * 1_000_000))
        setsockopt(fd, SOL_SOCKET, SO_RCVTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        setsockopt(fd, SOL_SOCKET, SO_SNDTIMEO, &tv, socklen_t(MemoryLayout<timeval>.size))
        var nosig: Int32 = 1
        setsockopt(fd, SOL_SOCKET, SO_NOSIGPIPE, &nosig, socklen_t(MemoryLayout<Int32>.size))
        var addr = sockaddr_un()
        addr.sun_family = sa_family_t(AF_UNIX)
        let path = Array(socket.utf8)
        guard path.count < MemoryLayout.size(ofValue: addr.sun_path) else { return nil }
        withUnsafeMutableBytes(of: &addr.sun_path) { raw in
            raw.copyBytes(from: path)
            raw[path.count] = 0
        }
        let connected = withUnsafePointer(to: &addr) {
            $0.withMemoryRebound(to: sockaddr.self, capacity: 1) { connect(fd, $0, socklen_t(MemoryLayout<sockaddr_un>.size)) }
        }
        guard connected == 0 else { return nil }
        let sent = line.withUnsafeBytes { write(fd, $0.baseAddress, line.count) }
        guard sent == line.count else { return nil }
        var reply = Data()
        var buf = [UInt8](repeating: 0, count: 4096)
        while !reply.contains(0x0A) {
            let n = read(fd, &buf, buf.count)
            if n <= 0 { break }
            reply.append(buf, count: n)
        }
        guard let obj = try? JSONSerialization.jsonObject(with: reply.prefix { $0 != 0x0A }) as? [String: Any],
              obj["ok"] as? Bool == true else { return nil }
        return (obj["info"] as? [String: Any] ?? [:]).compactMapValues { $0 as? String ?? ($0 as? NSNumber)?.stringValue }
    }
}
