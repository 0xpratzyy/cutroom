import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { expect, parseDuration, test, titleDuration, uniquePair, word } from "./fixtures";

test("editor loads and shows the transcript", async ({ page, editor }) => {
  const words = await editor.words();
  expect(words.length).toBeGreaterThan(10);
  for (const w of words.filter((w) => w.text.length > 4).slice(0, 3)) await expect(word(page, w.text)).toBeVisible();
  const shown = parseDuration(await titleDuration(page).textContent());
  expect(shown).toBeCloseTo(await editor.duration(), 0);
});

test("Fillers removes filler words", async ({ page, editor }) => {
  const fillers = (await editor.words()).filter((w) => w.filler);
  test.skip(fillers.length === 0, "the fixture transcript has no filler words on this platform");
  const before = await editor.duration();
  const shownBefore = parseDuration(await titleDuration(page).textContent());

  const button = page.getByRole("button", { name: /^Fillers/ });
  await expect(button).toBeEnabled();
  await button.click();

  await expect.poll(() => editor.duration()).toBeLessThan(before - 0.1);
  await expect(button).toBeDisabled();
  await expect.poll(async () => parseDuration(await titleDuration(page).textContent())).toBeLessThan(shownBefore);
  // Cut words stay in the transcript, struck through.
  for (const f of fillers) await expect(word(page, f.text)).toHaveCSS("text-decoration-line", "line-through");
});

test("selecting words and pressing Backspace cuts them; undo restores", async ({ page, editor }) => {
  const [a, b] = uniquePair(await editor.words());
  const before = await editor.duration();
  const first = word(page, a.text);
  const last = word(page, b.text);
  await expect(last).toBeVisible();

  // Select the two words with a DOM range, as a mouse drag would, then release the mouse.
  await page.evaluate(
    ([s, e]) => {
      const range = document.createRange();
      range.setStart(s.firstChild!, 0);
      range.setEnd(e.firstChild!, e.firstChild!.textContent!.length);
      const sel = window.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
      e.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    },
    [await first.elementHandle(), await last.elementHandle()] as const,
  );
  await expect(page.getByRole("button", { name: /^Cut/ })).toBeVisible();
  await page.keyboard.press("Backspace");

  await expect.poll(() => editor.duration()).toBeLessThan(before - (b.end - a.start) * 0.5);
  await expect(first).toHaveCSS("text-decoration-line", "line-through");
  await expect(last).toHaveCSS("text-decoration-line", "line-through");

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => editor.duration()).toBeCloseTo(before, 2);
  await expect(first).not.toHaveCSS("text-decoration-line", "line-through");
  await expect(last).not.toHaveCSS("text-decoration-line", "line-through");
});

test("Style: picking a look and a caption template updates the project", async ({ page, editor }) => {
  await page.getByRole("tab", { name: "Style" }).click();

  await page.getByRole("button", { name: "Warm", exact: true }).click();
  await expect.poll(async () => (await editor.state()).project.look.lut).toBe("warm");

  await page.getByRole("button", { name: "Karaoke", exact: true }).click();
  await expect
    .poll(async () => {
      const c = (await editor.state()).project.captions;
      return { enabled: c.enabled, preset: c.preset };
    })
    .toEqual({ enabled: true, preset: "karaoke" });
});

test("a note written in the composer shows up in the Feedback tab", async ({ page, editor }) => {
  const note = `Tighten this intro ${Date.now()}`;
  await page.keyboard.press("c");
  const dialog = page.getByRole("dialog", { name: "New note" });
  await expect(dialog).toBeVisible();
  const box = dialog.getByRole("textbox");
  await box.fill(note);
  await box.press("ControlOrMeta+Enter");
  await expect(dialog).toBeHidden();

  await page.getByRole("tab", { name: /^Feedback/ }).click();
  await expect(page.getByText(note)).toBeVisible();
  const items: { note: string; status: string }[] = await editor.api("/api/feedback");
  expect(items.find((f) => f.note === note)?.status).toBe("open");
});

test("Export renders an mp4 into exports/", async ({ page, editor }) => {
  test.setTimeout(120_000);
  await page.getByRole("tab", { name: "Export" }).click();
  await page.getByRole("button", { name: "Draft", exact: true }).click();
  await page.getByRole("button", { name: /Export video/ }).click();
  await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible({ timeout: 90_000 });

  const files = readdirSync(join(editor.dir, "exports")).filter((f) => f.endsWith(".mp4"));
  expect(files).toHaveLength(1);
  const duration = Number(
    execFileSync(process.env.CUTROOM_FFPROBE ?? "ffprobe", ["-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", join(editor.dir, "exports", files[0])], { encoding: "utf8" }).trim(),
  );
  expect(duration).toBeGreaterThan(0);
  expect(duration).toBeCloseTo(await editor.duration(), 0);
});
