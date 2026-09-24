import { testGame } from "@rarefriends/friendsdk/testing";
const check = async ({ game, page }) => {
  const confirm = () => page.getByRole("button", { name: "Confirm preview", exact: true }).click();
  const click = (name) => game.getByRole("button", { name, exact: false }).first().click();
  await game.getByText("Hunger").first().waitFor();
  await click("Feed"); await click("Play");
  await game.getByRole("button", { name: /Pet your Friend/ }).click();
  await click("Treats");
  await game.getByRole("button", { name: /Buy 1/ }).click(); await confirm();
  await game.getByRole("button", { name: /Open a bag \(1\)/ }).click(); await confirm();
  await game.getByRole("heading", { name: /left a .* Charm/ }).waitFor({ timeout: 15000 });
  await page.waitForTimeout(700);
  await page.screenshot({ path: process.env.SHOT_REVEAL });
  await game.getByRole("button", { name: "Keep charm" }).click();
  await game.getByRole("button", { name: /Charms · 1/ }).waitFor();
  await click("Nap");
  await page.waitForTimeout(1500);
};
for (const [w, h, tag] of [[960, 640, "desktop"], [360, 480, "phone"]]) {
  process.env.SHOT_REVEAL = `artifacts/reveal-${tag}.png`;
  await testGame("./games/friend-nest", { width: w, height: h, screenshot: `artifacts/nest-${tag}.png`, check, timeout: 60000 });
  console.log("ok", tag);
}
