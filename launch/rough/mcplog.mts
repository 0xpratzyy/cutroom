// Reads launch/out/rough/mcp-log.jsonl (written by tap.mjs) into one turn per note: when Claude
// picked the note up, marked it working, each edit it made (and when the response came back), and
// when it resolved the note with what reply. Shared by capture-rough.mts (live marks) and states.mts (v4b).
import { readFileSync } from "node:fs";

export type LogEntry = { t: number; dir: "req" | "res"; msg: any };
export type Op = { op: string; [k: string]: unknown };
export type Edit = { sent: number; at?: number; ops: Op[]; label?: string; result?: string; error?: boolean };
export type Turn = { n: number; note?: string; seen?: number; working?: number; edits: Edit[]; resolved?: number; resolvedAck?: number; reply?: string };

export const readLog = (file: string): LogEntry[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));

const textOf = (result: any): string =>
  (result?.content ?? [])
    .filter((c: any) => c.type === "text")
    .map((c: any) => c.text)
    .join("\n");

/** Tool calls Claude made, in order, with their responses' text (images dropped). */
export function toolCalls(log: LogEntry[]) {
  const calls: { id: unknown; name: string; args: any; sent: number; at?: number; result?: string; error?: boolean }[] = [];
  const open = new Map<unknown, (typeof calls)[number]>();
  for (const { t, dir, msg } of log) {
    if (dir === "req" && msg?.method === "tools/call") {
      const c = { id: msg.id, name: msg.params?.name, args: msg.params?.arguments ?? {}, sent: t };
      calls.push(c);
      open.set(msg.id, c);
    } else if (dir === "res" && msg?.method === undefined && open.has(msg?.id)) {
      const c = open.get(msg.id)!;
      open.delete(msg.id);
      Object.assign(c, { at: t, result: textOf(msg.result) || msg.error?.message, error: !!(msg.result?.isError || msg.error) });
    }
  }
  return calls;
}

export function turns(log: LogEntry[]): Turn[] {
  const byN = new Map<number, Turn>();
  const turn = (n: number) => byN.get(n) ?? byN.set(n, { n, edits: [] }).get(n)!;
  // Feedback ids → note numbers, read from the listings wait_for_feedback / get_feedback return.
  const ids = new Map<string, number>();
  const noteOf = (id: unknown) => {
    const s = String(id ?? "").trim().replace(/^#/, "");
    return /^\d+$/.test(s) ? Number(s) : ids.get(s);
  };
  // The note being worked on: the last one marked working and not yet resolved, else the next one.
  const current = () => {
    const all = [...byN.values()];
    const busy = all.filter((x) => x.working !== undefined && x.resolved === undefined);
    return busy.length ? busy.at(-1)!.n : Math.max(0, ...all.filter((x) => x.resolved !== undefined).map((x) => x.n)) + 1;
  };
  for (const c of toolCalls(log)) {
    if (c.name === "update_feedback") {
      if (c.error) continue;
      const tr = turn(noteOf(c.args.id) ?? current());
      if (c.args.status === "working") tr.working ??= c.sent;
      if (c.args.status === "resolved") {
        tr.resolved ??= c.sent;
        if (c.at !== undefined) tr.resolvedAck ??= c.at;
        if (c.args.reply) tr.reply = c.args.reply;
      }
    } else if (c.name === "edit") {
      turn(current()).edits.push({ sent: c.sent, at: c.at, ops: c.args.ops ?? [], label: c.args.label, result: c.result, error: c.error });
    }
    if (c.result && /feedback/.test(c.name)) {
      for (const m of c.result.matchAll(/^### (\d+)\. .*?\[(\w+)\]\s+id: (\S+)/gm)) {
        ids.set(m[3], Number(m[1]));
        const tr = turn(Number(m[1]));
        if (m[2] === "open" && c.at !== undefined) tr.seen ??= c.at;
      }
      for (const m of c.result.matchAll(/^### (\d+)\.[^\n]*\n(?:- (?!Note)[^\n]*\n)*- Note[^:]*: ([^\n]*)/gm)) turn(Number(m[1])).note ??= m[2];
    }
  }
  return [...byN.values()].sort((a, b) => a.n - b.n);
}
