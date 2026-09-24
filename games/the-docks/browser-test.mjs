import { testGame } from "@rarefriends/friendsdk/testing";
const tag = process.argv[2] ?? "desktop";
const [w, h] = tag === "phone" ? [360, 480] : [960, 640];
await testGame("./games/the-docks", { width: w, height: h, screenshot: `artifacts/docks-${tag}-end.png`, timeout: 90000,
  check: async ({ game, page }) => {
    const btn = (name) => game.getByRole("button", { name, exact: false }).first();
    const confirm = () => page.getByRole("button", { name: "Confirm preview", exact: true }).click();
    await game.locator("canvas.docks-canvas").waitFor();
    await page.waitForTimeout(1500);
    await page.screenshot({ path: `artifacts/docks-${tag}-start.png` });
    await btn("Docks").click();
    await game.getByRole("grid", { name: "Harbor berths" }).waitFor();
    await page.screenshot({ path: `artifacts/docks-${tag}-map.png` });
    await game.locator(".docks-map-row").nth(1).getByRole("button", { name: /Dock here/ }).click();
    await game.getByText(/Docked! 3 neighbours/).waitFor();
    // walk up (screen) toward the neighbour to the north and interact if possible
    await page.keyboard.down("d"); await page.waitForTimeout(1200); await page.keyboard.up("d");
    await page.waitForTimeout(600);
    await page.screenshot({ path: `artifacts/docks-${tag}-docked.png` });
    await btn("Market").click();
    await btn("500").click();
    await game.getByText(/\+500 credits/).waitFor();
    await game.getByRole("button", { name: /Sailor Cap|🪙 150/ }).first().click().catch(() => {});
    await page.keyboard.press("Escape");
    await btn("Bag").click();
    const wear = game.getByRole("button", { name: "Wear" });
    if (await wear.count()) await wear.first().click();
    await page.keyboard.press("Escape");
    await btn("Home").click();
    await btn("Pet").click();
    await btn("Buy 1").click(); await confirm();
    await btn("Open (1)").click(); await confirm();
    await game.getByRole("heading", { name: /found a .* Charm/ }).waitFor({ timeout: 20000 });
    await btn("Keep charm").click();
    await page.waitForTimeout(800);
    const errors = await game.locator("[role=alert]").allTextContents();
    if (errors.length) throw new Error("alerts: " + errors.join(" | "));
  } });
console.log("ok", tag);
