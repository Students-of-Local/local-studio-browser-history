# Task set

Ten browser tasks on a local site, solved by a fixed script through Tychicus's own MCP tools, and checked by what
the page itself received. Not a model eval: every run takes the same steps, so a failure is the tool's.

## Origin

Copied on 2026-11-17 from the Tychicus study (`_work/2026-11-17-tychicus-study/tasks/` in the owner's workspace,
not a repository):

| Here | There | Changes |
|---|---|---|
| `site/`, `fixtures/`, `server.mjs`, `tasks.mjs` | same paths | none |
| `solves.mjs` | `solves.mjs` | none |
| `lib.mjs` | `adapters/polycarp.mjs`, `lib/drivers.mjs` | runs this repo's e2e harness (`cli/test/e2e-harness.mjs`) instead of an installed Tychicus; `clickNewTab` takes the tab from the click's `newTabs` (D50) instead of `tabs_context` |
| `run.mjs` | `run.mjs` | scripted mode and this tool only |
| `speed.mjs` | `lib/latency.mjs` | the same verbs and page; fails over the limits below |

## Tasks

| id | Kind | Pass when |
|---|---|---|
| t01-read | Read a table with a decoy row | answer is the K7 battery (not K7 Lite) |
| t02-form | Text, email, select, radio, checkbox, submit | the page posts every value |
| t03-multitab | Code on a `target=_blank` page, redeem on the first | the posted code matches this run's voucher |
| t04-checkout | Duplicate "Add to cart" buttons, cart, checkout form | 2 Blue Mugs, 1 Tea Tin, the address, Express |
| t05-iframe | Payment form in a cross-site frame (`localhost` vs `127.0.0.1`) | the frame posts the card holder |
| t06-shadow | Field and button inside nested open shadow roots | the new name is posted |
| t07-upload | File input | the posted file's first line is `RECEIPT-0091` |
| t08-stale | The list re-renders after Refresh; refs read before it go stale | invoice 3307 approved and no other |
| t09-long | 400 sections; the phrase is in section 371, a decoy in section 12 | this run's phrase is posted |
| t10-dialog | `confirm()` then `prompt()` asking for DELETE | deleted with `DELETE` typed |

Secrets (voucher, phrase) are new on every reset, so an answer cannot be memorized.

## Run

Build first: `TABKYRA_NO_BUMP=1 npm run build` at the root and `npm run build` in `cli/`, and have Playwright's
Chromium (`cd cli && npx playwright-core install chromium`).

```sh
node evals/tasks/run.mjs --repeat 3        # all ten, three times; exits 1 unless every run passes
node evals/tasks/run.mjs --only t08-stale  # one task
node evals/tasks/speed.mjs 5               # median ms per verb on t02's form; exits 1 at click >= 150 or fill >= 100
node evals/tasks/server.mjs                # just the site, to look at it
```

CI runs both on every pull request (the `tasks` job in `.github/workflows/ci.yml`).
