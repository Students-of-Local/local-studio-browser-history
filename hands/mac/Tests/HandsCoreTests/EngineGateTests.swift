import XCTest
import HandsCore

/// Review of #90: what must hold right before anything is sent to an app.
final class EngineGateTests: XCTestCase {
    private func error(_ code: HandsErrorCode, retry: HandsRetry = .safe) -> HandsError { HandsError(code, "x", suggestion: "", retry: retry) }

    func testARefusingScopeMeansNoAttempt() {
        var attempts = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .success(1) }, stop: { self.error(.inUse) },
                                                         cancelled: { false }, giveUp: Date(), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(attempts, 0)
    }

    func testACallerThatLeftMeansNoAttempt() {
        var attempts = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .success(1) }, stop: { nil },
                                                         cancelled: { true }, giveUp: Date(), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .timeout)
        XCTAssertEqual(attempts, 0)
    }

    func testTheScopeIsReadAgainBeforeARetry() {
        var attempts = 0, checks = 0
        let r: Result<Int, HandsError> = EngineRetry.run(attempt: { attempts += 1; return .failure(self.error(.timeout)) },
                                                         stop: { checks += 1; return checks > 1 ? self.error(.inUse) : nil },
                                                         cancelled: { false }, giveUp: Date().addingTimeInterval(60), pause: {})
        guard case .failure(let e) = r else { return XCTFail("sent") }
        XCTAssertEqual(e.code, .inUse)
        XCTAssertEqual(attempts, 1)
    }

    func testTheSavedAccessModeIsReadOnEveryCall() {
        var saved: String?
        let mode = SavedAccessMode { saved }
        XCTAssertEqual(mode.current, .standard)
        saved = "read_only"
        XCTAssertEqual(mode.current, .readOnly)
        saved = "full"
        XCTAssertEqual(mode.current, .standard)
    }

    func testAWindowItsAppDidNotAnswerForIsRefusedForThisUseOnly() {
        let seen = WindowInspection.decide(full: true, agentOwned: true, panel: false, readable: false, document: nil, handoff: URL(fileURLWithPath: "/tmp"))
        XCTAssertEqual(seen, .unreadable)
        XCTAssertFalse(seen.remembered)
    }

    func testAMenuWatchWhoseLastLookCouldNotReadTheAppIsUnknown() {
        let watch = MenuWatch<Int>(every: 0.01, watch: 0.05)
        watch.start { _ in watch.looked(read: false); return nil }
        XCTAssertEqual(watch.finish(), .unknown)
        let read = MenuWatch<Int>(every: 0.01, watch: 0.05)
        read.start { settled in read.looked(read: settled); return nil }
        XCTAssertEqual(read.finish(), .quiet)
    }
}
