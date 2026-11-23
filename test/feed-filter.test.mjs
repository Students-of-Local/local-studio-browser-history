// Feed filters (site-edits/feed-match.ts, feed-filter-core.ts): which posts a filter hides, that the store keeps one canonical
// filter per site and hands the content script exactly the filters that are on, and that on a fixture feed the posts it
// matches are hidden (never removed), new ones from infinite scroll too, with a count the person can click to see them.
import assert from "node:assert/strict";
import { test } from "node:test";
import { Window } from "happy-dom";
import { installFakeChrome } from "./fake-chrome.mjs";

const match = await import("../src/site-edits/feed-match.ts");
const store = await import("../src/site-edits/store.ts");
const core = await import("../src/site-edits/feed-filter-core.ts");
const { filtersFor } = match;
const { filterMatches } = await import("../src/site-edits/apply.ts");

const empty = { edits: [], adBlock: false };
const fakeItem = {};
/** Whether a post with this text (and these authors) is hidden by a filter with these words (and handles). */
const hits = (spec, text, handles = []) => match.compileFilter({ words: [], handles: [], ...spec }).test(text, () => handles, fakeItem);

test("words match in any case, as whole words, and phrases across any spacing", () => {
	assert.ok(hits({ words: ["crypto"] }, "CRYPTO is up again"));
	assert.ok(hits({ words: ["Crypto"] }, "i like crypto."));
	assert.ok(!hits({ words: ["ai"] }, "she said so"), "ai is not in said");
	assert.ok(hits({ words: ["ai"] }, "new AI model (ai) out"));
	assert.ok(!hits({ words: ["cat"] }, "concatenate"));
	assert.ok(hits({ words: ["machine learning"] }, "Machine\n   Learning wins"));
	assert.ok(!hits({ words: ["machine learning"] }, "machine-learning"), "a hyphen is not a space");
	// Letters beyond ASCII are letters: a word edge next to one is no edge.
	assert.ok(hits({ words: ["café"] }, "Le CAFÉ ouvre"));
	assert.ok(!hits({ words: ["caf"] }, "café"));
	// A term that starts or ends with a symbol needs no word edge there, but still needs one on its letter side.
	assert.ok(hits({ words: ["#ai"] }, "love #AI today"));
	assert.ok(!hits({ words: ["#ai"] }, "#aid for all"));
	assert.ok(hits({ words: ["c++"] }, "Learning C++ now"));
	// Regex characters in a plain word are plain.
	assert.ok(!hits({ words: ["a.b"] }, "axb"));
	assert.ok(hits({ words: ["a.b"] }, "see a.b here"));
	assert.ok(!hits({ words: ["   "] }, "anything"), "a blank word hides nothing");
});

test("/regex/ terms: any case unless flags are written, and the same answer every time", () => {
	assert.ok(hits({ words: ["/airdrops?/"] }, "Free AIRDROP now"));
	assert.ok(hits({ words: ["/giveaway|raffle/"] }, "weekly Raffle"));
	assert.ok(!hits({ words: ["/AI/u"] }, "ai lowercase"), "flags written: exactly those");
	assert.ok(hits({ words: ["/AI/u"] }, "AI upper"));
	const f = match.compileFilter({ words: ["/moon/g"], handles: [] });
	// A g flag would make the second test start where the first stopped.
	assert.ok(f.test("to the moon", () => [], fakeItem));
	assert.ok(f.test("to the moon", () => [], fakeItem));
	assert.deepEqual(match.regexTerm("/a,b/gim"), { source: "a,b", flags: "im" });
	assert.equal(match.regexTerm("plain"), undefined);
	assert.ok(match.nestedQuantifier("(a+)+"));
	assert.ok(match.nestedQuantifier("(\\w*)*$"));
	assert.ok(match.nestedQuantifier("(x{2,})+"));
	assert.ok(!match.nestedQuantifier("(ab)+c*"));
	assert.ok(!match.nestedQuantifier("a+b*"));
	// A quantifier deeper than one group, or behind extra parentheses, is still a nested repeat.
	assert.ok(match.nestedQuantifier("((a+))+$"));
	assert.ok(match.nestedQuantifier("((\\w+\\s?))+$"));
	assert.ok(match.nestedQuantifier("(x(y(z*)))*"));
	// Escaped parentheses and character classes are not groups.
	assert.ok(!match.nestedQuantifier("\\(a+\\)+"));
	assert.ok(!match.nestedQuantifier("[(a+)]+"));
	assert.ok(!match.nestedQuantifier("(a)(b+)"));
});

test("handles: @name, u/name, a profile link and the bare name are one account; r/name is a subreddit", () => {
	assert.equal(match.normalizeHandle("@Elon"), "elon");
	assert.equal(match.normalizeHandle("u/Spez"), "spez");
	assert.equal(match.normalizeHandle("/user/abc/"), "abc");
	assert.equal(match.normalizeHandle("https://x.com/Jack"), "jack");
	assert.equal(match.normalizeHandle("r/Politics"), "r/politics");
	assert.ok(hits({ handles: ["@Spammer"] }, "nothing about it", ["spammer"]));
	assert.ok(!hits({ handles: ["@Spammer"] }, "spammer in the text", ["someone"]), "a handle matches the author, not the text");
	assert.ok(hits({ handles: ["r/politics"] }, "", ["alice", "r/politics"]));
	// Handles are read only when a filter has some: a words-only filter never walks a post's links.
	let read = 0;
	match.compileFilter({ words: ["x"], handles: [] }).test("y", () => {
		read++;
		return [];
	}, fakeItem);
	assert.equal(read, 0);
});

test("the store keeps a filter in one canonical form and refuses what can't work", () => {
	const value = store.checkFilter(JSON.stringify({ words: [" Crypto ", "crypto", "/moon/"], handles: ["@Bob", "u/bob", "r/WSB"] }));
	assert.deepEqual(JSON.parse(value), { words: ["Crypto", "/moon/"], handles: ["bob", "r/wsb"] });
	assert.equal(JSON.parse(store.checkFilter(JSON.stringify({ words: ["a"], handles: [], items: " .post " }))).items, ".post");
	for (const [bad, why] of [
		["not json", /JSON/],
		[JSON.stringify({ words: [], handles: [] }), /words or handles/],
		[JSON.stringify({ words: ["/(a+)+/"] }), /freeze/],
		[JSON.stringify({ words: ["/((\\w+\\s?))+$/"] }), /freeze/],
		[JSON.stringify({ words: ["/[/"] }), /can read/],
		[JSON.stringify({ words: ["x".repeat(201)] }), /200/],
		[JSON.stringify({ handles: ["two words"] }), /account name/],
		[JSON.stringify({ words: ["a"], items: ".a { color: red }" }), /Only selectors/],
		[JSON.stringify({ words: Array.from({ length: 101 }, (_, i) => `w${i}`) }), /100 words/],
	]) {
		assert.throws(() => store.checkFilter(bad), why, bad);
	}
	assert.equal(store.normalizeHost("*.reddit.com"), "reddit.com", "a host pattern names the site and its subdomains");
	assert.throws(() => store.normalizeHost("*.com"), store.SiteEditError);
});

test("a filter from an agent is on at once, saved once however it was spelled, and never adds CSS", () => {
	const add = (state, value, id) =>
		store.added(state, { host: "x.com", kind: "filter", value: JSON.stringify(value), note: "no crypto", actor: "agent", who: "claude" }, id, 1);
	const first = add(empty, { words: ["crypto"], handles: [] }, "f1");
	assert.equal(first.edit.on, true);
	assert.equal(first.edit.addedBy, "agent:claude");
	const again = add(first.state, { words: [" crypto", "CRYPTO"], handles: [] }, "f2");
	assert.equal(again.state.edits.length, 1, "the same filter twice is one edit");
	assert.equal(store.hideCss(first.state, "https://x.com/home"), "", "a filter is not a stylesheet");
	assert.equal(match.filterSummary(match.parseFilterValue(first.edit.value)), "Words: crypto");
});

test("store round trip: the content script gets exactly the filters that are on and cover its page", async () => {
	installFakeChrome();
	const s = await import("../src/site-edits/store.ts?ctx=roundtrip");
	const edit = await s.change((state) => {
		const r = s.added(state, { host: "x.com", kind: "filter", value: JSON.stringify({ words: ["crypto"], handles: ["@a"] }), actor: "agent", who: "c" }, "f1", 1);
		return { state: r.state, result: r.edit };
	});
	await s.change((state) => ({
		state: s.added(state, { host: "reddit.com", kind: "filter", value: JSON.stringify({ words: ["nba"] }), actor: "agent", who: "c" }, "f2", 2).state,
		result: undefined,
	}));
	const stored = (await chrome.storage.local.get(s.STORAGE_KEY))[s.STORAGE_KEY];
	assert.deepEqual(filtersFor(stored, "https://mobile.x.com/home"), [{ words: ["crypto"], handles: ["a"] }]);
	assert.deepEqual(filtersFor(stored, "https://old.reddit.com/"), [{ words: ["nba"], handles: [] }]);
	assert.deepEqual(filtersFor(stored, "https://example.com/"), []);
	await s.change((state) => ({ state: s.switched(state, edit.id, false, "agent"), result: undefined }));
	assert.deepEqual(filtersFor((await chrome.storage.local.get(s.STORAGE_KEY))[s.STORAGE_KEY], "https://x.com/"), [], "off hides nothing");
	await s.change((state) => ({ state: s.removed(state, edit.id), result: undefined }));
	assert.equal((await s.load()).edits.length, 1);
	// Garbage in storage hides nothing and throws nothing.
	assert.deepEqual(filtersFor({ edits: [{ kind: "filter", on: true, host: "x.com", value: "{" }] }, "https://x.com/"), []);
	assert.deepEqual(filtersFor(undefined, "https://x.com/"), []);
});

test("the worker answers only its own content script in a web page's top frame, and sends every tab its filters after a change", async () => {
	installFakeChrome();
	const sent = [];
	chrome.tabs.sendMessage = async (tabId, message, options) => {
		sent.push({ tabId, message, options });
	};
	const xTab = await chrome.tabs.create({ url: "https://x.com/home" });
	const otherTab = await chrome.tabs.create({ url: "https://example.com/" });
	await chrome.tabs.create({ url: "chrome://settings/" });
	const apply = await import("../src/site-edits/apply.ts?ctx=messages");
	const s = await import("../src/site-edits/store.ts?ctx=messages");
	apply.startSiteEdits();
	const edit = await s.change((state) => {
		const r = s.added(state, { host: "x.com", kind: "filter", value: JSON.stringify({ words: ["crypto"] }), actor: "agent", who: "c" }, "m1", 1);
		return { state: r.state, result: r.edit };
	});
	const ask = (sender) =>
		new Promise((resolve) => {
			let answered = false;
			for (const fn of chrome.runtime.onMessage.listeners)
				fn({ type: "tk-feed-filter:get" }, sender, (r) => {
					answered = true;
					resolve(r);
				});
			setTimeout(() => !answered && resolve("no answer"), 500);
		});
	const page = { id: chrome.runtime.id, frameId: 0, url: "https://x.com/home", tab: { id: xTab.id } };
	assert.deepEqual(await ask(page), [{ words: ["crypto"], handles: [] }]);
	assert.deepEqual(await ask({ ...page, frameId: 3 }), [], "a frame inside the page gets nothing");
	assert.deepEqual(
		await ask({ ...page, frameId: 7, frameType: "outermost_frame" }),
		[{ words: ["crypto"], handles: [] }],
		"a prerendered page is a top document though not frame 0",
	);
	assert.deepEqual(await ask({ ...page, frameType: "sub_frame" }), [], "a frame inside the page gets nothing, whatever its number");
	assert.deepEqual(await ask({ ...page, id: "another-extension" }), [], "another extension gets nothing");
	assert.deepEqual(await ask({ ...page, url: "chrome-extension://fake/sidepanel.html" }), [], "only web pages ask");
	assert.deepEqual(await ask({ ...page, url: "https://example.com/" }), [], "a page gets its own site's filters only");

	// Turned off: every web tab is sent what it has now, so the x.com page shows its posts again.
	const until = async (ok) => {
		for (let i = 0; i < 100 && !ok(); i++) await new Promise((r) => setTimeout(r, 10));
	};
	sent.length = 0;
	await s.change((state) => ({ state: s.switched(state, edit.id, false, "agent"), result: undefined }));
	// The push from adding the filter may still land first; the newest one to the tab is what it ends with.
	const lastToX = () => sent.findLast((m) => m.tabId === xTab.id);
	await until(() => lastToX()?.message.filters.length === 0);
	const toX = lastToX();
	assert.deepEqual(toX.message, { type: "tk-feed-filter:set", filters: [] });
	assert.deepEqual(toX.options, { frameId: 0 }, "the top frame only");
	assert.ok(sent.some((m) => m.tabId === otherTab.id));
	assert.ok(!sent.some((m) => m.tabId !== xTab.id && m.tabId !== otherTab.id), "no message to a browser page");
	assert.ok(sent.every((m) => !JSON.stringify(m.message).includes("tk-site-edits")), "filters only, never the stored state");
});

test("the content script is registered for each filter's site and its subdomains; an IP address gets no wildcard", () => {
	assert.deepEqual(filterMatches(["x.com", "127.0.0.1"]), ["*://x.com/*", "*://*.x.com/*", "*://127.0.0.1/*"]);
});

// ----- DOM: the filter on fixture feeds -----

function page(hostname, body) {
	const window = new Window({ url: `https://${hostname}/` });
	window.document.body.innerHTML = body;
	return window;
}
const tick = () => new Promise((r) => setTimeout(r, 0));
const hidden = (doc) => [...doc.querySelectorAll(`.${core.HIDDEN_CLASS}`)];
const badge = (doc) => doc.querySelector("[data-tychicus=feed-filter]")?.shadowRoot;

const tweet = (handle, text) =>
	`<div data-testid="cellInnerDiv"><article data-testid="tweet"><div data-testid="UserAvatar-Container-${handle}"></div>` +
	`<div data-testid="User-Name"><a href="/${handle}">${handle}</a><a href="/${handle}/status/1">1h</a></div>` +
	`<div data-testid="tweetText">${text}</div></article></div>`;

test("x.com: matched posts' list cells are hidden, never removed, and a count shows; a click reveals, the x closes it", async () => {
	const window = page(
		"x.com",
		`<main><div aria-label="Timeline">${tweet("alice", "Bitcoin and CRYPTO news")}${tweet("bob", "a quiet walk")}${tweet("spammer", "buy now")}${tweet("carol", "said nothing")}</div></main>`,
	);
	const doc = window.document;
	const before = doc.querySelectorAll("*").length;
	const f = core.startFeedFilter(doc, [{ words: ["crypto", "ai"], handles: ["@Spammer"] }], { hostname: "x.com" });
	assert.deepEqual(
		hidden(doc).map((el) => el.querySelector("[data-testid=User-Name] a").textContent),
		["alice", "spammer"],
	);
	assert.ok(hidden(doc).every((el) => el.getAttribute("data-testid") === "cellInnerDiv"), "the whole list cell goes");
	assert.ok(doc.getElementById("tk-feed-filter-style").textContent.includes("display: none !important"));
	assert.equal(f.stats().hidden, 2);
	assert.equal(doc.querySelectorAll("article").length, 4, "no post removed");
	const root = badge(doc);
	assert.match(root.textContent, /2 hidden by your filter/);
	root.querySelector("button.show").click();
	assert.ok(doc.documentElement.classList.contains(core.REVEAL_CLASS));
	assert.match(root.textContent, /Showing 2 filtered/);
	root.querySelector("button.x").click();
	assert.ok(!doc.documentElement.classList.contains(core.REVEAL_CLASS), "closing the badge hides them again");
	assert.equal(badge(doc), undefined);
	assert.equal(doc.querySelectorAll("*").length - before, 1, "only the stylesheet was added");
	f.stop();
	window.close();
});

test("infinite scroll: new posts are checked as they arrive, text that fills in later too, and a reused row is shown again", async () => {
	const window = page("x.com", `<div id="tl">${tweet("bob", "hello")}</div>`);
	const doc = window.document;
	const f = core.startFeedFilter(doc, [{ words: ["crypto"], handles: [] }], { hostname: "x.com" });
	assert.equal(hidden(doc).length, 0);
	assert.equal(badge(doc), undefined, "no badge when nothing is hidden");
	const tl = doc.getElementById("tl");
	tl.insertAdjacentHTML("beforeend", tweet("dan", "crypto again") + tweet("erin", "fine"));
	await tick();
	f.flush();
	assert.equal(hidden(doc).length, 1);
	// A post whose text arrives after the post itself.
	tl.insertAdjacentHTML("beforeend", tweet("fay", ""));
	await tick();
	f.flush();
	assert.equal(hidden(doc).length, 1);
	const late = doc.createElement("span");
	late.textContent = "late crypto take";
	[...tl.querySelectorAll("[data-testid=tweetText]")].at(-1).append(late);
	await tick();
	f.flush();
	assert.equal(hidden(doc).length, 2);
	assert.match(badge(doc).textContent, /2 hidden/);
	// X reuses a cell for another post: the old post leaves, a clean one takes its place.
	const cell = hidden(doc)[0];
	cell.querySelector("article").remove();
	cell.insertAdjacentHTML("beforeend", '<article data-testid="tweet"><div data-testid="tweetText">gardening</div></article>');
	await tick();
	f.flush();
	assert.ok(!cell.classList.contains(core.HIDDEN_CLASS));
	assert.equal(f.stats().hidden, 1);
	// Filters changed by the person: everything is checked again, with nothing hidden in between.
	f.update([]);
	assert.equal(hidden(doc).length, 0);
	assert.equal(badge(doc), undefined);
	f.update([{ words: ["gardening"], handles: [] }]);
	assert.deepEqual(hidden(doc), [cell]);
	f.stop();
	assert.equal(hidden(doc).length, 0);
	window.close();
});

test("YouTube: Shorts means the format, so Shorts shelves and tiles go and a title with the word stays; channels by handle", () => {
	const window = page(
		"www.youtube.com",
		`<ytd-rich-grid-renderer>
			<ytd-rich-item-renderer id="v1"><a href="/watch?v=1">Best running shorts review</a><a href="/@gearguy">Gear Guy</a></ytd-rich-item-renderer>
			<ytd-rich-item-renderer id="v2"><a href="/shorts/abc">funny cat</a><a href="/@cats">Cats</a></ytd-rich-item-renderer>
			<ytd-reel-shelf-renderer id="shelf"><h2 id="title">Shorts</h2><ytd-reel-item-renderer><a href="/shorts/x">x</a></ytd-reel-item-renderer></ytd-reel-shelf-renderer>
			<ytd-rich-item-renderer id="v3"><a href="/watch?v=3">Election night</a><a href="/@NewsNow">News Now</a></ytd-rich-item-renderer>
		</ytd-rich-grid-renderer>`,
	);
	const doc = window.document;
	core.startFeedFilter(doc, [{ words: ["Shorts"], handles: ["@newsnow"] }], { hostname: "www.youtube.com", badge: false });
	const ids = hidden(doc).map((el) => el.id || el.tagName.toLowerCase());
	assert.ok(ids.includes("v2") && ids.includes("shelf") && ids.includes("v3"), ids.join());
	assert.ok(!ids.includes("v1"), "a title that says shorts is not a Short");
	window.close();
});

test("Reddit, Hacker News and the generic fallback find their posts and authors; a filter's own selector is used as given", () => {
	let window = page(
		"www.reddit.com",
		`<article id="a1"><shreddit-post author="spez" subreddit-prefixed-name="r/announcements" post-title="Update">Update</shreddit-post></article>
		<article id="a2"><shreddit-post author="alice" subreddit-prefixed-name="r/Politics">Vote</shreddit-post></article>
		<article id="a3"><shreddit-post author="bob" subreddit-prefixed-name="r/aww">Puppy</shreddit-post></article>`,
	);
	core.startFeedFilter(window.document, [{ words: [], handles: ["u/spez", "r/politics"] }], { hostname: "www.reddit.com", badge: false });
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["a1", "a2"], "the article around the post goes");
	window.close();

	window = page(
		"news.ycombinator.com",
		`<table><tr class="athing" id="1"><td>Show HN: a crypto wallet</td></tr><tr id="1s"><td><a class="hnuser">pg</a></td></tr><tr class="spacer" id="1p"></tr>
		<tr class="athing" id="2"><td>Rust 2.0</td></tr><tr id="2s"><td><a class="hnuser">dang</a></td></tr><tr class="spacer" id="2p"></tr>
		<tr class="athing" id="3"><td>Gardening</td></tr><tr id="3s"><td><a class="hnuser">tptacek</a></td></tr><tr class="spacer" id="3p"></tr></table>`,
	);
	core.startFeedFilter(window.document, [{ words: ["crypto"], handles: ["tptacek"] }], { hostname: "news.ycombinator.com", badge: false });
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["1", "1s", "1p", "3", "3s", "3p"], "the byline row and spacer go with the title");
	window.close();

	window = page(
		"mastodon.social",
		`<main><article id="m1"><a href="/@alice">alice</a> on crypto</article><article id="m2"><a href="/@bob">bob</a> hi</article>
		<div class="card" id="c1">crypto card</div><div class="card" id="c2">ok card</div></main>`,
	);
	core.startFeedFilter(window.document, [{ words: [], handles: ["@bob"] }], { hostname: "mastodon.social", badge: false });
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["m2"]);
	window.close();

	window = page("example.com", `<div class="card" id="c1">crypto card</div><div class="card" id="c2">ok card</div>`);
	core.startFeedFilter(window.document, [{ words: ["crypto"], handles: [], items: "div.card, body" }], { hostname: "example.com", badge: false });
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["c1"], "the page itself is never hidden, whatever the selector");
	window.close();
});

test("two filters whose selectors overlap both get a say on a post", () => {
	const window = page("example.com", `<main><article id="a">nba tonight</article><article id="b">fine</article></main>`);
	core.startFeedFilter(
		window.document,
		[
			{ words: ["crypto"], handles: [], items: "main article" },
			{ words: ["nba"], handles: [] },
		],
		{ hostname: "example.com", badge: false },
	);
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["a"]);
	window.close();
});

test("a selector the browser can't read skips only its own filter", () => {
	const window = page("example.com", `<article id="a">crypto</article><article id="b">nba</article>`);
	core.startFeedFilter(
		window.document,
		[
			{ words: ["crypto"], handles: [], items: "article:nope(" },
			{ words: ["nba"], handles: [] },
		],
		{ hostname: "example.com", badge: false },
	);
	assert.deepEqual(hidden(window.document).map((e) => e.id), ["b"]);
	window.close();
});

test("a post's text keeps blocks apart and inline runs whole, so word edges hold on real markup", () => {
	const window = page(
		"x.com",
		`<article id="a"><div><a href="/dan"><time>1h</time></a></div><div>crypto again</div></article><article id="b"><div><b>cry</b>pto<script>var x="moon"</script></div></article>`,
	);
	const doc = window.document;
	assert.equal(core.itemText(doc.getElementById("a")), "1h\ncrypto again", "textContent would give 1hcrypto");
	assert.equal(core.itemText(doc.getElementById("b")), "crypto", "no script text, and <b>cry</b>pto is one word");
	assert.equal(core.itemText(doc.getElementById("a"), 4), "1h\nc");
	window.close();
});
