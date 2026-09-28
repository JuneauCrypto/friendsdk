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
import { decodeFunctionData, encodeAbiParameters, encodeEventTopics, encodeFunctionResult, padHex, parseAbi, zeroAddress } from "viem";
import { buildGame, createGameServer } from "../../scripts/dev-game.mjs";
import { installFixture, createArtworkFixture } from "../../scripts/browser-fixture.mjs";

const tag = process.argv[2] ?? "desktop";
const failImport = process.argv.includes("--fail-import");
// --many=N: the tester's wallet also holds N synthetic activated Friends (mixed generations) to test scale.
const many = Number(process.argv.find(a => a.startsWith("--many="))?.split("=")[1] ?? 0);
const [width, height] = tag === "phone" ? [360, 480] : [960, 640];
const dir = resolve("games/the-docks");
const out = resolve("artifacts"); await mkdir(out, { recursive: true });
const shot = name => page.screenshot({ path: join(out, `docks-${tag}${failImport ? "-fallback" : ""}${many ? `-many${many}` : ""}-${name}.png`) });
const tokens = JSON.parse(await readFile(join(dir, "fixtures/tokens.json"), "utf8"));
const ABI = parseAbi([
  "function tokenURI(uint256) view returns (string)", "function ownerOf(uint256) view returns (address)",
  "function generation(uint256) view returns (uint8)", "function activationManager() view returns (address)",
  "function positions(address, uint256) view returns (uint8, uint256)",
  "function aggregate3((address target, bool allowFailure, bytes callData)[] calls) payable returns ((bool success, bytes returnData)[])",
  "event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)",
]);
const MANAGER = "0x00000000000000000000000000000000000a11ce";
const traitsOf = uri => Object.fromEntries(JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString()).attributes.map(a => [a.trait_type, a.value]));
// synthetic Friends reuse a recorded Friend's art of the same generation
const BY_GEN = { 3: "7730", 4: "7843", 5: "7333", 6: "7834" };
const synthetic = new Map(Array.from({ length: many }, (_, i) => [String(900000 + i), BY_GEN[[3, 4, 5, 6, 6, 6, 5, 6][i % 8]]]));
const held = ["7730", "7573", ...synthetic.keys()];
const uriOf = id => tokens[id]?.uri ?? (synthetic.has(id) ? tokens[synthetic.get(id)].uri : undefined);
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
  // One sub-call (also used inside Multicall3 aggregate3). Returns hex result, or null to defer to the SDK fixture.
  const subcall = (to, data) => {
    let call; try { call = decodeFunctionData({ abi: ABI, data }); } catch { return null; }
    const enc = (functionName, result) => encodeFunctionResult({ abi: ABI, functionName, result });
    const id = call.args?.[0] !== undefined && typeof call.args[0] !== "string" ? String(call.args[0]) : String(call.args?.[1] ?? "");
    switch (call.functionName) {
      case "activationManager": return enc("activationManager", MANAGER);
      case "generation": return enc("generation", Number(traitsOf(uriOf(id)).Generation));
      case "positions": { const u = uriOf(id); return enc("positions", u ? [Number(traitsOf(u)["Activation tier"] ?? 0), 10n ** 18n] : [0, 0n]); }
      case "ownerOf": return enc("ownerOf", held.includes(id) ? FIXTURE_OWNER : tokens[id]?.owner ?? "0x000000000000000000000000000000000000dEaD");
      case "tokenURI": {
        if (failImport && id === "7730") throw Object.assign(new Error("fixture: tokenURI unavailable"), { code: -32000 });
        let uri = uriOf(id);
        if (!uri) throw Object.assign(new Error("execution reverted"), { code: 3 });
        if (upgraded && id === "7573" && ++calls > 1) {
          const j = JSON.parse(Buffer.from(uri.split(",")[1], "base64").toString());
          j.attributes = j.attributes.map(a => a.trait_type === "Activation tier" ? { ...a, value: 2 } : a);
          uri = "data:application/json;base64," + Buffer.from(JSON.stringify(j)).toString("base64");
        }
        return enc("tokenURI", uri);
      }
      case "aggregate3": return enc("aggregate3", call.args[0].map(c => { try { const r = subcall(c.target, c.callData); return { success: r !== null, returnData: r ?? "0x" }; } catch { return { success: false, returnData: "0x" }; } }));
    }
    return null;
  };
  const answer = body => {
    const ok = result => ({ jsonrpc: "2.0", id: body.id, result });
    if (body.method === "eth_blockNumber") return ok("0x100");
    if (body.method === "eth_getLogs") {
      const f = body.params[0], owner = padHex(FIXTURE_OWNER, { size: 32 }).toLowerCase();
      if (f.topics?.[1]) return ok([]);                                   // nothing ever sent away
      if (f.topics?.[2]?.toLowerCase() !== owner) return ok([]);
      return ok(held.map((id, i) => ({ address: f.address, blockNumber: "0x10", blockHash: padHex("0x10", { size: 32 }), data: "0x",
        logIndex: `0x${i.toString(16)}`, transactionHash: padHex("0x1234", { size: 32 }), transactionIndex: "0x0", removed: false,
        topics: encodeEventTopics({ abi: ABI, eventName: "Transfer", args: { from: zeroAddress, to: FIXTURE_OWNER, tokenId: BigInt(id) } }) })));
    }
    if (body.method === "eth_call") {
      try { const r = subcall(body.params[0].to, body.params[0].data); return r === null ? null : ok(r); }
      catch (e) { return { jsonrpc: "2.0", id: body.id, error: { code: e.code ?? -32000, message: e.message } }; }
    }
    return null;
  };
  // Registered after the SDK fixture, so it is consulted first. Only the game frame's reads are
  // answered here; the trusted runtime's wallet/eligibility reads stay on the SDK fixture.
  await page.route("https://rpc.mainnet.chain.robinhood.com/**", async route => {
    const frame = route.request().frame();
    if (!frame?.parentFrame()) return route.fallback();
    const body = route.request().postDataJSON?.();
    if (!body) return route.fallback();
    const replies = (Array.isArray(body) ? body : [body]).map(answer);
    if (process.env.DOCKS_DEBUG) console.log("rpc", JSON.stringify(body).slice(0, 300), "=>", JSON.stringify(replies).slice(0, 200));
    if (replies.some(r => r === null)) return route.fallback();
    return route.fulfill({ json: Array.isArray(body) ? replies : replies[0], headers: { "access-control-allow-origin": "*" } });
  });
  const game = page.frameLocator("iframe");
  await page.goto(origin);
  await page.getByRole("button", { name: /^Connect (wallet|Browser wallet)$/ }).click();
  await page.getByRole("button", { name: /^Friend #7730\b/ }).click();
  if (failImport) { await game.getByText(/Couldn't read your Friend from chain/).waitFor(); await shot("fail-state"); console.log("ok", tag, "(import failure shows retry)"); process.exit(0); }
  await game.locator("img.docks-land").first().waitFor();
  await game.getByText(many ? /All [\d,]+ of your activated Friends joined into one floating island/ : /All 2 of your activated Friends joined into one floating island/).waitFor();
  await page.waitForTimeout(1200);
  await shot("start");
  const btn = name => game.getByRole("button", { name, exact: false }).first();
  // dock
  await btn("Docks").click();
  await game.getByRole("img", { name: /Map: \d+ docked islands, \d+ loading zones/ }).waitFor();
  await shot("map");
  await game.locator(".docks-slots button").first().click();
  await game.getByText(/Your island docked next to .* \(gas only, simulated\)/).waitFor();
  await page.waitForTimeout(600);
  await shot("docked");
  // my other Friends arrived automatically; adding by number is only a fallback
  await btn("Islands").click();
  await game.getByText(many ? `${(many + 2).toLocaleString("en-US")} Friends ·` : "2 Friends ·", { exact: false }).first().waitFor();
  await game.getByLabel("Missing one? Add by number").fill("7843");
  await game.getByRole("button", { name: "Add", exact: true }).click();
  await game.getByText(/already in the docks/).waitFor();
  await game.getByLabel("Missing one? Add by number").fill("7060");
  await game.getByRole("button", { name: "Add", exact: true }).click();
  await game.getByText(/isn't held by the same wallet/).waitFor();
  await shot("my-plot");
  // arrange: move my Friend away so it no longer touches, Done refuses, Auto-arrange fixes it
  await game.locator(".rf-frame-menu").getByRole("button", { name: "✥ Arrange" }).click();
  await game.getByRole("toolbar", { name: "Arrange your Friends" }).waitFor();
  if (many) {                                     // packed plot: stepping onto a same-size neighbour swaps them
    await game.getByRole("button", { name: "Move down-right" }).click();
    await game.getByText(/Moving #7730/).waitFor();
  } else {
    await game.getByRole("button", { name: "All", exact: true }).click();
    await game.getByText("Moving all 2").waitFor();
    await game.getByRole("button", { name: "Move up-left" }).click();          // the whole island shape moves: nothing to pay
    await game.getByRole("button", { name: "Pick several" }).click();           // back to one at a time
    for (let i = 0; i < 3 && !(await game.getByText("Moving #7730").count()); i++) await game.getByRole("button", { name: "Next Friend" }).click();
    await game.getByText("Moving #7730").waitFor();
    for (let i = 0; i < 12; i++) await game.getByRole("button", { name: "Move up-left" }).click();
    await shot("arrange");
    await btn("Done").click();
    await game.getByText(/touch the rest/).waitFor();
  }
  await game.getByRole("button", { name: "Auto-arrange" }).click();
  await btn("Done").click();
  await game.getByRole("toolbar", { name: "Arrange your Friends" }).waitFor({ state: "detached" });
  // save on chain (simulated): mints the plot NFT and burns RF per Friend moved (2 × Gen 3 = 40 RF)
  if (many) {
    await game.getByRole("button", { name: /Save · 10,002 moved · 55k RF/ }).click();
    await game.getByText(/Saving burns 55k RF; you have 5,000/).waitFor();
  } else {
    await game.getByRole("button", { name: /Save · 2 moved · 40 RF/ }).click();
    await game.getByText(/Saved on chain \(simulated\): created Island #\d+ on chain · 2 Friends moved · 40 RF burned/).waitFor();
    await shot("saved");
    // one more move is a new draft: only that Friend is charged; Undo returns to the save
    await game.locator(".docks-arrange-btn").click();
    for (const dir of ["Move down-right", "Move up-left", "Move up-right", "Move down-left"]) {
      await game.getByRole("button", { name: dir }).click();
      if (await game.getByText(/1 moved · burns 20 RF \+ gas/).count()) break;
    }
    await game.getByText(/1 moved · burns 20 RF \+ gas/).waitFor();
    await btn("Done").click();
    await game.getByText(/touch the rest|Arranged/).first().waitFor().catch(() => {});
    if (await game.getByRole("toolbar", { name: "Arrange your Friends" }).count()) await game.getByRole("button", { name: "Auto-arrange" }).click(), await btn("Done").click();
    if (await game.getByRole("button", { name: "Undo" }).count()) { await game.getByRole("button", { name: "Undo" }).click(); await game.getByText("Back to your saved islands.").waitFor(); }
  }
  // walk toward neighbours for a bit
  for (const k of ["d", "w", "a", "s"]) { await page.keyboard.down(k); await page.waitForTimeout(900); await page.keyboard.up(k); }
  await shot("walk");
  // manual on-chain check
  await btn("Check").click();
  await game.getByText(/On-chain check:.*#7573 updated \(G3 T1 → G3 T2\)/).waitFor();
  // crew: everyone starts on their own land; the lead calls them all over
  assert.equal(await game.locator("canvas.docks-avatar.crew").count(), 0, "nobody follows yet");
  if (many) assert.ok(await game.locator("img.docks-land").count() < 400, "only lands near the camera are drawn");
  await btn("Crew").click();
  await game.getByRole("button", { name: "📣 Call all" }).click();
  await game.getByText(new RegExp(`#7730 called all ${(1 + many).toLocaleString("en-US")} Friends over`)).waitFor();
  assert.equal(await game.locator("canvas.docks-avatar.crew").count(), Math.min(40, 1 + many), "crew drawn walking");
  await page.waitForTimeout(1500);
  // pick #7573 on the map and leave it here, walk on, then take it over as the lead
  const box = await game.locator("canvas.docks-avatar.crew").first().boundingBox();
  await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await game.getByText(/tap Friends to pick \(1\)/).waitFor();
  await game.getByRole("button", { name: "Leave picked here" }).click();
  await game.getByText(/1 Friend left here\./).waitFor();
  await btn("Done").click();
  for (const k of ["d", "s"]) { await page.keyboard.down(k); await page.waitForTimeout(700); await page.keyboard.up(k); }
  await shot("crew");
  await btn("Islands").click();
  await game.locator(".docks-friend", { hasText: many ? "#900000" : "#7573" }).getByRole("button", { name: "Lead" }).click();
  await game.getByText(new RegExp(`You're leading #${many ? 900000 : 7573} now`)).waitFor();
  await game.locator(".docks-hud").getByText(new RegExp(`#${many ? 900000 : 7573}`)).first().waitFor();
  await btn("Crew").click();
  await game.getByText(new RegExp(`Leading #${many ? 900000 : 7573}`)).waitFor();
  await game.getByRole("button", { name: "All go home" }).click();
  await game.getByText("Everyone went back to their own land.").waitFor();
  await btn("Done").click();
  // tokens: claim the sample $MKT, then launch our own
  await btn("Tokens").click();
  await game.getByRole("button", { name: /^Claim for \d[\d,]* Friends?/ }).first().click();
  await game.getByText(/claimed 500 \$MKT each \(simulated\)/).waitFor();
  await game.getByLabel("Name").fill("Dock Coin");
  await game.getByLabel("Ticker").fill("DOCK");
  if (many) {                                    // the 10k plot couldn't afford its first save, so it can't launch
    await game.getByRole("button", { name: /Launch for 1,000 RF/ }).click();
    await game.getByText(/Save your island on chain first/).waitFor();
  } else {
    await game.getByRole("button", { name: /Launch for 1,000 RF/ }).click();
    await game.getByText(/\$DOCK launched \(simulated\)/).waitFor();
  }
  await shot("tokens");
  const rfText = await game.locator(".docks-rf").textContent();
  if (!many) { assert.match(rfText, /Your RF\s*3,950/, "5,000 − 40 save − 2×5 claims − 1,000 launch"); assert.match(rfText, /Burned\s*550/); }
  await game.getByRole("button", { name: "Close Tokens" }).click();
  if (!many) {
    // a bridge to an island we aren't docked next to burns RF per berth of distance
    await btn("Docks").click();
    const bridge = game.getByRole("button", { name: /^Bridge to / }).first();
    const cost = Number((await bridge.locator("small").textContent()).replace(/\D/g, ""));
    assert.ok(cost >= 20 && cost % 10 === 0, `bridge cost ${cost}`);
    await bridge.click();
    await game.getByText(new RegExp(`Bridge built from Your island to .* \\(simulated\\): ${cost} RF burned`)).waitFor();
    await shot("bridge");
    for (let i = 0; i < 5; i++) await game.getByRole("button", { name: "Zoom out" }).click();
    await page.waitForTimeout(1500); await shot("world");
    for (let i = 0; i < 5; i++) await game.getByRole("button", { name: "Zoom in" }).click();
    await game.getByRole("button", { name: "Fit all islands" }).click();
    await page.waitForTimeout(1200); await shot("fit-all");
    const vp = await game.locator(".docks-viewport, [class*=viewport]").first().boundingBox();
    if (vp) { await page.mouse.move(vp.x + vp.width / 2, vp.y + vp.height / 2); await page.mouse.wheel(0, -600); await page.waitForTimeout(400); }
    await game.getByRole("button", { name: "Center on lead" }).click();
    // deploy #7573 to a second island: joining a new island counts as a move (Gen 3: 20 RF)
    await btn("Islands").click();
    await game.getByRole("button", { name: "＋ New island" }).click();
    await game.getByRole("tab", { name: /Your island/ }).click();
    await game.getByLabel("Deploy #7573 to").selectOption({ label: "→ Island 2" });
    await game.getByText(/#7573 deployed to Island 2/).waitFor();
    await game.getByRole("button", { name: "Close My islands" }).click();
    await game.getByRole("button", { name: /Save · 1 moved · 20 RF/ }).click();
    await game.getByText(/created Island #\d+ on chain · 1 Friend moved · 20 RF burned/).waitFor();
    await shot("two-islands");
    // #7573 (saved on Island 2) leaves the wallet: its spot becomes a hole; it comes back and heals it
    await btn("More").click();
    await game.getByLabel("Friend to send away").selectOption("7573");
    await game.getByRole("button", { name: "Send away" }).click();
    await game.getByText(/#7573 left your wallet: a hole opened on Island 2/).waitFor();
    await btn("Islands").click();
    await game.getByRole("tab", { name: /Island 2/ }).click();
    await game.getByText("Hole where #7573 was · Gen 3").waitFor();
    await shot("hole");
    await game.getByRole("button", { name: "Close My islands" }).click();
    await btn("More").click();
    await game.getByRole("button", { name: "Bring #7573 back" }).click();
    await game.getByText(/#7573 came back and healed its hole on Island 2/).waitFor();
  }
  const alerts = await game.locator("[role=alert]").allTextContents();
  assert.deepEqual(alerts, [], "No in-game alerts");
  // The SDK fixture only has sprite art for #7730; the crew's sprite reads for others are refused
  // there (the game falls back to a plain silhouette). Any other fixture error still fails.
  const fixtureErrors = fixture.errors.filter(e => !/\d+n !== 7730n/.test(String(e)));
  assert.deepEqual([...errors, ...fixtureErrors], [], "Browser errors");
  console.log("ok", tag, failImport ? "(fallback)" : many ? `(${many + 2} Friends)` : "(chain import)");
} catch (e) {
  console.error("FAIL", e.message, [...errors, ...(fixture?.errors ?? [])]); await shot("fail").catch(() => {}); process.exitCode = 1;
} finally {
  await browser.close(); server.closeAllConnections(); server.close(); await build.close(); await rm(temporary, { recursive: true, force: true });
}
