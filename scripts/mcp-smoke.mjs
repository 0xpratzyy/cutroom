#!/usr/bin/env node
// Minimal MCP client: starts `cutroom mcp` over stdio, lists its tools, and creates
// an empty project through the create_project tool.
//
//   node scripts/mcp-smoke.mjs [command [args...]]
//
// Defaults to the locally installed bin (node_modules/.bin/cutroom), so it can run
// from a directory where the cutroom tarball was installed. Exits non-zero on failure.
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const EXPECTED = ["create_project", "open_project", "import_media", "get_timeline", "get_transcript", "edit", "undo", "redo", "export", "open_editor", "get_feedback"];

const argv = process.argv.slice(2);
const command = argv[0] ?? process.execPath;
const args = argv.length ? argv.slice(1) : [join(process.cwd(), "node_modules", "cutroom", "dist", "cli.js"), "mcp"];
if (!argv.length && !existsSync(args[0])) {
  console.error(`mcp-smoke: ${args[0]} not found; run from a folder where cutroom is installed, or pass the server command`);
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), "cutroom-mcp-smoke-"));
const transport = new StdioClientTransport({ command, args, stderr: "inherit", env: { ...process.env, CUTROOM_HOME: join(work, "home") } });
const client = new Client({ name: "cutroom-smoke", version: "0.0.0" });
const timer = setTimeout(() => {
  console.error("mcp-smoke: timed out");
  process.exit(1);
}, 60_000);

try {
  await client.connect(transport);
  const info = client.getServerVersion();
  const { tools } = await client.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`MCP server ${info?.name} ${info?.version}: ${names.length} tools`);
  console.log(`  ${names.join(", ")}`);
  const missing = EXPECTED.filter((n) => !names.includes(n));
  if (missing.length) throw new Error(`missing tools: ${missing.join(", ")}`);

  const dir = join(work, "project");
  const res = await client.callTool({ name: "create_project", arguments: { path: dir, analyze: false } });
  if (res.isError) throw new Error(`create_project failed: ${JSON.stringify(res.content)}`);
  if (!existsSync(join(dir, "cutroom.json"))) throw new Error("create_project didn't write cutroom.json");
  const timeline = await client.callTool({ name: "get_timeline", arguments: {} });
  if (timeline.isError) throw new Error(`get_timeline failed: ${JSON.stringify(timeline.content)}`);
  console.log("  create_project + get_timeline OK");
  await client.close();
  clearTimeout(timer);
  console.log("mcp-smoke: OK");
} catch (err) {
  console.error(`mcp-smoke: FAILED: ${err instanceof Error ? err.message : err}`);
  process.exitCode = 1;
  await client.close().catch(() => {});
  clearTimeout(timer);
} finally {
  rmSync(work, { recursive: true, force: true });
}
