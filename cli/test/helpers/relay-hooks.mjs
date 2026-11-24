// Preloaded with `node --import` by cli/test/relay-remote.test.mjs, never by the CLI itself: setup's end-to-end check through the
// relay, sent to a local stand-in, because no relay stands behind a test's workers.dev address. The relay's own health answer says
// a connector is there; every other path goes to serve's stand-in on RELAY_HOOK_PORT. A normal run has no way to load it.
globalThis[Symbol.for("polycarp.remote-test.hooks")] = {
	relayFetch: async (url, init) => {
		const { pathname } = new URL(url);
		if (pathname === "/_relay/health") return new Response(JSON.stringify({ ok: true, connected: true }), { headers: { "content-type": "application/json" } });
		return fetch(`http://127.0.0.1:${process.env.RELAY_HOOK_PORT}${pathname}`, init);
	},
};
