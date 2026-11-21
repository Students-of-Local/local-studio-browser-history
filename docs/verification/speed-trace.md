# Why click and fill were slow, and what fixed them

The 2026-11-17 study measured Tychicus at a median of 808 ms per click and 532 ms per fill on its form page
(`evals/market/tasks/site/t02-form`), where the rival tools took under 100 ms. This is the trace behind D50.

## How it was measured

`evals/market/tasks/speed.mjs` runs the study's latency script against this repo's build: a throwaway headless Chromium
with the built extension, the native host and the MCP server (`cli/test/e2e-harness.mjs`). Each of 5 runs opens the
form, reads it, fills Full name and clicks the Phone radio; the median of the 5 is reported. To find where the time
went, timestamps were logged temporarily in `fillElement`, `click` (cdp.ts) and `settleAfter` (tools.ts) and read from
the extension's service worker; that logging is not in the commit.

## The trace on fa4bf63

| Call | Phase | ms |
|---|---|---|
| fill | resolve the ref, focus | 2 |
| fill | set the value in the page (`fillElement`) | 206 |
| fill | settle until the page is quiet | 515 |
| click | locate and point (`locate`) | 205 |
| click | mouse input (move, press, release) | 235 |
| click | settle until the page is quiet | 540 |

Medians over 5 runs on fa4bf63 with `speed.mjs`: click 552 ms, fill 518 ms, navigate 333 ms, read_page 6 ms (an earlier
run gave 564 and 516).

## Causes

1. **A fixed two-frame wait after `scrollIntoView`.** `locate` and `fillElement` waited for two animation frames
   (capped at 200 ms) every time, so a scroll could finish. The agent's tab is hidden, and a hidden tab in headless
   Chromium draws about one frame a second, and only when one is asked for, so the wait ran out at 200 ms every time,
   even when the element was already in view and nothing moved. Timers in a hidden tab run normally (20 per second
   measured), so only frames are slow.
2. **The whole quiet window on a page that never reacts.** D41's settle returns after 300 ms with no mutation, request
   or navigation. A radio or a text box on a plain form changes nothing the settle watches, so every such action paid
   the full 300 ms, plus a 100 ms polling step.
3. **The `mouseMoved` reply waits for a frame.** With the first wait gone, click rose to about 1 s: Chrome aligns
   continuous input (mouse moves) to frames, and the reply to `Input.dispatchMouseEvent` for a move comes after the
   hidden tab's next frame (moved at 973 ms, pressed at 980 ms in the trace). A press is discrete input: Chrome flushes
   queued moves before it, so the move still lands first without waiting for its reply.

Frame rate did not change with `--enable-gpu` or the background-throttling flags (about 2 frames a second in every
case), so a flag was not the fix. A 1x1 `Page.captureScreenshot` to force a frame took about 1 s and then timed out.

## Fixes (D50)

- The box is measured before `scrollIntoView`; the two-frame wait runs only if it moved.
- Click and fill settle with `idleMs` 60: when nothing in the first 60 ms shows the page reacting, the action returns.
  Any sign of a reaction (a mutation, a request, a pending navigation, a document still parsing, a refused look, a
  tab opened from the page) keeps the full settle, so a page that reacts is still waited for.
- The `mouseMoved` is sent without awaiting its reply; the press and release are awaited, then the move's reply. A
  click with `on_dialog` still awaits the move before it arms its answer, so a box the page opens on its own in that
  time never takes it.
- `scroll` waits up to 1.1 s for the frame the page owes after its last mutation, so an IntersectionObserver sees
  appended content. This fixed dom-bench infinite-scroll; it adds time only when the page changed and no frame has
  drawn since.

After the fixes, one click: resolve 2 ms, point 3 ms, input 6 ms, settle 60 ms.

## Results

`node evals/market/tasks/speed.mjs 5`, same machine, same build steps, 2026-11-17 (runs: click 72, 73, 70, 73, 75; fill 81,
76, 71, 75, 76):

| Verb | fa4bf63 median | This branch median | Limit |
|---|---|---|---|
| click | 552 ms | 73 ms | under 150 ms |
| fill | 518 ms | 76 ms | under 100 ms |
| navigate | 333 ms | 335 ms | none |
| read_page | 6 ms | 5 ms | none |

## Left as is

Drag awaits each of its 12 mouse moves, because a drop target may need the frames between them, so a drag in a
hidden tab takes about a second per move (dom-bench pointer-sortable takes about 15 s). It predates this branch.

## 2026-11-21: first page text, fill and click (D56)

The market eval's floors (D55, medians of 9 on CI's runner) were firstText 361 ms, fill 80 ms and click 79 ms. The
targets were firstText under 120 ms, fill under 40 ms and click under 50 ms, with dom-bench at 54/54 and tasks at 30/30.

### How it was measured

A temporary branch (`floors/speed-trace`, not for merge) added a `_trace` of timestamps to the navigate, click and fill
results, and each settle probe returned page-clock times for its own phases. `evals/market/tasks/loop.mjs` kept the traces,
and the `market-floors` workflow ran it on 3 runners (runs 44876033610 and 44876541177). Medians of 27 calls, in ms from
the start of the handler:

| Call | Hop | ms |
|---|---|---|
| navigate | check the URL, resolve the tab, action start | 1.3 |
| navigate | the navigation reaches DOMContentLoaded | 23 |
| navigate | tab summary | 24.8 |
| navigate | first probe answers (`readyState` complete, nothing in flight) | 27.7 |
| navigate | second probe, after the 50 ms loaded window | 78.6 |
| navigate | end | 78.9 |
| get_page_text | the whole call, through MCP, socket, host and native messaging | about 3 |
| fill | resolve, look before, action start | 2.3 |
| fill | set the value (`fillElement`) | 5.2 |
| fill | probes, then the 20 ms idle window | 26.5 |
| fill | change report | 30 |
| click | resolve, look before, point, action start | 4.3 |
| click | press, move reply, release | 6.1 |
| click | first probe answers | 56.6 |
| click | change report | 58.5 |

Before this branch, navigate settled with D41's 300 ms quiet window, counted from the first probe after
DOMContentLoaded and polled in 100 ms steps: about 330 of the 361 ms. The transport hops cost about 3 ms in all.

### What changed

- **A short quiet window after a loaded navigation.** Once a probe sees `readyState` complete, no request, loader or
  pending navigation, and no data request that ended recently, navigate waits 50 ms of quiet (`LOADED_QUIET_MS`)
  instead of 300 ms.
- **The full window after data requests.** The probe reads Resource Timing in the page's own clock: a fetch or XHR,
  or a script, style or frame that ended after DOMContentLoaded, counts as activity at its end time. A page that
  draws 150 ms after its fetch (e2e `/nav-fetched`), or opens an alert 200 ms after one, keeps the 300 ms window.
- **A drained idle look.** The idle and loaded probes answer after one MessageChannel turn and a `setTimeout(0)`, so
  a reaction the page posts as a task or a timer is seen before the action returns. `IDLE_MS` dropped from 60 to 20.
- **The loop wakes when the quiet window would end,** not on the next 100 ms step.
- **`Page.windowOpen` counts as the page reacting.** On a loaded machine the new tab's own events came after the 20 ms
  idle window and the change report listed no new tab; the opener's `Page.windowOpen` comes on its own session first.

Races covered by tests: `cli/test/e2e-bridge.test.mjs` "D56: navigate then get_page_text at once reads the new page
as its scripts drew it, never the old one" (pages that redraw at DOMContentLoaded, on load, after a fetch, and that
redirect after load) and "D56: a click or fill whose page answers a task later reports that change, and the next read
sees it"; `test/settle.test.mjs` "D56: Page.windowOpen before the probe's reply holds an idle settle, with no tab event
yet". Removing the Resource Timing rule failed `/nav-fetched` and the existing "Welcome back" alert test; removing
the `Page.windowOpen` handling failed its unit test (`{"settled":true,"ms":25,"idle":true}`).

### Results

`market-floors` on CI, medians of 9 per runner:

| Commit | firstText | fill | click | tasks | dom-bench |
|---|---|---|---|---|---|
| ed35a6e (runs 1, 2, 3) | 84, 84, 85 | 32, 32, 32 | 61, 61, 61 | 30/30 | 54/54 |
| 26cc90d (runs 1, 2, 3) | 85, 89, 87 | 29, 32, 33 | 59, 61, 62 | 30/30 | 54/54 |
| f5525b1, final head on main 97c6304 (runs 1, 2, 3; run 44880929842) | 92, 88, 82 | 35, 33, 32 | 63, 63, 60 | 30/30 | 54/54 |

| Verb | Ceiling before | Worst of 3 after | Target |
|---|---|---|---|
| firstText | 361 ms | 92 ms | under 120 ms, met |
| fill | 80 ms | 35 ms | under 40 ms, met |
| click | 79 ms | 63 ms | under 50 ms, not met |

### Left as is

Click under 50 ms was not reached. The 50 ms is the page's task queue held after the click, not Tychicus's own work:
in the CI trace the move reply came back at 6.3 ms, and the probe began in the page 0.8 ms after it was sent, but its
MessageChannel message was delivered at 50.2 ms (fill and navigate probes: about 1 ms). Chromium's
`DeferRendererTasksAfterInput` holds a page's ordinary tasks after a discrete input until the next frame. In a visible
headless tab that took 2 to 12 ms, and with `--disable-features=DeferRendererTasksAfterInput` it was 0 ms. The page's own
`setTimeout(0)` reaction to the click was held for the same time, so returning earlier would miss it. The agent's tab is
hidden and draws no frame on its own, which matches the 50 ms seen on CI. A flag in the user's own Chrome is not ours to
set, so click stays at about 60 ms.
