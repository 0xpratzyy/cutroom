#!/usr/bin/env node
// RIG TEST ONLY. A scripted MCP client standing in for Claude Code, so capture-rough.mts can be
// tested end to end without a logged-in `claude` (ROUGH_AGENT=stand-in). It follows the same prompt
// (open_project, wait_for_feedback, working → one edit → resolved) through tap.mjs, so mcp-log.jsonl
// has the same shape; its clientInfo says "rough-stand-in", so a log it wrote can never pass as
// Claude's. The film itself is recorded with real Claude Code.
// Usage: node launch/rough/stand-in-agent.mjs <tap.json> <project-dir>
import { readFileSync } from "node:fs";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const [config, project] = process.argv.slice(2);
const { command, args, env } = JSON.parse(readFileSync(config, "utf8")).mcpServers.cutroom;
const client = new Client({ name: "rough-stand-in", version: "0" });
await client.connect(new StdioClientTransport({ command, args, env: { ...process.env, ...env } }));
const call = async (name, a = {}) => {
  const r = await client.callTool({ name, arguments: a }, undefined, { timeout: 3_600_000 });
  return r.content.filter((c) => c.type === "text").map((c) => c.text).join("\n");
};
// Roughly Claude's pace, so the capture's waits have realistic lengths.
const think = (ms) => new Promise((r) => setTimeout(r, ms));

await call("open_project", { path: project });
for (let done = 0; done < 3; ) {
  const listing = await call("wait_for_feedback", { timeoutSec: 600 });
  for (const [, n, body] of listing.matchAll(/^### (\d+)\. .*?\[open\][^\n]*\n((?:- [^\n]*\n?)*)/gm)) {
    await think(2000);
    await call("update_feedback", { id: n, status: "working" });
    await think(3000);
    const words = body.match(/- Words: .*\((\S+) #(\d+)–(\d+)\)/);
    const box = body.match(/- Frame: box x (\d+)%–(\d+)%/);
    let ops, reply;
    if (words) [ops, reply] = [[{ op: "remove_words", mediaId: words[1], from: Number(words[2]), to: Number(words[3]) }], "Cut the false start."];
    else if (box) [ops, reply] = [[{ op: "set_settings", aspect: "9:16" }, { op: "set_focus", x: (Number(box[1]) + Number(box[2])) / 200, y: 0.5 }], "Reframed as a 9:16 Short."];
    else [ops, reply] = [[{ op: "set_look", lut: "warm", intensity: 0.8, contrast: 0.2 }, { op: "set_captions", enabled: true, preset: "pop" }], "Warmer, contrast, pop captions."];
    await call("edit", { ops, label: `note ${n}` });
    await think(1000);
    await call("update_feedback", { id: n, status: "resolved", reply });
    done++;
  }
}
// Like Claude's prompt: end in a live wait (capture-rough.mts kills it) unless ROUGH_END_WAITING=0.
if (process.env.ROUGH_END_WAITING !== "0") await call("wait_for_feedback", { timeoutSec: 3600 });
await client.close();
