#!/usr/bin/env node
// Draws the Chrome Web Store images from a real run: the built extension in a throwaway headless Chromium, the native host
// it spawns, and a stand-in for Local Studio's Eukhe daemon (cli/test/helpers/fake-eukhe.mjs), the same stack as
// cli/test/e2e-eukhe.test.mjs. Nothing is signed in and no key exists. The page the agent reads is served from this
// script and reached as riverside-trail.example (a reserved name Chromium maps to the loopback server), so no
// 127.0.0.1 address shows in the panel's tool lines.
//
//   TABKYRA_NO_BUMP=1 TABKYRA_OUT_DIR=$PWD/dist-chrome npm run build && (cd cli && npm run build)
//   node scripts/store-shots.mjs [out folder]        (default: store/)
//
// Writes screenshots/{welcome,local-studio,models,agents,site-access}.png at 1280x800, promo-small.png at 440x280 and
// promo-marquee.png at 1400x560. `--raw <folder>` also keeps the bare captures. A capture whose screen shows another
// product name (Polycarp, Tabkyra) is not written, and the run then exits 1 naming it. Needs a Playwright Chromium
// (`cd cli && npx playwright-core install chromium`) and the brand fonts (`cd site && npm ci`).
//
// The images wear the brand media/brand/build.mjs draws (BRAND.md): its palette, its generated icon.svg and
// mark-blue.svg, and Instrument Sans and JetBrains Mono, laid out like the dark README hero, hero.png. The panel is
// captured in its dark scheme whatever this computer's setting is, so every run looks the same.
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { sleep, startHarness } from "../cli/test/e2e-harness.mjs";
import { startFakeEukhe } from "../cli/test/helpers/fake-eukhe.mjs";
import { PALETTE } from "../media/brand/build.mjs";

const repo = join(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const rawAt = argv.indexOf("--raw");
const rawDir = rawAt >= 0 ? resolve(argv[rawAt + 1]) : "";
const out = resolve(argv.find((a, i) => !a.startsWith("--") && (rawAt < 0 || i !== rawAt + 1)) ?? join(repo, "store"));
mkdirSync(join(out, "screenshots"), { recursive: true });
if (rawDir) mkdirSync(rawDir, { recursive: true });
const { chromium } = createRequire(join(repo, "cli/package.json"))("playwright-core");
const extensionId = JSON.parse(readFileSync(join(repo, "src/bridge/extension-id.json"), "utf8")).id;
const PANEL = `chrome-extension://${extensionId}/sidepanel.html`;

/** The generated brand files, as data URLs: a page from setContent cannot read file:// URLs. */
const svg = (name) =>
	`data:image/svg+xml;base64,${readFileSync(join(repo, "media/brand", `${name}.svg`)).toString("base64")}`;
const ICON = svg("icon");
const WAKE = svg("mark-blue");
const font = (pkg, file) =>
	`url(data:font/woff2;base64,${readFileSync(join(repo, "site/node_modules/@fontsource", pkg, "files", file)).toString("base64")})`;
const FONTS = `
@font-face{font-family:"Instrument Sans";font-weight:400;src:${font("instrument-sans", "instrument-sans-latin-400-normal.woff2")}}
@font-face{font-family:"Instrument Sans";font-weight:600;src:${font("instrument-sans", "instrument-sans-latin-600-normal.woff2")}}
@font-face{font-family:"JetBrains Mono";font-weight:400;src:${font("jetbrains-mono", "jetbrains-mono-latin-400-normal.woff2")}}`;

/** hero.png's dark theme (build.mjs THEMES.dark): night ground, light title, the lifted accent line, muted mono. */
const B = { ...PALETTE, line: "#7c9cff", surface: "#111111", border: "#27272a" };
// A blue glow lifts a dark capture off the dark ground, where a drop shadow would not show.
const SHADOW = "0 0 0 1px rgba(124,156,255,.10),0 30px 90px -20px rgba(52,107,241,.45)";
const CSS = `${FONTS}
*{box-sizing:border-box;margin:0}
body{background:${B.night};color:${B.nightText};font-family:"Instrument Sans",system-ui,sans-serif;-webkit-font-smoothing:antialiased}
.wake{position:absolute;pointer-events:none;opacity:.08}
.lockup{display:flex;align-items:center;gap:12px;font-weight:600;font-size:26px;letter-spacing:-.035em}
.lockup img{width:40px;height:40px}
h1,p,.line{text-wrap:balance}
h1{font-weight:600;letter-spacing:-.03em;line-height:1.06}
.slide{position:relative;overflow:hidden;width:1280px;height:800px;display:flex;align-items:center;justify-content:space-between;padding:0 88px 0 80px;background:${B.night}}
.slide .wake{width:1080px;height:1080px;right:-330px;top:-140px}
.copy{position:relative;width:600px}
.copy h1{font-size:56px;margin-top:44px}
.copy p{margin-top:24px;font-size:23px;line-height:1.45;color:${B.line}}
.copy .tag{margin-top:34px;font-family:"JetBrains Mono",monospace;font-size:17px;color:${B.nightMuted};letter-spacing:.01em}
.panel{position:relative;width:420px;height:720px;border-radius:16px;border:1px solid ${B.border};box-shadow:${SHADOW};background:${B.surface}}
.slide.wide{flex-direction:column;justify-content:flex-start;align-items:stretch;padding:48px 72px 0}
.slide.wide .wake{display:none}
.top{position:relative;display:flex;justify-content:space-between;align-items:flex-end;gap:40px}
.top h1{font-size:44px;margin-top:22px}
.top p{max-width:520px;font-size:20px;line-height:1.45;color:${B.line}}
.window{position:relative;margin-top:36px;border-radius:14px 14px 0 0;border:1px solid ${B.border};border-bottom:0;box-shadow:${SHADOW};background:${B.surface};overflow:hidden}
.bar{height:44px;display:flex;align-items:center;gap:8px;padding:0 18px;border-bottom:1px solid ${B.border};background:${B.surface}}
.bar i{width:11px;height:11px;border-radius:50%;background:${B.border}}
.bar span{margin-left:18px;padding:5px 16px;border-radius:8px;background:${B.night};border:1px solid ${B.border};font-family:"JetBrains Mono",monospace;font-size:13px;color:${B.nightMuted}}
.window img{display:block;width:1134px;height:560px;object-fit:cover;object-position:top}
.promo{position:relative;overflow:hidden;height:100vh;display:flex;align-items:center;background:${B.night}}
.promo .word{font-weight:600;letter-spacing:-.035em;line-height:1}
.promo .line{color:${B.line};letter-spacing:-.01em}
.promo.small{gap:22px;padding:0 34px}
.promo.small img.mark{width:104px;height:104px;flex:none}
.promo.small .word{font-size:52px}.promo.small .line{font-size:19px;line-height:1.3;margin-top:12px}
.promo.small .wake{width:420px;height:420px;right:-190px;top:-70px}
.promo.marquee{gap:60px;padding:0 96px}
.promo.marquee img.mark{width:240px;height:240px;flex:none}
.promo.marquee .word{font-size:124px}.promo.marquee .line{font-size:38px;line-height:1.2;margin-top:24px;max-width:820px}
.promo.marquee .sub{font-family:"JetBrains Mono",monospace;font-size:20px;color:${B.nightMuted};margin-top:28px;letter-spacing:.01em}
.promo.marquee .wake{width:900px;height:900px;right:-300px;top:-170px}
`;

/** One CDP connection kept open, so a viewport override lasts until the capture. */
async function session(wsUrl) {
	const ws = new WebSocket(wsUrl);
	await new Promise((ok, fail) => {
		ws.onopen = ok;
		ws.onerror = fail;
	});
	let id = 0;
	const waiting = new Map();
	ws.onmessage = (m) => {
		const msg = JSON.parse(m.data);
		const w = waiting.get(msg.id);
		if (!w) return;
		waiting.delete(msg.id);
		if (msg.error) w.fail(new Error(msg.error.message));
		else w.ok(msg.result);
	};
	const send = (method, params = {}) =>
		new Promise((ok, fail) => {
			waiting.set(++id, { ok, fail });
			ws.send(JSON.stringify({ id, method, params }));
		});
	return {
		send,
		async eval(expression) {
			const r = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
			if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
			return r.result.value;
		},
		/** A capture at width x height (CSS px, 2x), or undefined when the screen shows the old product name. */
		async png(width, height, name) {
			await send("Emulation.setDeviceMetricsOverride", { width, height, deviceScaleFactor: 2, mobile: false });
			await sleep(600);
			const text = await this.eval(VISIBLE_TEXT);
			const old = text.match(OLD_NAME);
			if (old) {
				refused.push(`${name}: the screen says "${text.slice(Math.max(0, old.index - 40), old.index + 40)}"`);
				return undefined;
			}
			const { data } = await send("Page.captureScreenshot", { format: "png" });
			return Buffer.from(data, "base64");
		},
		close: () => ws.close(),
	};
}

/** The text a person can see in the viewport now, shadow roots included. */
const VISIBLE_TEXT = `(() => {
	const seen = [];
	const walk = (root) => {
		const it = document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT);
		for (let n = it.currentNode; n; n = it.nextNode()) {
			if (n.nodeType === 1 && n.shadowRoot) walk(n.shadowRoot);
			if (n.nodeType !== 3 || !n.data.trim() || !n.parentElement?.checkVisibility({ opacityProperty: true, visibilityProperty: true })) continue;
			const range = document.createRange();
			range.selectNodeContents(n);
			const r = range.getBoundingClientRect();
			if (r.width && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth) seen.push(n.data.trim());
		}
	};
	walk(document.documentElement);
	return seen.join(" ");
})()`;

/** The store copy says Tychicus; a capture that shows another product name would contradict it. */
const OLD_NAME = /Polycarp|Tabkyra/i;
const refused = [];

async function waitFor(fn, ms, what) {
	const end = Date.now() + ms;
	for (;;) {
		const value = await fn().catch(() => undefined);
		if (value) return value;
		if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
		await sleep(250);
	}
}

// The page the panel chat reads and the agent works on: a plain page in neutral slate, so no color in it reads as a
// brand, served by this script as riverside-trail.example.
const PAGE = `<!doctype html><html><head><meta charset="utf-8"><title>Riverside Trail conditions</title><style>
body{margin:0;font:17px/1.55 system-ui,sans-serif;background:#f4f6f8;color:#1e2733}
header{background:#263445;color:#fff;padding:22px 48px;font-size:24px;font-weight:650}
header small{display:block;font-size:14px;font-weight:400;opacity:.8}
main{max-width:760px;margin:30px auto;padding:0 28px}
.card{background:#fff;border:1px solid #dde3ea;border-radius:12px;padding:18px 24px;margin:14px 0}
.open{color:#2c7a4b;font-weight:600}.closed{color:#a3412f;font-weight:600}
button{font:inherit;padding:10px 18px;border:0;border-radius:8px;background:#263445;color:#fff}
</style></head><body><header>Riverside Trail<small>Conditions, updated this morning</small></header><main>
<h2>Today on the trail</h2>
<div class="card"><b>North loop (4.2 mi)</b><br><span class="open">Open.</span> Dry and firm. The footbridge at mile 2 was rebuilt last week.</div>
<div class="card"><b>Creek spur (1.1 mi)</b><br><span class="closed">Closed until Friday.</span> High water at the lower ford.</div>
<div class="card"><b>Parking</b><br>The east lot fills by 9 AM on weekends. Overflow parking is at the library on Elm Street.</div>
<p><button>Get trail alerts</button></p>
</main></body></html>`;

const ANSWER = [
	"Here is today's report for Riverside Trail:\n\n",
	"- **North loop (4.2 mi):** open, dry and firm. The footbridge at mile 2 was rebuilt last week.\n",
	"- **Creek spur (1.1 mi):** closed until Friday for high water at the lower ford.\n",
	"- **Parking:** the east lot fills by 9 AM on weekends; overflow is at the library on Elm Street.",
];

const sockets = mkdtempSync(join(tmpdir(), "eu-"));
process.env.EUKHE_DAEMON_SOCKET = join(sockets, "daemon.sock");
let h;
const daemon = await startFakeEukhe({
	path: process.env.EUKHE_DAEMON_SOCKET,
	stepMs: 40,
	// The stand-in model: what a model given the tychicus tools does with "summarize this page".
	turn: async (t) => {
		const url = /Current tab: .*?(https?:\/\/\S+)/.exec(t.message)?.[1];
		await t.delta("I'll read the page. ");
		if (url)
			await t.tool("navigate", { url }, async () => ({ content: (await h.call("navigate", { url })).content }));
		await t.tool("get_page_text", {}, async () => ({ content: (await h.call("get_page_text", {})).content }));
		for (const piece of ANSWER) await t.delta(piece);
	},
});

const HOST = "riverside-trail.example";
const raw = {};
let renderer;
let site;
try {
	// The trail page on a loopback port, reached by a name: Chromium maps riverside-trail.example to it, so the tool
	// lines in the panel show an address a reader expects instead of 127.0.0.1 and a random port.
	site = createServer((_req, res) => {
		res.writeHead(200, { "content-type": "text/html" });
		res.end(PAGE);
	});
	await new Promise((ok) => site.listen(0, "127.0.0.1", ok));
	const page = `http://${HOST}/`;
	h = await startHarness({
		name: "Claude Code",
		chromiumArgs: [
			"--window-size=1280,800",
			`--host-resolver-rules=MAP ${HOST} 127.0.0.1:${site.address().port}`,
			// The name has no certificate; without this Chromium first tries https:// and waits for it to fail.
			"--disable-features=HttpsUpgrades",
		],
	});
	execFileSync(process.execPath, [h.cli, "install", "--local-studio"], {
		env: h.env(),
		stdio: ["ignore", "ignore", "inherit"],
	});
	const version = await (await fetch(`http://${h.devtools}/json/version`)).json();
	const browserWs = version.webSocketDebuggerUrl;
	const { targetId: pageTarget } = await h.cdp(browserWs, "Target.createTarget", { url: page });
	await h.connected();

	// The panel, as on first run: nothing seeded, no key anywhere.
	const { targetId: panelTarget } = await h.cdp(browserWs, "Target.createTarget", { url: PANEL });
	const panelWs = (await h.targets()).find((x) => x.id === panelTarget).webSocketDebuggerUrl;
	const panel = await session(panelWs);
	const W = 420;
	const H = 720;
	await panel.send("Emulation.setDeviceMetricsOverride", { width: W, height: H, deviceScaleFactor: 2, mobile: false });
	// The panel follows the system scheme; the store images show its dark one, as hero.png is, on any computer.
	await panel.send("Emulation.setEmulatedMedia", { features: [{ name: "prefers-color-scheme", value: "dark" }] });

	await waitFor(() => panel.eval(`!!document.querySelector("welcome-setup-dialog")`), 30_000, "the welcome");
	await waitFor(
		async () =>
			/Runs on Local Studio/.test(await panel.eval(`document.querySelector("welcome-setup-dialog").innerText`)),
		15_000,
		"the Local Studio welcome",
	);
	raw.welcome = await panel.png(W, H, "welcome");
	console.log(raw.welcome ? "welcome" : "welcome refused");

	await panel.eval(
		`[...document.querySelector("welcome-setup-dialog").querySelectorAll("button")].find((b) => b.innerText.trim() === "Chat here").click(), true`,
	);
	await waitFor(
		() => panel.eval(`!!document.querySelector("textarea")?.placeholder?.includes("Ask about this page")`),
		20_000,
		"the composer",
	);
	await waitFor(
		async () => /\(local\)/.test(await panel.eval("document.body.innerText")),
		20_000,
		"the Local Studio model",
	);

	// The person is on the trail page; sending shares the active tab, as from the real side panel.
	await h.cdp(browserWs, "Target.activateTarget", { targetId: pageTarget });
	await panel.eval(`(() => {
		const box = document.querySelector("textarea");
		box.focus();
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "Summarize this page");
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
		return true;
	})()`);
	await waitFor(
		async () => (await panel.eval("document.body.innerText")).includes("overflow is at the library"),
		90_000,
		"the answer",
	);
	await h.cdp(browserWs, "Target.activateTarget", { targetId: panelTarget });
	// The capture does not repaint the composer after a send from script; clear it as a sent message leaves it.
	await panel.eval(`(() => {
		const box = document.querySelector("textarea");
		Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(box, "");
		box.dispatchEvent(new Event("input", { bubbles: true }));
		box.blur();
		return true;
	})()`);
	await sleep(800);
	raw.localStudio = await panel.png(W, H, "local-studio");
	console.log(raw.localStudio ? "local-studio" : "local-studio refused");

	// The model picker: Local Studio's local models first, then the subscriptions signed in there.
	await panel.eval(`(() => {
		const find = (root) => {
			for (const el of root.querySelectorAll("button")) if (/\\(local\\)/.test(el.innerText)) return el;
			for (const el of root.querySelectorAll("*")) if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
		};
		find(document).click();
		return true;
	})()`);
	await waitFor(
		async () => /\(subscription\)|ChatGPT|GPT-5\.5/.test(await panel.eval(VISIBLE_TEXT)),
		10_000,
		"the model picker",
	);
	raw.models = await panel.png(W, H, "models");
	console.log(raw.models ? "models" : "models refused");
	await panel.send("Input.dispatchKeyEvent", {
		type: "keyDown",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await panel.send("Input.dispatchKeyEvent", {
		type: "keyUp",
		key: "Escape",
		code: "Escape",
		windowsVirtualKeyCode: 27,
	});
	await sleep(400);

	// An outside agent (the harness's own MCP client, named Claude Code) works in its own tab group.
	await h.call("navigate", { url: page });
	const agentTab = await waitFor(
		async () => (await h.targets()).find((x) => x.type === "page" && x.url === page && x.id !== pageTarget),
		15_000,
		"the agent's tab",
	);
	await h.cdp(browserWs, "Target.activateTarget", { targetId: agentTab.id });
	const agent = await session(agentTab.webSocketDebuggerUrl);
	await agent.send("Emulation.setDeviceMetricsOverride", {
		width: 1280,
		height: 800,
		deviceScaleFactor: 1,
		mobile: false,
	});
	await sleep(500);
	const clicked = await h.call("click", { button: "Get trail alerts" });
	if (!clicked.ok) throw new Error(`the agent's click failed: ${clicked.text}`);
	await sleep(450);
	const agentText = await agent.eval(VISIBLE_TEXT);
	if (OLD_NAME.test(agentText)) refused.push(`agents: the page says ${agentText.match(OLD_NAME)[0]}`);
	else raw.agents = Buffer.from((await agent.send("Page.captureScreenshot", { format: "png" })).data, "base64");
	await agent.send("Emulation.clearDeviceMetricsOverride");
	agent.close();
	console.log(raw.agents ? "agents" : "agents refused");

	// Settings > Agents, at Site access: the sites an agent may open, each one approved by the person.
	await h.cdp(browserWs, "Target.activateTarget", { targetId: panelTarget });
	await panel.eval(`(() => {
		const find = (root) => {
			for (const el of root.querySelectorAll("*")) {
				const tip = [el.getAttribute("data-tip"), el.getAttribute("aria-label"), el.getAttribute("title")].join(" ");
				if (/settings/i.test(tip) && /button/i.test(el.tagName + (el.getAttribute("role") ?? ""))) return el;
				if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
			}
		};
		find(document).click();
		return true;
	})()`);
	await waitFor(
		() => panel.eval(`[...document.querySelectorAll('[role="tab"]')].some((t) => t.innerText.trim() === "Privacy")`),
		10_000,
		"Settings",
	);
	await panel.eval(
		`[...document.querySelectorAll('[role="tab"]')].find((t) => t.innerText.trim() === "Agents").click(), true`,
	);
	await sleep(800);
	await panel.eval(`(() => {
		const walk = (root) => {
			for (const el of root.querySelectorAll("*")) {
				if (el.children.length === 0 && el.textContent.trim() === "Site access") return el;
				if (el.shadowRoot) { const f = walk(el.shadowRoot); if (f) return f; }
			}
		};
		const heading = walk(document);
		heading?.scrollIntoView({ block: "start" });
		// The settings tabs stay pinned over the top of the scroller; leave the heading clear of them.
		for (let el = heading; el; el = el.parentElement ?? el.getRootNode().host)
			if (el.scrollHeight > el.clientHeight && /auto|scroll/.test(getComputedStyle(el).overflowY)) {
				el.scrollTop -= 20;
				break;
			}
		document.activeElement?.blur();
		return true;
	})()`);
	await sleep(500);
	raw.sites = await panel.png(W, H, "site-access");
	console.log(raw.sites ? "site-access" : "site-access refused");
	panel.close();

	if (rawDir) for (const [name, png] of Object.entries(raw)) if (png) writeFileSync(join(rawDir, `${name}.png`), png);

	// Compose each store image in a plain headless page: the headline on the left, the real capture on the right.
	renderer = await chromium.launch({ headless: true });
	const render = async (file, width, height, body, needs = []) => {
		if (needs.some((png) => !png)) return;
		const p = await renderer.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
		await p.setContent(
			`<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head><body>${body}</body></html>`,
		);
		await p.evaluate(() => document.fonts.ready);
		await p.screenshot({ path: join(out, file) });
		await p.close();
		console.log(file);
	};
	const img = (png) => (png ? `data:image/png;base64,${png.toString("base64")}` : "");
	const wake = `<img class="wake" src="${WAKE}" alt="">`;
	const lockup = `<div class="lockup"><img src="${ICON}" alt="">Tychicus</div>`;
	const panelSlide = (title, line, tag, png) => `<div class="slide">${wake}<div class="copy">${lockup}<h1>${title}</h1>
		<p>${line}</p><div class="tag">${tag}</div></div><img class="panel" src="${img(png)}" alt=""></div>`;
	await render(
		"screenshots/welcome.png",
		1280,
		800,
		panelSlide(
			"Browser use for the AI agents you already use",
			"Chat in the side panel, or connect Claude Code, Codex or any MCP agent. With Local Studio, no API key is needed.",
			"No account · no analytics · open source",
			raw.welcome,
		),
		[raw.welcome],
	);
	await render(
		"screenshots/local-studio.png",
		1280,
		800,
		panelSlide(
			"Ask about the page you are on",
			"The side panel reads the tab with you and shows each step it takes, here on a local model through Local Studio.",
			"Local models · your own sign-ins",
			raw.localStudio,
		),
		[raw.localStudio],
	);
	await render(
		"screenshots/models.png",
		1280,
		800,
		panelSlide(
			"Your models, no key needed",
			"Local Studio brings your local models and the plans you signed in to there. Or add an API key from any major provider.",
			"Local Studio · OpenRouter · API keys",
			raw.models,
		),
		[raw.models],
	);
	await render(
		"screenshots/agents.png",
		1280,
		800,
		`<div class="slide wide">${wake}<div class="top"><div>${lockup}<h1>Agents work in their own tabs</h1></div>
		<p>Claude Code, Codex and any MCP agent get a tab group of their own and work in the background. Your tabs keep focus.</p></div>
		<div class="window"><div class="bar"><i></i><i></i><i></i><span>${HOST}</span></div><img src="${img(raw.agents)}" alt=""></div></div>`,
		[raw.agents],
	);
	await render(
		"screenshots/site-access.png",
		1280,
		800,
		panelSlide(
			"You stay in charge",
			"An agent opens a new site only after you allow it, and it hands sign-ins and captchas back to you.",
			"Site permissions · private mode",
			raw.sites,
		),
		[raw.sites],
	);
	await render(
		"promo-small.png",
		440,
		280,
		`<div class="promo small">${wake}<img class="mark" src="${ICON}" alt=""><div><div class="word">Tychicus</div>
		<div class="line">Browser use for your AI agents</div></div></div>`,
	);
	await render(
		"promo-marquee.png",
		1400,
		560,
		`<div class="promo marquee">${wake}<img class="mark" src="${ICON}" alt=""><div><div class="word">Tychicus</div>
		<div class="line">AI agents work in your browser, in their own tab group, while you keep working.</div>
		<div class="sub">Claude Code · Codex · any MCP agent · Local Studio</div></div></div>`,
	);
} finally {
	await renderer?.close().catch(() => {});
	await h?.stop().catch(() => {});
	site?.close();
	await daemon.close();
	rmSync(sockets, { recursive: true, force: true });
}
if (refused.length) {
	console.error(
		`Not written, because the capture shows another product name (rename the panel text, then run this again):\n${refused.join("\n")}`,
	);
	process.exit(1);
}
