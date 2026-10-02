// End-to-end over MCP: what an agent actually does. Needs ffmpeg + a transcription backend
// and test/fixtures/talking.mp4 (npm run fixtures). Run: npx tsx --test test/integration/*.test.ts
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { after, before, test } from "node:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const root = resolve(import.meta.dirname, "../..");
const fixture = join(root, "test/fixtures/talking.mp4");
const dir = mkdtempSync(join(tmpdir(), "cutroom-mcp-"));
let client: Client;

const call = async (name: string, args: Record<string, unknown> = {}) => {
  const r = (await client.callTool({ name, arguments: args }, undefined, { timeout: 300_000 })) as { content: { type: string; text?: string }[]; isError?: boolean };
  const text = r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
  return { text, isError: !!r.isError, images: r.content.filter((c) => c.type === "image").length };
};

before(async () => {
  if (!existsSync(fixture)) throw new Error("Run `npm run fixtures` first");
  client = new Client({ name: "test", version: "0" });
  await client.connect(new StdioClientTransport({ command: process.execPath, args: ["--import", "tsx", join(root, "src/cli.ts"), "mcp"], cwd: root, env: { ...process.env, CUTROOM_HOME: join(dir, "home") } as Record<string, string> }));
});

after(async () => {
  await client?.close();
  rmSync(dir, { recursive: true, force: true });
});

test("lists the agent tools", async () => {
  const names = (await client.listTools()).tools.map((t) => t.name);
  for (const n of ["create_project", "get_transcript", "edit", "preview", "get_feedback", "wait_for_feedback", "update_feedback", "find_retakes", "list_styles", "apply_brand", "export"]) assert.ok(names.includes(n), `missing ${n}`);
});

test("edits a talking-head video end to end", async () => {
  const created = await call("create_project", { path: join(dir, "proj"), media: [fixture] });
  assert.ok(!created.isError, created.text);
  assert.match(created.text, /transcript \d+ words/);

  const transcript = await call("get_transcript", {});
  assert.match(transcript.text, /\d+:\S+/);

  const edited = await call("edit", { ops: [{ op: "remove_fillers" }, { op: "remove_silences" }, { op: "set_settings", aspect: "9:16" }, { op: "set_captions", preset: "karaoke" }, { op: "add_zoom", start: 1, end: 2.5, ease: 0.4 }] });
  assert.ok(!edited.isError, edited.text);
  assert.match(edited.text, /Duration .* → /);

  const bad = await call("edit", { ops: [{ op: "set_settings", background: "red;nullsink" }] });
  assert.ok(bad.isError, "invalid input is rejected");

  const retakes = await call("find_retakes", {});
  assert.ok(!retakes.isError);

  const preview = await call("preview", { start: 0, end: 3, frames: 2 });
  assert.equal(preview.images, 1);

  const fb = await call("get_feedback", {});
  assert.match(fb.text, /No .*feedback/);

  const srt = await call("export", { format: "srt" });
  assert.match(srt.text, /Exported .*\.srt/);
});
