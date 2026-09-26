/* Browser test for The Docks. Based on the SDK's testGame harness (scripts/testing.mjs):
 * same real runtime, mock wallet and mock RPC fixtures, plus one extra read-only mock:
 * the Generations tokenURI for fixture Friend #7730, recorded from Robinhood mainnet,
 * so the on-chain land import can be exercised offline.
 * Run from the SDK root:  node games/the-docks/browser-test.mjs [desktop|phone] [--fail-import] */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium } from "playwright";
import { decodeFunctionData, encodeFunctionResult, parseAbi } from "viem";
import { buildGame, createGameServer } from "../../scripts/dev-game.mjs";
import { installFixture, createArtworkFixture } from "../../scripts/browser-fixture.mjs";

const tag = process.argv[2] ?? "desktop";
const failImport = process.argv.includes("--fail-import");
const [width, height] = tag === "phone" ? [360, 480] : [960, 640];
const dir = resolve("games/the-docks");
const out = resolve("artifacts"); await mkdir(out, { recursive: true });
const shot = name => page.screenshot({ path: join(out, `docks-${tag}${failImport ? "-fallback" : ""}-${name}.png`) });
const tokens = JSON.parse(await readFile(join(dir, "fixtures/tokens.json"), "utf8"));
const ABI = parseAbi(["function tokenURI(uint256) view returns (string)", "function ownerOf(uint256) view returns (address)"]);
const FIXTURE_OWNER = "0x1111111111111111111111111111111111111111";   // the SDK fixture's owner of #7730
const upgraded = true;                                               // #7573 reads as tier 2 on its second read (an "upgrade")
let calls = 0;

const temporary = await mkdtemp(join(tmpdir(), "docks-test-"));
const build = await buildGame(dir, { outdir: join(temporary, "dist") });
const server = createGameServer(build.outdir);
await new Promise(r => server.listen(0, "127.0.0.1", r));
const origin = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });
const context = await browser.newContext({ viewport: { width, height }, hasTouch: width < 500 });
const page = await context.newPage();
page.setDefaultTimeout(30000);
const errors = [];
page.on("pageerror", e => errors.push(e.message));
let fixture;
try {
  fixture = await installFixture(page, origin, { artworkCall: await createArtworkFixture() });
  // Registered after the SDK fixture, so it is consulted first; everything else falls through.
  await page.route("https://rpc.mainnet.chain.robinhood.com/**", async route => {
    const body = route.request().postDataJSON?.();
    if (!body || Array.isArray(body) || body.method !== "eth_call") return route.fallback();
    let call; try { call = decodeFunctionData({ abi: ABI, data: body.params[0].data }); } catch { return route.fallback(); }
    const id = String(call.args[0]);
    const reply = result => route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result }, headers: { "access-control-allow-origin": "*" } });
    if (call.functionName === "ownerOf") {
      if (id === "7730" || id === "3412") return route.fallback();          // the runtime's identity checks stay on the SDK fixture
      // pretend the tester also holds #7573 (for the add-a-Friend flow)
      return reply(encodeFunctionResult({ abi: ABI, functionName: "ownerOf", result: id === "7573" ? FIXTURE_OWNER : tokens[id]?.owner ?? "0x000000000000000000000000000000000000dEaD" }));
    }
    if (failImport && id === "7730") return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "fixture: tokenURI unavailable" } }, headers: { "access-control-allow-origin": "*" } });
    let uri = tokens[id]?.uri;
    if (!uri) return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: 3, message: "execution reverted" } }, headers: { "access-control-allow-origin": "*" } });
    if (upgraded && id === "7573" && ++calls > 1) {
      const j = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
      j.attributes = j.attributes.map(a => a.trait_type === "Activation tier" ? { ...a, value: 2 } : a);
      uri = "data:application/json;base64," + Buffer.from(JSON.stringify(j)).toString("base64");
    }
    return reply(encodeFunctionResult({ abi: ABI, functionName: "tokenURI", result: uri }));
  });
  const game = page.frameLocator("iframe");
  await page.goto(origin);
  await page.getByRole("button", { name: /^Connect (wallet|Browser wallet)$/ }).click();
  await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
  if (failImport) { await game.getByText(/Couldn't read your Friend from chain/).waitFor(); await shot("fail-state"); console.log("ok", tag, "(import failure shows retry)"); process.exit(0); }
  await game.locator("img.docks-land").first().waitFor();
  await page.waitForTimeout(1200);
  await shot("start");
  const btn = name => game.getByRole("button", { name, exact: false }).first();
  // dock
  await btn("Docks").click();
  await game.getByRole("img", { name: /Map: \d+ docked plots/ }).waitFor();
  await shot("map");
  await game.locator(".docks-slots button").first().click();
  await game.getByText(/Docked beside \d/).waitFor();
  await page.waitForTimeout(600);
  await shot("docked");
  // add a second Friend I hold, then arrange it
  await btn("My plot").click();
  await game.getByLabel("Add another activated Friend you hold").fill("7843");
  await game.getByRole("button", { name: "Add", exact: true }).click();
  await page.waitForTimeout(1500); await shot("after-add");
  await game.getByText(/already in the docks/).waitFor();
  await game.getByLabel("Add another activated Friend you hold").fill("7060");
  await game.getByRole("button", { name: "Add", exact: true }).click();
  await game.getByText(/isn't held by the same wallet/).waitFor();
  await game.getByLabel("Add another activated Friend you hold").fill("7573");
  await game.getByRole("button", { name: "Add", exact: true }).click();
  await game.getByText(/#7573 joined your plot/).waitFor();
  await game.getByRole("button", { name: "Close My plot" }).click();
  await btn("My plot").click();
  await game.getByRole("button", { name: "✥ Arrange Friends" }).click();
  await game.getByRole("toolbar", { name: "Arrange your Friends" }).waitFor();
  await game.getByRole("button", { name: "Move down-right" }).click();
  await shot("arrange");
  await btn("Done").click();
  // walk toward neighbours for a bit
  for (const k of ["d", "w", "a", "s"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
  await shot("walk");
  // manual on-chain check
  await btn("Check").click();
  await game.getByText(/On-chain check: #7573 updated \(G3 T1 → G3 T2\)/).waitFor();
  const alerts = await game.locator("[role=alert]").allTextContents();
  assert.deepEqual(alerts, [], "No in-game alerts");
  assert.deepEqual([...errors, ...fixture.errors], [], "Browser errors");
  console.log("ok", tag, failImport ? "(fallback)" : "(chain import)");
} catch (e) {
  console.error("FAIL", e.message, [...errors, ...(fixture?.errors ?? [])]); await shot("fail").catch(() => {}); process.exitCode = 1;
} finally {
  await browser.close(); server.closeAllConnections(); server.close(); await build.close(); await rm(temporary, { recursive: true, force: true });
}
