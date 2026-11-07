import type { Page } from "@playwright/test";
import { expect, test } from "./fixtures";

async function loadDemo(page: Page, query = ""): Promise<void> {
  await page.goto(`/${query}`);
  const input = page.locator('textarea[placeholder="Experiments to load"]');
  await input.fill("demo");
  await input.press("Enter");
  await page.waitForSelector("svg g.dimension", { state: "attached", timeout: 15000 });
}

const themeClass = (page: Page) =>
  page.locator("#hiplot_element_id > div").first().getAttribute("class");

const toggle = (page: Page, name: string) =>
  page.getByRole("group", { name: "Theme" }).getByRole("button", { name, exact: true });

test("the theme toggle switches themes and the choice survives a reload", async ({ page }) => {
  await page.emulateMedia({ colorScheme: "light" });
  await loadDemo(page);
  await expect(toggle(page, "System")).toHaveAttribute("aria-pressed", "true");
  await toggle(page, "Dark").click();
  await expect.poll(() => themeClass(page)).toBe("hip_thm--dark");
  await page.reload();
  await expect.poll(() => themeClass(page)).toBe("hip_thm--dark");
  await expect(toggle(page, "Dark")).toHaveAttribute("aria-pressed", "true");
  await toggle(page, "System").click();
  await expect.poll(() => themeClass(page)).toBe("hip_thm--light");
  await page.emulateMedia({ colorScheme: "dark" });
  await expect.poll(() => themeClass(page)).toBe("hip_thm--dark");
  await toggle(page, "Light").click();
  await expect.poll(() => themeClass(page)).toBe("hip_thm--light");
});

test("a theme in the URL wins over the stored one and follows the toggle", async ({ page }) => {
  await loadDemo(page);
  await toggle(page, "Dark").click();
  await loadDemo(page, "?hip.theme=light");
  await expect.poll(() => themeClass(page)).toBe("hip_thm--light");
  await toggle(page, "Dark").click();
  expect(new URL(page.url()).searchParams.get("hip.theme")).toBe("dark");
  await page.reload();
  await expect.poll(() => themeClass(page)).toBe("hip_thm--dark");
});

test("the dark theme fills the page down to the bottom of the viewport", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 2600 });
  await loadDemo(page, "?hip.theme=dark");
  const bottom = await page.evaluate(() => {
    const element = document.elementFromPoint(20, window.innerHeight - 4);
    if (element === null) {
      throw new Error("Nothing at the bottom of the viewport");
    }
    let node: Element | null = element;
    while (node !== null && getComputedStyle(node).backgroundColor === "rgba(0, 0, 0, 0)") {
      node = node.parentElement;
    }
    return node === null ? "transparent" : getComputedStyle(node).backgroundColor;
  });
  expect(bottom).toBe("rgb(21, 24, 28)");
});
