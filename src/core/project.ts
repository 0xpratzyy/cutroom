// ProjectStore: the single source of truth on disk.
//
//   my-video/
//     cutroom.json          the project (human-readable, git-friendly)
//     .cutroom/             caches, history, selection, previews
//
// The editor server and the MCP server may run in separate processes; both go
// through this store, which uses a lock file and atomic writes, and watches the
// directory so each process sees the other's edits.
import { EventEmitter } from "node:events";
import { existsSync, watch, type FSWatcher } from "node:fs";
import { mkdir, open, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { applyOps, type EditResult, type Op, type EditContext } from "./shared/ops.js";
import { timelineToSource, uid } from "./shared/timeline.js";
import {
  DEFAULT_CAPTIONS,
  DEFAULT_AUDIO,
  DEFAULT_HOOK,
  DEFAULT_LOOK,
  DEFAULT_SETTINGS,
  DEFAULT_WATERMARK,
  PROJECT_FILE,
  PROJECT_VERSION,
  type AgentPresence,
  type Feedback,
  type FeedbackDraft,
  type FeedbackStatus,
  type HistoryEntry,
  type MediaAsset,
  type Project,
  type Selection,
  type Silence,
  type Transcript,
  type Waveform,
} from "./shared/types.js";

export type Origin = HistoryEntry["origin"];

interface StoredEntry extends HistoryEntry {
  /** Snapshot file in .cutroom/history/ (current format). */
  snap?: string;
  /** Inline snapshot (older projects; still read). */
  project?: Project;
}

interface HistoryFile {
  nextId: number;
  undo: StoredEntry[];
  redo: StoredEntry[];
}

const HISTORY_LIMIT = 200;

export interface StoreEvents {
  project: [Project, { label: string; origin: Origin | "external" }];
  selection: [Selection];
  feedback: [Feedback[]];
  agent: [AgentPresence | null];
}

export class ProjectStore extends EventEmitter<StoreEvents> {
  readonly dir: string;
  private queue: Promise<unknown> = Promise.resolve();
  private watcher?: FSWatcher;
  private dataWatcher?: FSWatcher;
  private lastFeedback = "";
  private lastWritten = "";
  private lastSeenAt = new Date().toISOString();
  private cache = new Map<string, { mtime: number; value: unknown }>();

  constructor(dir: string) {
    super();
    this.dir = resolve(dir);
  }

  get file() {
    return join(this.dir, PROJECT_FILE);
  }
  get dataDir() {
    return join(this.dir, ".cutroom");
  }
  cacheDir(mediaId: string) {
    return join(this.dataDir, "cache", mediaId);
  }
  get previewDir() {
    return join(this.dataDir, "previews");
  }
  get exportDir() {
    return join(this.dir, "exports");
  }

  /** Accepts a project directory or a path to cutroom.json. */
  static async open(path: string): Promise<ProjectStore> {
    const p = resolve(path);
    const dir = basename(p) === PROJECT_FILE ? dirname(p) : p;
    const store = new ProjectStore(dir);
    if (!existsSync(store.file)) throw new Error(`No ${PROJECT_FILE} in ${dir}. Create one with \`cutroom init\` or the create_project tool.`);
    await store.load();
    return store;
  }

  static async create(dir: string, name?: string): Promise<ProjectStore> {
    const store = new ProjectStore(dir);
    if (existsSync(store.file)) return ProjectStore.open(dir);
    await mkdir(store.dir, { recursive: true });
    const now = new Date().toISOString();
    const project: Project = {
      version: PROJECT_VERSION,
      name: name ?? basename(store.dir),
      createdAt: now,
      updatedAt: now,
      settings: { ...DEFAULT_SETTINGS },
      media: [],
      clips: [],
      overlays: [],
      zooms: [],
      captions: { ...DEFAULT_CAPTIONS },
      look: { ...DEFAULT_LOOK },
      hook: { ...DEFAULT_HOOK },
      watermark: { ...DEFAULT_WATERMARK },
      audio: { ...DEFAULT_AUDIO },
    };
    await store.writeProject(project);
    await writeFile(join(store.dir, ".gitignore"), ".cutroom/\nexports/\n").catch(() => {});
    return store;
  }

  async load(): Promise<Project> {
    const raw = await readFile(this.file, "utf8");
    const project = JSON.parse(raw) as Project;
    if (project.version > PROJECT_VERSION) throw new Error(`Project version ${project.version} is newer than this cutroom supports`);
    // Fill fields added in later versions.
    project.settings = { ...DEFAULT_SETTINGS, ...project.settings };
    project.captions = { ...DEFAULT_CAPTIONS, ...project.captions };
    project.look = { ...DEFAULT_LOOK, ...project.look };
    project.hook = { ...DEFAULT_HOOK, ...project.hook };
    project.watermark = { ...DEFAULT_WATERMARK, ...project.watermark };
    project.audio = { ...DEFAULT_AUDIO, ...project.audio };
    project.overlays ??= [];
    project.zooms ??= [];
    return project;
  }

  resolveMediaPath(m: MediaAsset): string {
    return isAbsolute(m.path) ? m.path : join(this.dir, m.path);
  }

  // -------------------------------------------------------------------------
  // Mutations

  /** Apply edit ops atomically, recording an undo step. */
  edit(ops: Op[], origin: Origin, label?: string): Promise<EditResult> {
    return this.mutate(async (project) => {
      const result = applyOps(project, ops, await this.context());
      return { project: result.project, label: label ?? describeOps(ops), result };
    }, origin);
  }

  /** Arbitrary project change (used for media import etc). */
  update(fn: (p: Project) => void | Promise<void>, origin: Origin, label: string, opts: { record?: boolean } = {}): Promise<Project> {
    return this.mutate(
      async (project) => {
        const next = structuredClone(project);
        await fn(next);
        return { project: next, label, result: next };
      },
      origin,
      opts.record ?? true,
    );
  }

  undo(): Promise<HistoryEntry | null> {
    return this.step("undo");
  }

  redo(): Promise<HistoryEntry | null> {
    return this.step("redo");
  }

  private step(dir: "undo" | "redo"): Promise<HistoryEntry | null> {
    return this.locked(async () => {
      const h = await this.readHistory();
      const entry = h[dir].pop();
      if (!entry) return null;
      const target = await this.entryProject(entry);
      const current = await this.load();
      h[dir === "undo" ? "redo" : "undo"].push(await this.snapshot(strip(entry), current));
      await this.writeHistory(h, [entry]);
      await this.writeProject(target, false);
      this.emit("project", await this.load(), { label: `${dir}: ${entry.label}`, origin: entry.origin });
      return strip(entry);
    });
  }

  async history(): Promise<{ undo: HistoryEntry[]; redo: HistoryEntry[] }> {
    const h = await this.readHistory();
    return { undo: h.undo.map(strip), redo: h.redo.map(strip) };
  }

  private mutate<T>(fn: (p: Project) => Promise<{ project: Project; label: string; result: T }>, origin: Origin, record = true): Promise<T> {
    return this.locked(async () => {
      const before = await this.load();
      const { project, label, result } = await fn(before);
      // The first agent edit after a review snapshots the "before" version, so the user can
      // review everything the agent changed since then (accept / reject / revert pieces).
      if (origin === "agent" && record && !existsSync(join(this.dataDir, "review.json"))) {
        await mkdir(this.dataDir, { recursive: true });
        await atomicWrite(join(this.dataDir, "review.json"), JSON.stringify({ since: new Date().toISOString(), baseline: before }));
      }
      if (record) {
        const h = await this.readHistory();
        h.undo.push(await this.snapshot({ id: h.nextId++, label, origin, at: new Date().toISOString() }, before));
        const dropped = h.undo.length > HISTORY_LIMIT ? h.undo.splice(0, h.undo.length - HISTORY_LIMIT) : [];
        dropped.push(...h.redo);
        h.redo = [];
        await this.writeHistory(h, dropped);
      }
      await this.writeProject(project);
      this.emit("project", project, { label, origin });
      return result;
    });
  }

  private async writeProject(project: Project, touch = true): Promise<void> {
    if (touch) project.updatedAt = new Date().toISOString();
    const json = JSON.stringify(project, null, 2) + "\n";
    this.lastWritten = json;
    await atomicWrite(this.file, json);
  }

  // -------------------------------------------------------------------------
  // Analysis artifacts (per media, in .cutroom/cache/<id>/)

  async context(): Promise<EditContext> {
    const project = await this.load();
    const transcripts: EditContext["transcripts"] = {};
    const silences: EditContext["silences"] = {};
    for (const m of project.media) {
      transcripts[m.id] = await this.getTranscript(m.id);
      silences[m.id] = await this.getSilences(m.id);
    }
    return { transcripts, silences };
  }

  getTranscript(mediaId: string) {
    return this.readCached<Transcript>(join(this.cacheDir(mediaId), "transcript.json"));
  }
  getSilences(mediaId: string) {
    return this.readCached<Silence[]>(join(this.cacheDir(mediaId), "silences.json"));
  }
  getWaveform(mediaId: string) {
    return this.readCached<Waveform>(join(this.cacheDir(mediaId), "waveform.json"));
  }

  async writeArtifact(mediaId: string, name: string, value: unknown): Promise<void> {
    const dir = this.cacheDir(mediaId);
    await mkdir(dir, { recursive: true });
    await atomicWrite(join(dir, name), JSON.stringify(value));
  }

  private async readCached<T>(path: string): Promise<T | undefined> {
    try {
      const { mtimeMs } = await stat(path);
      const hit = this.cache.get(path);
      if (hit && hit.mtime === mtimeMs) return hit.value as T;
      const value = JSON.parse(await readFile(path, "utf8")) as T;
      this.cache.set(path, { mtime: mtimeMs, value });
      return value;
    } catch {
      return undefined;
    }
  }

  // -------------------------------------------------------------------------
  // Selection: what the user is pointing at in the editor.

  async getSelection(): Promise<Selection> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, "selection.json"), "utf8"));
    } catch {
      return { playhead: 0, range: null, items: [], words: null, updatedAt: new Date(0).toISOString() };
    }
  }

  async setSelection(sel: Omit<Selection, "updatedAt">): Promise<Selection> {
    const full = { ...sel, updatedAt: new Date().toISOString() };
    await mkdir(this.dataDir, { recursive: true });
    await atomicWrite(join(this.dataDir, "selection.json"), JSON.stringify(full));
    this.emit("selection", full);
    return full;
  }

  // -------------------------------------------------------------------------
  // Watch for edits made by other processes (e.g. the MCP server while the editor is open).

  watch(): void {
    if (this.watcher) return;
    void mkdir(this.dataDir, { recursive: true }).then(() => {
      // One debounce timer per file: a heartbeat write must not swallow a feedback change.
      const timers: Record<string, NodeJS.Timeout | undefined> = {};
      this.dataWatcher = watch(this.dataDir, (_e, file) => {
        if (file !== "feedback.json" && file !== "agent.json") return;
        clearTimeout(timers[file]);
        timers[file] = setTimeout(async () => {
          if (file === "feedback.json") await this.checkFeedback();
          else this.emit("agent", await this.getAgent());
        }, 60);
      });
    });
    let timer: NodeJS.Timeout | undefined;
    this.watcher = watch(this.dir, (_event, file) => {
      if (file !== PROJECT_FILE) return;
      clearTimeout(timer);
      timer = setTimeout(async () => {
        try {
          const raw = await readFile(this.file, "utf8");
          if (raw === this.lastWritten) return;
          this.lastWritten = raw;
          // Another process wrote it; its history entry says who and what.
          const last = (await this.readHistory()).undo.at(-1);
          const info = last && last.at > this.lastSeenAt ? { label: last.label, origin: last.origin } : { label: "external change", origin: "external" as const };
          if (last) this.lastSeenAt = last.at;
          this.emit("project", await this.load(), info);
        } catch {
          /* mid-write; next event will catch it */
        }
      }, 60);
    });
  }

  close(): void {
    this.watcher?.close();
    this.dataWatcher?.close();
    this.watcher = undefined;
    this.dataWatcher = undefined;
  }

  // -------------------------------------------------------------------------
  // Review: the snapshot taken before the agent's first unreviewed edit.

  async getReview(): Promise<{ since: string; baseline: Project } | null> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, "review.json"), "utf8"));
    } catch {
      return null;
    }
  }

  async clearReview(): Promise<void> {
    await rm(join(this.dataDir, "review.json"), { force: true });
  }

  // -------------------------------------------------------------------------
  // Feedback: notes pinned to the video for an agent to act on (.cutroom/feedback.json).

  async getFeedback(): Promise<Feedback[]> {
    try {
      return JSON.parse(await readFile(join(this.dataDir, "feedback.json"), "utf8")).items ?? [];
    } catch {
      return [];
    }
  }

  addFeedback(draft: FeedbackDraft): Promise<Feedback> {
    return this.mutateFeedback(async (items) => {
      const project = await this.load();
      const hitStart = timelineToSource(project, draft.time.start);
      const hitEnd = draft.time.end !== null ? timelineToSource(project, draft.time.end) : null;
      const sameClip = hitStart && hitEnd && hitStart.placed.clip.mediaId === hitEnd.placed.clip.mediaId;
      const now = new Date().toISOString();
      const fb: Feedback = {
        id: uid("f"),
        n: items.reduce((m, x) => Math.max(m, x.n), 0) + 1,
        createdAt: now,
        updatedAt: now,
        note: draft.note.trim(),
        status: "open",
        time: draft.time,
        anchor: hitStart
          ? { mediaId: hitStart.placed.clip.mediaId, start: hitStart.src, end: sameClip ? hitEnd!.src : hitStart.src + ((draft.time.end ?? draft.time.start) - draft.time.start) }
          : null,
        region: draft.region ?? null,
        words: draft.words ?? null,
        target: draft.target ?? null,
        replies: [],
        ...(draft.voice ? { voice: draft.voice } : {}),
      };
      if (!fb.note) throw new Error("note is empty");
      items.push(fb);
      return { items, result: fb };
    });
  }

  updateFeedback(id: string, patch: { status?: FeedbackStatus; note?: string; reply?: { author: "user" | "agent"; text: string } }): Promise<Feedback> {
    return this.mutateFeedback(async (items) => {
      const fb = items.find((x) => x.id === id || String(x.n) === id);
      if (!fb) throw new Error(`no feedback ${id}`);
      if (patch.status) fb.status = patch.status;
      if (patch.note !== undefined) fb.note = patch.note;
      if (patch.reply?.text.trim()) fb.replies.push({ author: patch.reply.author, text: patch.reply.text.trim(), at: new Date().toISOString() });
      fb.updatedAt = new Date().toISOString();
      return { items, result: fb };
    });
  }

  deleteFeedback(id: string): Promise<void> {
    return this.mutateFeedback(async (items) => ({ items: items.filter((x) => x.id !== id), result: undefined }));
  }

  private mutateFeedback<T>(fn: (items: Feedback[]) => Promise<{ items: Feedback[]; result: T }>): Promise<T> {
    return this.locked(async () => {
      const { items, result } = await fn(await this.getFeedback());
      const raw = JSON.stringify({ items }, null, 2);
      this.lastFeedback = raw;
      await mkdir(this.dataDir, { recursive: true });
      await atomicWrite(join(this.dataDir, "feedback.json"), raw);
      this.emit("feedback", items);
      return result;
    });
  }

  /** Emit "feedback" if the file changed since we last saw it (another process may have written it). */
  async checkFeedback(): Promise<void> {
    const raw = await readFile(join(this.dataDir, "feedback.json"), "utf8").catch(() => "");
    if (!raw || raw === this.lastFeedback) return;
    try {
      const items = JSON.parse(raw).items ?? [];
      this.lastFeedback = raw;
      this.emit("feedback", items);
    } catch {
      /* mid-write */
    }
  }

  async getAgent(): Promise<AgentPresence | null> {
    try {
      const a = JSON.parse(await readFile(join(this.dataDir, "agent.json"), "utf8")) as AgentPresence;
      return Date.now() - Date.parse(a.lastSeen) < 15_000 ? a : null;
    } catch {
      return null;
    }
  }

  async setAgent(a: Omit<AgentPresence, "lastSeen"> | null): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    if (!a) await rm(join(this.dataDir, "agent.json"), { force: true });
    else await atomicWrite(join(this.dataDir, "agent.json"), JSON.stringify({ ...a, lastSeen: new Date().toISOString() }));
  }

  // -------------------------------------------------------------------------
  // Locking: serialize within this process, and across processes via a lock file.

  private locked<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(async () => {
      const release = await acquireLock(join(this.dataDir, "lock"));
      try {
        return await fn();
      } finally {
        await release();
      }
    });
    this.queue = run.catch(() => {});
    return run;
  }

  // History: a small index (history.json) plus one snapshot file per entry in .cutroom/history/.
  // Snapshots used to be inlined in the index, which made every edit re-read and re-write
  // ~200 full copies of the project (10+ MB on long, heavily cut projects).

  private async readHistory(): Promise<HistoryFile> {
    const path = join(this.dataDir, "history.json");
    const h = await this.readCached<HistoryFile>(path);
    // Callers mutate the result, so hand out a copy of the (small) index.
    return h ? { nextId: h.nextId, undo: [...h.undo], redo: [...h.redo] } : { nextId: 1, undo: [], redo: [] };
  }

  /** Write the index, then delete snapshot files of entries that are no longer referenced. */
  private async writeHistory(h: HistoryFile, dropped: StoredEntry[] = []): Promise<void> {
    await mkdir(this.dataDir, { recursive: true });
    const path = join(this.dataDir, "history.json");
    // Move inline snapshots from older projects out of the index.
    for (const list of [h.undo, h.redo]) {
      for (let i = 0; i < list.length; i++) if (list[i].project) list[i] = await this.snapshot(strip(list[i]), list[i].project!);
    }
    const json = JSON.stringify(h);
    await atomicWrite(path, json);
    this.cache.delete(path);
    const live = new Set([...h.undo, ...h.redo].map((e) => e.snap));
    for (const e of dropped) if (e.snap && !live.has(e.snap)) await rm(join(this.dataDir, "history", e.snap), { force: true });
  }

  private async snapshot(meta: HistoryEntry, project: Project): Promise<StoredEntry> {
    const dir = join(this.dataDir, "history");
    await mkdir(dir, { recursive: true });
    const snap = `${meta.id}-${uid("s")}.json`;
    await atomicWrite(join(dir, snap), JSON.stringify(project));
    return { ...meta, snap };
  }

  private async entryProject(e: StoredEntry): Promise<Project> {
    if (e.project) return e.project;
    if (!e.snap) throw new Error(`history entry ${e.id} has no snapshot`);
    return JSON.parse(await readFile(join(this.dataDir, "history", e.snap), "utf8")) as Project;
  }
}

function strip(e: StoredEntry): HistoryEntry {
  const { project: _p, snap: _s, ...rest } = e;
  return rest;
}

export function describeOps(ops: Op[]): string {
  if (ops.length === 1) return ops[0].op.replace(/_/g, " ");
  const kinds = [...new Set(ops.map((o) => o.op.replace(/_/g, " ")))];
  return kinds.length === 1 ? `${kinds[0]} ×${ops.length}` : `${ops.length} edits (${kinds.slice(0, 3).join(", ")}${kinds.length > 3 ? "…" : ""})`;
}

let tmpCounter = 0;
export async function atomicWrite(path: string, data: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${tmpCounter++}.tmp`;
  await writeFile(tmp, data);
  await rename(tmp, path);
}

async function acquireLock(path: string, timeoutMs = 15_000): Promise<() => Promise<void>> {
  await mkdir(dirname(path), { recursive: true });
  const token = `${process.pid}:${uid("l")}`;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      const fh = await open(path, "wx");
      await fh.writeFile(token);
      await fh.close();
      // Only remove the lock if it is still ours (it may have been broken as stale and re-taken).
      return async () => {
        if ((await readFile(path, "utf8").catch(() => "")) === token) await rm(path, { force: true });
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      // Break locks left behind by crashed processes.
      try {
        const [holder, { mtimeMs }] = await Promise.all([readFile(path, "utf8"), stat(path)]);
        if (Date.now() - mtimeMs > 30_000 || !isAlive(Number(holder.split(":")[0]))) await rm(path, { force: true });
      } catch {
        /* gone already */
      }
      if (Date.now() > deadline) throw new Error(`Timed out waiting for project lock ${path}`);
      await new Promise((r) => setTimeout(r, 25));
    }
  }
}

function isAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return true; // unreadable or mid-write; fall back to the age check
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}
