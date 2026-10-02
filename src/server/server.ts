// Local HTTP + WebSocket server for the web editor. Binds to 127.0.0.1 only and
// rejects foreign Host/Origin headers, so web pages can't drive it (DNS rebinding/CSRF).
import { createReadStream, createWriteStream, existsSync } from "node:fs";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { once } from "node:events";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { basename, extname, join, normalize, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ALL_STEPS,
  analyzeMedia,
  defaultExportName,
  EditError,
  importMedia,
  jobs,
  parseOps,
  render,
  timelineDuration,
  toOTIO,
  type FeedbackDraft,
  type FeedbackStatus,
  type ProjectStore,
} from "../core/index.js";
import { filmstripInfo } from "../core/media.js";
import { toSRT } from "../core/srt.js";
import { FONT_EXT, customFonts, fontFamilyFromFile, systemFonts } from "../core/fonts.js";
import { applyBrand, brandDir, getBrand, saveBrand, setBrandFont, setBrandLogo } from "../core/brand.js";
import { createVoiceNote } from "../core/voice.js";
import { diffProjects } from "../core/shared/diff.js";
import { findRetakes, useTakeOps } from "../core/shared/retakes.js";
import { BUILTIN_LOOKS, parseCube } from "../core/shared/looks.js";

export interface ServerOptions {
  port?: number;
  /** Directory with the built web editor. */
  webDir?: string;
}

export interface RunningServer {
  url: string;
  port: number;
  close(): Promise<void>;
}

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".json": "application/json",
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mkv": "video/x-matroska",
  ".flac": "audio/flac",
  ".opus": "audio/ogg",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mp3": "audio/mpeg",
  ".m4a": "audio/mp4",
  ".ogg": "audio/ogg",
  ".wav": "audio/wav",
  ".aac": "audio/aac",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".cube": "text/plain; charset=utf-8",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export const DEFAULT_WEB_DIR = resolve(fileURLToPath(import.meta.url), "..", "..", "..", "dist", "web");

export async function startServer(store: ProjectStore, opts: ServerOptions = {}): Promise<RunningServer> {
  const webDir = opts.webDir ?? DEFAULT_WEB_DIR;
  const sockets = new Set<WebSocket>();
  const broadcast = (msg: unknown) => {
    const data = JSON.stringify(msg);
    for (const s of sockets) if (s.readyState === s.OPEN) s.send(data);
  };

  store.watch();
  const onProject = async (project: unknown, info: unknown) => broadcast({ type: "project", project, info, history: await store.history() });
  const onSelection = (selection: unknown) => broadcast({ type: "selection", selection });
  const onJob = (job: unknown) => broadcast({ type: "job", job });
  const onFeedback = (items: unknown) => broadcast({ type: "feedback", items });
  const onAgent = (agent: unknown) => broadcast({ type: "agent", agent });
  store.on("project", onProject);
  store.on("selection", onSelection);
  store.on("feedback", onFeedback);
  store.on("agent", onAgent);
  // Presence expires without a file change, so re-check it periodically.
  let lastAgent = "";
  const agentTimer = setInterval(async () => {
    // Safety net for missed fs events (FSEvents can coalesce rapid renames).
    await store.checkFeedback();
    const a = await store.getAgent();
    const key = JSON.stringify(a ? { watching: a.watching, pid: a.pid } : null);
    if (key !== lastAgent) {
      lastAgent = key;
      onAgent(a);
    }
  }, 2000);
  jobs.on("job", onJob);

  let port = opts.port ?? 4321;
  const allowedHost = () => [`127.0.0.1:${port}`, `localhost:${port}`];

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHost().includes(req.headers.host ?? "") || (req.headers.origin && !allowedHost().some((h) => req.headers.origin === `http://${h}`) && !isDevOrigin(req.headers.origin))) {
        return send(res, 403, { error: "forbidden" });
      }
      await route(req, res);
    } catch (err) {
      const status = err instanceof EditError || err instanceof BadRequest ? 400 : 500;
      if (status === 500) console.error(err);
      if (!res.headersSent) send(res, status, { error: err instanceof Error ? err.message : String(err) });
      else res.end();
    }
  });

  async function route(req: IncomingMessage, res: ServerResponse) {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";

    if (path === "/api/state" && method === "GET") {
      const project = await store.load();
      return send(res, 200, {
        project,
        selection: await store.getSelection(),
        history: await store.history(),
        jobs: jobs.list(),
        dir: store.dir,
        feedback: await store.getFeedback(),
        agent: await store.getAgent(),
      });
    }

    let m: RegExpMatchArray | null;
    if ((m = path.match(/^\/api\/media\/(\w+)\/(transcript|silences|waveform|filmstrip)$/)) && method === "GET") {
      const [, id, kind] = m;
      if (kind === "transcript") return send(res, 200, (await store.getTranscript(id)) ?? null);
      if (kind === "silences") return send(res, 200, (await store.getSilences(id)) ?? null);
      if (kind === "waveform") return send(res, 200, (await store.getWaveform(id)) ?? null);
      const media = (await store.load()).media.find((x) => x.id === id);
      if (!media) return send(res, 404, { error: "no such media" });
      return send(res, 200, existsSync(join(store.cacheDir(id), "filmstrip.jpg")) ? await filmstripInfo(media) : null);
    }

    if ((m = path.match(/^\/media\/(\w+)\/(file|filmstrip\.jpg)$/)) && (method === "GET" || method === "HEAD")) {
      const media = (await store.load()).media.find((x) => x.id === m![1]);
      if (!media) return send(res, 404, { error: "no such media" });
      if (m[2] === "filmstrip.jpg") return serveFile(req, res, join(store.cacheDir(media.id), "filmstrip.jpg"));
      const proxy = join(store.cacheDir(media.id), "proxy.mp4");
      return serveFile(req, res, url.searchParams.has("original") || !existsSync(proxy) ? store.resolveMediaPath(media) : proxy);
    }

    if (path === "/api/edit" && method === "POST") {
      const body = await json<{ ops: unknown; label?: string }>(req);
      const result = await store.edit(parseOps(body.ops), "editor", typeof body.label === "string" ? body.label : undefined);
      return send(res, 200, { notes: result.notes, duration: timelineDuration(result.project) });
    }
    if (path === "/api/undo" && method === "POST") return send(res, 200, { entry: await store.undo() });
    if (path === "/api/redo" && method === "POST") return send(res, 200, { entry: await store.redo() });

    if (path === "/api/selection" && method === "POST") {
      return send(res, 200, await store.setSelection(await json(req)));
    }

    if (path === "/api/import" && method === "POST") {
      const body = await json<{ paths: string[]; role?: "main" | "library"; analyze?: boolean }>(req);
      if (!Array.isArray(body.paths) || !body.paths.every((p) => typeof p === "string")) throw new BadRequest("paths must be a list of file paths");
      // Unreadable / unsupported files are the user's input, not a server fault: report them as such.
      const assets = await importMedia(store, body.paths, { role: body.role, origin: "editor" }).catch((e: Error) => {
        throw new BadRequest(e.message);
      });
      if (body.analyze !== false) for (const a of assets) void analyzeJob(a.id, a.name);
      return send(res, 200, { assets });
    }

    if (path === "/api/upload" && method === "POST") {
      const name = basename(url.searchParams.get("name") ?? "");
      if (!name || name.startsWith(".")) throw new BadRequest("missing ?name");
      const dir = join(store.dir, "media");
      await mkdir(dir, { recursive: true });
      let target = join(dir, name);
      for (let i = 1; existsSync(target); i++) target = join(dir, `${basename(name, extname(name))}-${i}${extname(name)}`);
      try {
        await pipeline(req, createWriteStream(target));
      } catch (err) {
        await rm(target, { force: true }); // aborted upload: don't leave a truncated file behind
        throw err;
      }
      const role = url.searchParams.get("role") as "main" | "library" | null;
      const assets = await importMedia(store, [target], { role: role === "main" || role === "library" ? role : undefined, origin: "editor" }).catch(async (e: Error) => {
        await rm(target, { force: true });
        throw new BadRequest(e.message);
      });
      for (const a of assets) void analyzeJob(a.id, a.name);
      return send(res, 200, { assets });
    }

    if ((m = path.match(/^\/api\/analyze\/(\w+)$/)) && method === "POST") {
      const body = await json<{ steps?: string[]; force?: boolean }>(req).catch(() => ({}) as { steps?: string[]; force?: boolean });
      const media = (await store.load()).media.find((x) => x.id === m![1]);
      if (!media) return send(res, 404, { error: "no such media" });
      if (body.steps !== undefined && (!Array.isArray(body.steps) || body.steps.some((x) => !(ALL_STEPS as string[]).includes(x)))) throw new BadRequest(`steps must be some of ${ALL_STEPS.join(", ")}`);
      void analyzeJob(media.id, media.name, body);
      return send(res, 202, { ok: true });
    }

    if (path === "/api/export" && method === "POST") {
      const body = await json<{ quality?: "draft" | "standard" | "high" }>(req).catch(() => ({}) as { quality?: "draft" | "standard" | "high" });
      const project = await store.load();
      const name = defaultExportName(project, store.exportDir);
      await mkdir(store.exportDir, { recursive: true });
      const out = join(store.exportDir, name);
      void jobs
        .run("export", `Export ${name}`, (update) => render(store, { out, quality: body.quality ?? "standard", onProgress: (f) => update(f) }).then(() => ({ file: name, path: out })))
        .catch(() => {});
      return send(res, 202, { file: name });
    }

    // --- Fonts and LUTs (files in the project's fonts/ and luts/ folders) ---------
    if (path === "/api/styles" && method === "GET") {
      return send(res, 200, {
        fonts: await customFonts(store),
        systemFonts: systemFonts(),
        looks: BUILTIN_LOOKS.map(({ id, name, description }) => ({ id, name, description })),
        luts: await listLuts(store),
      });
    }
    if ((path === "/api/fonts" || path === "/api/luts") && method === "POST") {
      const isFont = path === "/api/fonts";
      const name = basename(url.searchParams.get("name") ?? "").replace(/[^\w.\- ]+/g, "_");
      if (!name || name.startsWith(".") || !(isFont ? FONT_EXT : /\.cube$/i).test(name)) throw new BadRequest(isFont ? "upload a .ttf, .otf or .woff2 file" : "upload a .cube file");
      const dir = join(store.dir, isFont ? "fonts" : "luts");
      await mkdir(dir, { recursive: true });
      const body = await raw(req, isFont ? 30_000_000 : 50_000_000);
      if (!isFont) parseCube(body.toString("utf8")); // reject broken LUTs up front
      await writeFile(join(dir, name), body);
      broadcast({ type: "styles" });
      return send(res, 200, { file: name, family: isFont ? fontFamilyFromFile(name) : undefined });
    }
    if ((m = path.match(/^\/(fonts|luts)\/([^/]+)$/)) && method === "GET") {
      const dir = resolve(store.dir, m[1]);
      const file = resolve(dir, decodeURIComponent(m[2]));
      if (!file.startsWith(dir + sep)) return send(res, 403, { error: "forbidden" });
      return serveFile(req, res, file);
    }

    // --- Brand kit (saved per machine) ---------------------------------------------
    if (path === "/api/brand" && method === "GET") return send(res, 200, await getBrand());
    if (path === "/api/brand" && method === "PUT") {
      const brand = await saveBrand(await json(req)).catch((e) => {
        throw new BadRequest(e.message);
      });
      broadcast({ type: "brand", brand });
      return send(res, 200, brand);
    }
    if ((m = path.match(/^\/api\/brand\/(logo|font)$/)) && method === "POST") {
      const name = basename(url.searchParams.get("name") ?? "");
      const body = await raw(req, 30_000_000);
      const brand = await (m[1] === "logo" ? setBrandLogo(name, body) : setBrandFont(name, body)).catch((e) => {
        throw new BadRequest(e.message);
      });
      broadcast({ type: "brand", brand });
      return send(res, 200, brand);
    }
    if (path === "/api/brand/apply" && method === "POST") {
      const r = await applyBrand(store, "editor");
      broadcast({ type: "styles" });
      return send(res, 200, r);
    }
    if ((m = path.match(/^\/(brand-kit|brand|previews)\/([^/]+)$/)) && method === "GET") {
      const dir = m[1] === "brand-kit" ? brandDir() : m[1] === "brand" ? join(store.dir, "brand") : store.previewDir;
      const file = resolve(dir, decodeURIComponent(m[2]));
      if (!file.startsWith(resolve(dir) + sep)) return send(res, 403, { error: "forbidden" });
      return serveFile(req, res, file);
    }

    // Project images (watermark preview). Only image files inside the project folder.
    if ((m = path.match(/^\/pfile\/(.+)$/)) && method === "GET") {
      const file = resolve(store.dir, decodeURIComponent(m[1]));
      if (!file.startsWith(store.dir + sep) || !/\.(png|jpe?g|webp|svg)$/i.test(file)) return send(res, 403, { error: "forbidden" });
      return serveFile(req, res, file);
    }

    // --- Studio sound audition: the real export chain (incl. noise reduction) for a few seconds.
    if (path === "/api/audio-preview" && method === "POST") {
      const body = await json<{ start: number; end: number; bypass?: boolean }>(req);
      const project = await store.load();
      const total = timelineDuration(project);
      const start = Math.max(0, Math.min(body.start, total - 0.5));
      const end = Math.min(total, Math.max(start + 0.5, body.end));
      await mkdir(store.previewDir, { recursive: true });
      const file = `sound-${Date.now()}.m4a`;
      await render(store, { out: join(store.previewDir, file), range: { start, end }, audioOnly: true, quality: "draft" });
      return send(res, 200, { url: `/previews/${file}` });
    }

    // --- Retakes: repeated attempts at the same line -----------------------------------
    if (path === "/api/retakes" && method === "GET") {
      return send(res, 200, findRetakes(await store.load(), (await store.context()).transcripts));
    }
    if (path === "/api/retakes/use" && method === "POST") {
      const body = await json<{ id: string; take: number }>(req);
      const group = findRetakes(await store.load(), (await store.context()).transcripts).find((g) => g.id === body.id);
      if (!group || !group.takes[body.take]) throw new BadRequest("that retake no longer exists");
      const ops = useTakeOps(group, body.take);
      if (ops.length) await store.edit(ops, "editor", `use take ${body.take + 1}`);
      return send(res, 200, { ok: true });
    }

    // --- Review the agent's edits ------------------------------------------------------
    if (path === "/api/review" && method === "GET") {
      const review = await store.getReview();
      if (!review) return send(res, 200, { active: false });
      const project = await store.load();
      const changes = diffProjects(review.baseline, project, (await store.context()).transcripts);
      if (!changes.length) {
        await store.clearReview();
        return send(res, 200, { active: false });
      }
      return send(res, 200, { active: true, since: review.since, baseline: review.baseline, changes });
    }
    if (path === "/api/review/accept" && method === "POST") {
      await store.clearReview();
      broadcast({ type: "review" });
      return send(res, 200, { ok: true });
    }
    if (path === "/api/review/reject" && method === "POST") {
      const review = await store.getReview();
      if (!review) return send(res, 200, { ok: true });
      await store.update(
        (p) => {
          // Restore the edit itself; keep media that was imported since, so nothing dangles.
          const media = [...review.baseline.media, ...p.media.filter((m) => !review.baseline.media.some((b) => b.id === m.id))];
          Object.assign(p, { ...review.baseline, media, name: p.name, createdAt: p.createdAt });
        },
        "editor",
        "reject Claude's changes",
      );
      await store.clearReview();
      broadcast({ type: "review" });
      return send(res, 200, { ok: true });
    }
    if (path === "/api/review/revert" && method === "POST") {
      const { id } = await json<{ id: string }>(req);
      const review = await store.getReview();
      if (!review) throw new BadRequest("nothing to review");
      const change = diffProjects(review.baseline, await store.load(), (await store.context()).transcripts).find((c) => c.id === id);
      if (!change) throw new BadRequest("that change no longer exists");
      await store.edit(change.revert, "editor", `revert: ${change.label}`);
      broadcast({ type: "review" });
      return send(res, 200, { ok: true });
    }

    if (path === "/api/voice-note" && method === "POST") {
      const q = url.searchParams;
      const num = (k: string) => Number(q.get(k));
      const region = q.has("x") ? { x: Math.min(1, Math.max(0, num("x"))), y: Math.min(1, Math.max(0, num("y"))), w: 0, h: 0 } : null;
      const audio = await raw(req, 25_000_000);
      if (audio.length < 1000) throw new BadRequest("That voice note was too short");
      const fb = await jobs.run("voice", "Voice note", (update) =>
        createVoiceNote(store, { audio, ext: q.get("ext") ?? "webm", start: num("start") || 0, end: num("end") || 0, region }, (f) => update(f, "transcript")),
      );
      return send(res, 200, fb);
    }
    if ((m = path.match(/^\/voice\/([^/]+)$/)) && method === "GET") {
      const dir = join(store.dataDir, "voice");
      const file = resolve(dir, decodeURIComponent(m[1]));
      if (!file.startsWith(dir + sep)) return send(res, 403, { error: "forbidden" });
      return serveFile(req, res, file);
    }

    if (path === "/api/feedback" && method === "GET") return send(res, 200, await store.getFeedback());
    if (path === "/api/feedback" && method === "POST") {
      const body = await json<FeedbackDraft>(req);
      if (!body.note?.trim()) throw new BadRequest("note is empty");
      if (typeof body.time?.start !== "number") throw new BadRequest("time.start is required");
      return send(res, 200, await store.addFeedback(body));
    }
    if ((m = path.match(/^\/api\/feedback\/(\w+)$/))) {
      if (method === "PATCH") {
        const body = await json<{ status?: FeedbackStatus; note?: string; reply?: string }>(req);
        return send(res, 200, await store.updateFeedback(m[1], { status: body.status, note: body.note, reply: body.reply ? { author: "user", text: body.reply } : undefined }));
      }
      if (method === "DELETE") {
        await store.deleteFeedback(m[1]);
        return send(res, 200, { ok: true });
      }
    }

    if (path === "/api/otio" && method === "GET") return send(res, 200, await toOTIO(store));
    if (path === "/api/srt" && method === "GET") {
      res.writeHead(200, { "content-type": "application/x-subrip", "content-disposition": 'attachment; filename="captions.srt"' });
      return res.end(await toSRT(store));
    }

    if ((m = path.match(/^\/exports\/([^/]+)$/)) && method === "GET") {
      const file = resolve(store.exportDir, decodeURIComponent(m[1]));
      if (!file.startsWith(store.exportDir + sep)) return send(res, 403, { error: "forbidden" });
      return serveFile(req, res, file, url.searchParams.has("download"));
    }

    if (method === "GET" && !path.startsWith("/api/")) {
      const rel = normalize(decodeURIComponent(path)).replace(/^([/\\])+/, "");
      const file = resolve(webDir, rel || "index.html");
      if (file.startsWith(webDir) && existsSync(file) && (await stat(file)).isFile()) return serveFile(req, res, file);
      const index = join(webDir, "index.html");
      if (existsSync(index)) return serveFile(req, res, index);
      res.writeHead(200, { "content-type": "text/html" });
      return res.end(`<p>cutroom server is running, but the editor isn't built. Run <code>npm run build</code> (or <code>npm run dev</code>).</p>`);
    }

    send(res, 404, { error: "not found" });
  }

  function analyzeJob(id: string, name: string, opts: { steps?: string[]; force?: boolean } = {}) {
    return jobs
      .run("analyze", `Analyze ${name}`, (update) =>
        analyzeMedia(store, id, { steps: opts.steps as never, force: opts.force, onOverall: (f, step) => update(f, step) }),
      )
      .catch((err) => console.error(`analyze ${id} failed:`, err.message));
  }

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const origin = req.headers.origin ?? "";
    const okOrigin = allowedHost().some((h) => origin === `http://${h}`) || isDevOrigin(origin);
    if (new URL(req.url ?? "/", "http://x").pathname !== "/ws" || !allowedHost().includes(req.headers.host ?? "") || !okOrigin) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  });

  // Find a free port starting at the requested one.
  for (let attempt = 0; ; attempt++) {
    try {
      await new Promise<void>((ok, fail) => {
        server.once("error", fail);
        server.listen(port, "127.0.0.1", () => {
          server.off("error", fail);
          ok();
        });
      });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EADDRINUSE" || attempt > 20) throw err;
      port++;
    }
  }

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    close: async () => {
      store.off("project", onProject);
      store.off("selection", onSelection);
      store.off("feedback", onFeedback);
      store.off("agent", onAgent);
      clearInterval(agentTimer);
      jobs.off("job", onJob);
      for (const s of sockets) s.close();
      await new Promise<void>((ok) => server.close(() => ok()));
    },
  };
}

/** The Vite dev server (npm run dev) proxies to us from its own port. */
function isDevOrigin(origin: string): boolean {
  return process.env.CUTROOM_DEV === "1" && /^http:\/\/(localhost|127\.0\.0\.1):5173$/.test(origin);
}

class BadRequest extends Error {}

function send(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  res.end(JSON.stringify(body));
}

async function listLuts(store: ProjectStore): Promise<string[]> {
  const dir = join(store.dir, "luts");
  if (!existsSync(dir)) return [];
  return (await readdir(dir)).filter((f) => /\.cube$/i.test(f) && !f.startsWith("."));
}

async function raw(req: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > limit) throw new BadRequest("file too large");
    chunks.push(c);
  }
  return Buffer.concat(chunks);
}

async function json<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const c of req) {
    size += c.length;
    if (size > 5_000_000) throw new BadRequest("body too large");
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString() || "{}");
  } catch {
    throw new BadRequest("invalid JSON");
  }
}

/** Static file with HTTP Range support (needed for <video> seeking). */
async function serveFile(req: IncomingMessage, res: ServerResponse, file: string, download = false) {
  let info;
  try {
    info = await stat(file);
  } catch {
    return send(res, 404, { error: "file not found" });
  }
  const type = MIME[extname(file).toLowerCase()] ?? "application/octet-stream";
  const headers: Record<string, string | number> = { "content-type": type, "accept-ranges": "bytes", "cache-control": type.startsWith("text/html") ? "no-cache" : "no-store" };
  if (download) headers["content-disposition"] = `attachment; filename="${basename(file).replace(/"/g, "")}"`;
  const range = req.headers.range && /bytes=(\d*)-(\d*)/.exec(req.headers.range);
  if (range) {
    const start = range[1] ? Number(range[1]) : Math.max(0, info.size - Number(range[2]));
    const end = range[1] && range[2] ? Math.min(Number(range[2]), info.size - 1) : info.size - 1;
    if (start >= info.size || start > end) {
      res.writeHead(416, { "content-range": `bytes */${info.size}` });
      return res.end();
    }
    return stream(req, res, file, 206, { ...headers, "content-range": `bytes ${start}-${end}/${info.size}`, "content-length": end - start + 1 }, { start, end });
  }
  return stream(req, res, file, 200, { ...headers, "content-length": info.size });
}

/** Open before sending headers (so EACCES etc. become a 403), pipe without crashing on read errors, and close the file when the client aborts (e.g. a seek). */
async function stream(req: IncomingMessage, res: ServerResponse, file: string, status: number, headers: Record<string, string | number>, range?: { start: number; end: number }) {
  if (req.method === "HEAD") {
    res.writeHead(status, headers);
    return res.end();
  }
  const src = createReadStream(file, range);
  try {
    await once(src, "open");
  } catch {
    return send(res, 403, { error: "file not readable" });
  }
  res.writeHead(status, headers);
  pipeline(src, res).catch(() => res.destroy());
}

