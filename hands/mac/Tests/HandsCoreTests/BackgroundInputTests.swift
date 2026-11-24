import XCTest
@testable import HandsCore

/// Background keys and pointer events: what is refused before a post, and how the readings after one are judged (review of
/// #89).
final class BackgroundInputTests: XCTestCase {
    private func refused(_ spec: String) -> Bool {
        if case .failure = KeyParse.sequence(spec) { return true }
        return false
    }

    /// The key equivalents the menu bar's policy refuses, sent as keys (first-F1).
    func testKeysTheMenuPolicyRefusesAreRefused() {
        for key in ["cmd+q", "cmd+shift+q", "ctrl+cmd+q", "cmd+h", "cmd+opt+h", "cmd+o", "cmd+e", "cmd+m", "cmd+p", "cmd+shift+p",
                    "ctrl+cmd+f", "ctrl+cmd+space", "cmd+?", "cmd+shift+\\", "Tab cmd+q"] {
            XCTAssertTrue(refused(key), key)
        }
        for key in ["cmd+a", "cmd+f", "cmd+s", "cmd+z", "cmd+shift+z", "cmd+shift+o", "q", "shift+q", "ctrl+e", "?", "cmd+/", "space", "Return"] {
            XCTAssertFalse(refused(key), key)
        }
    }

    /// On another layout the app reads the character, not the key's ANSI place: cmd+' is cmd+q on Dvorak.
    func testALayoutsOwnCharacterIsRefusedToo() {
        guard case .success(let c) = KeyParse.chord("cmd+'") else { return XCTFail("cmd+' parses") }
        XCTAssertNil(KeyParse.refusal(c))
        XCTAssertNotNil(KeyParse.refusal(c, characters: ["q"]))
    }

    /// Typing grows a field and scrolls its view: the same element, compared by its value (first-F2).
    func testTheSameElementAtANewFrameIsComparedByItsValue() {
        let id = ElementReading.identity(role: "AXTextArea", element: 41)
        XCTAssertEqual(id, ElementReading.identity(role: "AXTextArea", element: 41))
        XCTAssertNotEqual(id, ElementReading.identity(role: "AXTextArea", element: 42))
        let before = ElementReading.text(window: 7, identity: id, value: "a"), after = ElementReading.text(window: 7, identity: id, value: "a\n")
        XCTAssertEqual(DeliveryProof.change((before, after), target: 7), [.text])
    }

    /// No refusal names a fixed pixel scale: a shot is fitted to its longest side (first-F3).
    func testPointRefusalsPointAtTheShotsOwnMapping() {
        for e in [BackgroundRefusal.pointOutside(window: 7), BackgroundRefusal.pointInTitleBar(window: 7)] {
            XCTAssertFalse("\(e)".contains("twice"), "\(e)")
            XCTAssertTrue("\(e)".contains("pixels map"), "\(e)")
        }
    }

    /// Only input that can bring an app forward is the person bringing it forward (second-S1).
    func testAMoveOrPlainTypingDoesNotExplainAnActivation() {
        let came = FrontChange.targetCameForward
        let move = SessionEvent(sourcePid: 0, canActivate: false), press = SessionEvent(sourcePid: 0, canActivate: true)
        XCTAssertEqual(PostGuard.verdict(came, events: [move, press]), .userActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: [move]), .unattributed)
        XCTAssertEqual(PostGuard.verdict(came, events: []), .selfActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: [SessionEvent(sourcePid: 42, canActivate: true)]), .selfActivated)
        XCTAssertEqual(PostGuard.verdict(came, events: nil), .unattributed)
        XCTAssertEqual(PostGuard.verdict(.same, events: [press]), .same)
    }

    /// The item pressed is the one that was judged, never a look-alike that took its place (sol-F1).
    func testAContextItemThatBecameAnotherIsNotPressed() {
        func menu(_ name: String, states: [JSONValue] = []) -> JSONValue {
            .object(["role": "menu", "children": .array([.object(["role": "menuitem", "name": .string(name), "ref_id": "@e1", "states": .array(states)])])])
        }
        XCTAssertEqual(ContextMenu.ref(menu("Rename"), title: "Rename"), "@e1")
        XCTAssertEqual(ContextMenu.ref(menu("Rename "), title: "Rename"), "@e1")
        XCTAssertNil(ContextMenu.ref(menu("Rename\u{2026}"), title: "Rename"))
        XCTAssertNil(ContextMenu.ref(menu("Rename..."), title: "Rename"))
        XCTAssertNil(ContextMenu.ref(menu("Rename", states: ["disabled"]), title: "Rename"))
    }
}
