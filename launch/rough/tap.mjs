#!/usr/bin/env node
// Stdio MCP tap for Rough Cut: sits between Claude Code and `cutroom mcp`, passes every byte through
// unchanged, and appends each JSON-RPC message (both directions) to $ROUGH_MCP_LOG as one line of
// {t, dir, msg}: t in epoch seconds, dir "req" (client → server) or "res" (server → client), msg the
// message exactly as it went over the wire. The film's log lines and turn timings come from this file.
// Env: ROUGH_PROJECT (the server's cwd), ROUGH_MCP_LOG (the log file), CUTROOM_HOME (passed through).
import { spawn } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const LOG = process.env.ROUGH_MCP_LOG;
if (LOG) mkdirSync(dirname(LOG), { recursive: true });

const child = spawn(process.execPath, [join(ROOT, "dist/cli.js"), "mcp"], {
  cwd: process.env.ROUGH_PROJECT || process.cwd(),
  env: process.env,
  stdio: ["pipe", "pipe", "inherit"],
});

/** Line splitter for one direction. Chunks can end mid-message (or mid-character), so bytes wait until a newline. */
function tee(dir) {
  let rest = Buffer.alloc(0);
  const write = (line) => {
    const raw = line.toString("utf8").trim();
    if (!raw || !LOG) return;
    const t = Date.now() / 1000;
    try {
      JSON.parse(raw);
      // Spliced in as text rather than re-serialised, so the logged message is byte-for-byte what was sent.
      appendFileSync(LOG, `{"t":${t},"dir":"${dir}","msg":${raw}}\n`);
    } catch {
      appendFileSync(LOG, JSON.stringify({ t, dir, raw }) + "\n");
    }
  };
  return {
    data(chunk) {
      rest = rest.length ? Buffer.concat([rest, chunk]) : chunk;
      let nl;
      while ((nl = rest.indexOf(10)) >= 0) {
        write(rest.subarray(0, nl));
        rest = rest.subarray(nl + 1);
      }
    },
    flush() {
      if (rest.length) write(rest);
      rest = Buffer.alloc(0);
    },
  };
}

const up = tee("req");
const down = tee("res");
process.stdin.pipe(child.stdin);
process.stdin.on("data", (c) => up.data(c));
process.stdin.on("end", () => up.flush());
child.stdout.pipe(process.stdout);
child.stdout.on("data", (c) => down.data(c));
// The client going away mid-write must not take the tap down before the server has exited.
process.stdout.on("error", () => {});
child.stdin.on("error", () => {});

// "close", not "exit": the server's last stdout chunks are only all in once its pipes have closed.
child.on("close", (code, signal) => {
  up.flush();
  down.flush();
  process.exit(code ?? (signal ? 1 : 0));
});
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => child.kill(sig));
