// The community catalog moved with the repo: baney75/tychicus first, and the archived baney75/tabkyra release only while
// the new repo has published none. An override (TYCHICUS_COMMUNITY_URL) is the only source.
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { after, test } from "node:test";
import { loadTs } from "./helpers/bundle-ts.mjs";

const { CATALOG_URL, OLD_CATALOG_URL, catalogSources, fetchFirst } = await loadTs(
	`export { CATALOG_URL, OLD_CATALOG_URL, catalogSources, fetchFirst } from "@src/community-catalog.ts";`,
);

const served = new Map([
	["/new/community-catalog.json", '{"serial":2}'],
	["/new/community-catalog.json.minisig", "sig-new"],
	["/old/community-catalog.json", '{"serial":1}'],
	["/old/community-catalog.json.minisig", "sig-old"],
]);
const server = createServer((req, res) => {
	const body = served.get(req.url ?? "");
	if (body === undefined) return res.writeHead(404).end();
	if (req.url?.startsWith("/broken/")) return res.writeHead(500).end();
	res.writeHead(200).end(body);
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
after(() => server.close());
const base = (path) => `http://127.0.0.1:${server.address().port}/${path}`;

test("the catalog is read from baney75/tychicus, then the archived baney75/tabkyra release", () => {
	const saved = ["TYCHICUS_COMMUNITY_URL", "POLYCARP_COMMUNITY_URL", "TABKYRA_COMMUNITY_URL"].map((k) => [k, process.env[k]]);
	try {
		for (const [k] of saved) delete process.env[k];
		assert.equal(CATALOG_URL, "https://github.com/baney75/tychicus/releases/download/community-catalog");
		assert.equal(OLD_CATALOG_URL, "https://github.com/baney75/tabkyra/releases/download/community-catalog");
		assert.deepEqual(catalogSources(), [CATALOG_URL, OLD_CATALOG_URL]);
		process.env.TYCHICUS_COMMUNITY_URL = "/tmp/catalog";
		assert.deepEqual(catalogSources(), ["/tmp/catalog"], "an override is the only source");
	} finally {
		for (const [k, v] of saved) v === undefined ? delete process.env[k] : (process.env[k] = v);
	}
});

test("fetchFirst takes the first source that has published, and falls back only when one hasn't", async () => {
	const [data, sig] = await fetchFirst([base("new"), base("old")]);
	assert.equal(data.toString(), '{"serial":2}');
	assert.equal(sig, "sig-new");
	const [oldData, oldSig] = await fetchFirst([base("missing"), base("old")]);
	assert.equal(oldData.toString(), '{"serial":1}');
	assert.equal(oldSig, "sig-old");
	await assert.rejects(fetchFirst([base("missing"), base("gone")]), (err) => err.constructor.name === "NotPublished");
});

test("a source that fails for another reason is not skipped over to the old one", async () => {
	served.set("/broken/community-catalog.json", "x");
	served.set("/broken/community-catalog.json.minisig", "x");
	await assert.rejects(fetchFirst([base("broken"), base("old")]), /500/);
});
