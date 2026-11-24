import AppKit
import HandsCore

/// The agent access mode, read by the hands on any thread. Tychicus's helper has no Settings window and no consent
/// sheet yet, so nothing here widens access: the saved value (`defaults write tychicus-hands agentAccessMode read_only`)
/// can narrow it to Read Only, and anything else, Full Access included, reads as Default.
final class AgentAccess {
    static let shared = AgentAccess()
    private let lock = NSLock()
    private var mode = AgentAccessMode(saved: UserDefaults.standard.string(forKey: AgentAccessMode.defaultsKey)).forRemote
    /// Processes `agent open` reached only because of Full Access: an app off the list it started, or one of Donovan's
    /// running apps it claimed a window of. Their windows are refused again once the mode is no longer Full Access,
    /// even on the agent workspace. Kept by start time, so a reused pid is never taken for one.
    private var grants = AgentOwnedSet()
    /// The same grants as saved: those of processes that have quit drop out at the next launch.
    private var saved: [[Double]] = []

    /// Where the grants are kept, so a relaunch of BaneySpaces doesn't forget them: pid and start time pairs.
    static let grantsKey = "agentAccessGrants"

    private init() {
        if mode != .standard { Trace.log("agent access at launch: \(mode.rawValue) (saved)") }
        // Only the processes still running as the same process (pid and start time) come back.
        for pair in UserDefaults.standard.array(forKey: Self.grantsKey) as? [[Double]] ?? [] where pair.count == 2 {
            let pid = Int32(pair[0])
            if let t = AgentOwned.startTime(pid), abs(t - pair[1]) < 0.5 { grants.add(pid, startedAt: t); saved.append(pair) }
        }
    }

    var current: AgentAccessMode {
        lock.lock(); defer { lock.unlock() }
        return mode
    }

    func grant(_ pid: Int32) {
        guard let t = AgentOwned.startTime(pid) else { return }
        lock.lock()
        grants.add(pid, startedAt: t)
        saved.removeAll { Int32($0[0]) == pid }
        saved.append([Double(pid), t])
        let all = saved
        lock.unlock()
        UserDefaults.standard.set(all, forKey: Self.grantsKey)
    }

    /// Whether `pid` is one Full Access let in.
    func grantedUnderFull(_ pid: Int32) -> Bool {
        lock.lock(); let g = grants; lock.unlock()
        return g.contains(pid, startedAt: AgentOwned.startTime(pid))
    }
}
