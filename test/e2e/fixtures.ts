// Test fixture: a fresh copy of the transcribed template project, served by
// `cutroom open <dir> --no-browser --port <free port>`, with the page already loaded.
import { spawn, type ChildProcess } from "node:child_process";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test as base, expect, type Locator, type Page } from "@playwright/test";
import { CLI, FIXTURE, ROOT } from "./paths";

export interface Word {
  i: number;
  text: string;
  start: number;
  end: number;
  filler?: boolean;
}

export interface Editor {
  dir: string;
  url: string;
  /** GET a JSON API route, e.g. "/api/state". */
  api<T = any>(path: string): Promise<T>;
  state(): Promise<any>;
  /** Timeline duration (sum of clip lengths) from /api/state. */
  duration(): Promise<number>;
  words(): Promise<Word[]>;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const port = (srv.address() as { port: number }).port;
      srv.close(() => resolve(port));
    });
  });
}

function startEditor(dir: string, port: number, home: string): Promise<{ child: ChildProcess; url: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, "open", dir, "--no-browser", "--port", String(port)], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "pipe"],
      // Keep the brand kit (~/.cutroom) out of the developer's real home.
      env: { ...process.env, CUTROOM_HOME: home },
    });
    let out = "";
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`cutroom open didn't start within 20s:\n${out}`));
    }, 20_000);
    const onData = (d: Buffer) => {
      out += d.toString();
      const m = /cutroom editor: (http:\/\/\S+)/.exec(out);
      if (m) {
        clearTimeout(timer);
        resolve({ child, url: m[1] });
      }
    };
    child.stdout!.on("data", onData);
    child.stderr!.on("data", (d: Buffer) => (out += d.toString()));
    child.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`cutroom open exited (${code}):\n${out}`));
    });
  });
}

export const test = base.extend<{ editor: Editor }>({
  editor: async ({ page }, use) => {
    const template = process.env.CUTROOM_E2E_TEMPLATE;
    if (!template) throw new Error("CUTROOM_E2E_TEMPLATE isn't set; run through `npm run test:e2e` (global setup).");
    const base = mkdtempSync(join(tmpdir(), "cutroom-e2e-test-"));
    const dir = join(base, "project");
    cpSync(template, dir, { recursive: true });
    const { child, url } = await startEditor(dir, await freePort(), join(base, "home"));
    const api = async (path: string) => {
      const res = await fetch(url + path);
      if (!res.ok) throw new Error(`GET ${path}: ${res.status}`);
      return res.json();
    };
    const editor: Editor = {
      dir,
      url,
      api,
      state: () => api("/api/state"),
      duration: async () => ((await api("/api/state")).project.clips as { in: number; out: number }[]).reduce((n, c) => n + (c.out - c.in), 0),
      words: async () => (await api("/api/media/m1/transcript")).words,
    };
    await page.goto(url);
    await expect(page.getByRole("tab", { name: "Style" })).toBeVisible();
    await use(editor);
    child.kill();
    rmSync(base, { recursive: true, force: true });
  },
});

export { expect, FIXTURE };

/** The project duration shown in the title bar, e.g. "24.2s · 16:9" or "1:05 · 9:16". */
export function titleDuration(page: Page): Locator {
  return page.getByText(/^(\d+:\d\d|\d+\.\ds) · /);
}

export function parseDuration(text: string | null): number {
  const t = (text ?? "").split("·")[0].trim();
  const m = /^(\d+):(\d\d)$/.exec(t);
  return m ? Number(m[1]) * 60 + Number(m[2]) : parseFloat(t);
}

/** A transcript word shown in the editor, by its exact text. */
export function word(page: Page, text: string): Locator {
  return page.getByText(text, { exact: true }).first();
}

/** Two consecutive, non-filler words whose text appears only once, so text selectors are unambiguous. */
export function uniquePair(words: Word[]): [Word, Word] {
  const count = new Map<string, number>();
  for (const w of words) count.set(w.text, (count.get(w.text) ?? 0) + 1);
  const ok = (w: Word) => count.get(w.text) === 1 && !w.filler && w.text.length > 2;
  const mid = Math.floor(words.length / 2);
  const order = words.map((_, i) => i).sort((a, b) => Math.abs(a - mid) - Math.abs(b - mid));
  for (const i of order) if (words[i + 1] && ok(words[i]) && ok(words[i + 1])) return [words[i], words[i + 1]];
  throw new Error("transcript has no pair of unique consecutive words");
}
