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
import { encodeFunctionResult, parseAbi } from "viem";
import { buildGame, createGameServer } from "../../scripts/dev-game.mjs";
import { installFixture, createArtworkFixture } from "../../scripts/browser-fixture.mjs";

const tag = process.argv[2] ?? "desktop";
const failImport = process.argv.includes("--fail-import");
const [width, height] = tag === "phone" ? [360, 480] : [960, 640];
const dir = resolve("games/the-docks");
const out = resolve("artifacts"); await mkdir(out, { recursive: true });
const shot = name => page.screenshot({ path: join(out, `docks-${tag}${failImport ? "-fallback" : ""}-${name}.png`) });
const TOKEN_URI = "0xc87b56dd";
const uri = (await readFile(join(dir, "fixtures/token-7730-uri.txt"), "utf8")).trim();

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
    const one = body && !Array.isArray(body) && body.method === "eth_call" && body.params?.[0]?.data?.startsWith(TOKEN_URI);
    if (!one) return route.fallback();
    if (failImport) return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "fixture: tokenURI unavailable" } }, headers: { "access-control-allow-origin": "*" } });
    const result = encodeFunctionResult({ abi: parseAbi(["function tokenURI(uint256) view returns (string)"]), functionName: "tokenURI", result: uri });
    return route.fulfill({ json: { jsonrpc: "2.0", id: body.id, result }, headers: { "access-control-allow-origin": "*" } });
  });
  const game = page.frameLocator("iframe");
  await page.goto(origin);
  await page.getByRole("button", { name: /^Connect (wallet|Browser wallet)$/ }).click();
  await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
  await game.locator("canvas.docks-canvas").waitFor();
  await page.waitForTimeout(1500);
  await shot("start");
  const btn = name => game.getByRole("button", { name, exact: false }).first();
  const confirm = () => page.getByRole("button", { name: "Confirm preview", exact: true }).click();

  await btn("Home").click();
  if (failImport) await game.getByText("Stand-in land").waitFor();
  else { await game.getByText("Imported from chain").waitFor(); await game.getByText(/5 objects placed/).waitFor(); }
  await shot("home");
  await page.keyboard.press("Escape");

  await btn("Docks").click();
  await game.locator(".docks-map-row").nth(1).getByRole("button", { name: /Dock here/ }).click();
  await game.getByText(/Docked! 3 neighbours/).waitFor();
  await page.waitForTimeout(800);
  await shot("docked");
  // walk down the gangway to the deck and use the nearest thing
  await page.keyboard.down("s"); await page.waitForTimeout(2200); await page.keyboard.up("s");
  await page.waitForTimeout(400);
  await shot("walk");
  await btn("Market").click(); await btn("500").click(); await game.getByText(/\+500 credits/).waitFor();
  await page.keyboard.press("Escape");
  await btn("Home").click(); await btn("Buy 1").click(); await confirm();
  await btn("Open (1)").click(); await confirm();
  await game.getByRole("heading", { name: /found a .* Charm/ }).waitFor();
  await btn("Keep charm").click();
  const alerts = await game.locator("[role=alert]").allTextContents();
  assert.deepEqual(alerts, [], "No in-game alerts");
  assert.deepEqual([...errors, ...fixture.errors], [], "Browser errors");
  console.log("ok", tag, failImport ? "(fallback)" : "(chain import)");
} catch (e) {
  console.error("FAIL", e.message, [...errors, ...(fixture?.errors ?? [])]); await shot("fail").catch(() => {}); process.exitCode = 1;
} finally {
  await browser.close(); server.closeAllConnections(); server.close(); await build.close(); await rm(temporary, { recursive: true, force: true });
}
