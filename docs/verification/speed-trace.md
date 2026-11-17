# Why click and fill were slow, and what fixed them

The 2026-11-17 study measured Tychicus at a median of 808 ms per click and 532 ms per fill on its form page
(`evals/tasks/site/t02-form`), where the rival tools took under 100 ms. This is the trace behind D50.

## How it was measured

`evals/tasks/speed.mjs` runs the study's latency script against this repo's build: a throwaway headless Chromium
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

`node evals/tasks/speed.mjs 5`, same machine, same build steps, 2026-11-17 (runs: click 72, 73, 70, 73, 75; fill 81,
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
