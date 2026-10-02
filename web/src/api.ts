import type { Op } from "../../src/core/shared/ops";
import type { AgentPresence, Feedback, FeedbackDraft, FeedbackStatus, HistoryEntry, Project } from "../../src/core/shared/types";
import { store, toast, type Job, type State, type Styles } from "./store";

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body !== undefined ? { "content-type": "application/json" } : undefined,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error ?? `${res.status} ${res.statusText}`);
  return data as T;
}

const fail = (e: Error) => {
  toast(e.message, "error");
  return null;
};

export const api = {
  async edit(ops: Op[], label?: string): Promise<boolean> {
    try {
      await request("POST", "/api/edit", { ops, label });
      return true;
    } catch (err) {
      toast((err as Error).message, "error");
      return false;
    }
  },
  undo: () => request<{ entry: HistoryEntry | null }>("POST", "/api/undo").catch(fail),
  redo: () => request<{ entry: HistoryEntry | null }>("POST", "/api/redo").catch(fail),
  analyze: (id: string, steps?: string[], force?: boolean) => request("POST", `/api/analyze/${id}`, { steps, force }).catch(fail),
  importPaths: (paths: string[], role?: "main" | "library") => request("POST", "/api/import", { paths, role }).catch(fail),
  exportVideo: (quality: string) => request<{ file: string }>("POST", "/api/export", { quality }).catch(fail),
  selection: (sel: unknown) => request("POST", "/api/selection", sel).catch(() => {}),
  addFeedback: (draft: FeedbackDraft) => request<Feedback>("POST", "/api/feedback", draft).catch(fail),
  updateFeedback: (id: string, patch: { status?: FeedbackStatus; note?: string; reply?: string }) => request<Feedback>("PATCH", `/api/feedback/${id}`, patch).catch(fail),
  deleteFeedback: (id: string) => request("DELETE", `/api/feedback/${id}`).catch(fail),
  reviewAccept: () => request("POST", "/api/review/accept").then(loadReview).catch(fail),
  reviewReject: () => request("POST", "/api/review/reject").then(loadReview).catch(fail),
  reviewRevert: (id: string) => request("POST", "/api/review/revert", { id }).then(loadReview).catch(fail),
  saveBrand: (patch: Record<string, unknown>) => request("PUT", "/api/brand", patch).catch(fail),
  applyBrand: () => request<{ notes: string[] }>("POST", "/api/brand/apply").catch(fail),
  audioPreview: (start: number, end: number) => request<{ url: string }>("POST", "/api/audio-preview", { start, end }).catch(fail),
  async uploadBrand(kind: "logo" | "font", file: File) {
    try {
      const res = await fetch(`/api/brand/${kind}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      return data;
    } catch (err) {
      toast((err as Error).message, "error");
      return null;
    }
  },
  async uploadAsset(kind: "fonts" | "luts", file: File): Promise<{ file: string; family?: string } | null> {
    try {
      const res = await fetch(`/api/${kind}?name=${encodeURIComponent(file.name)}`, { method: "POST", body: file });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? res.statusText);
      return data;
    } catch (err) {
      toast((err as Error).message, "error");
      return null;
    }
  },
  upload(file: File, role?: "main" | "library", onProgress?: (f: number) => void): Promise<void> {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", `/api/upload?name=${encodeURIComponent(file.name)}${role ? `&role=${role}` : ""}`);
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total);
      xhr.onload = () => (xhr.status < 300 ? resolve() : reject(new Error(JSON.parse(xhr.responseText || "{}").error ?? xhr.statusText)));
      xhr.onerror = () => reject(new Error("Upload failed"));
      xhr.send(file);
    });
  },
};

/** Fetch analysis artifacts for media whose analysis changed. */
const loaded = new Map<string, string>();
async function loadArtifacts(project: Project, force = false) {
  if (force) loaded.clear();
  for (const m of project.media) {
    const key = JSON.stringify(m.analysis);
    if (loaded.get(m.id) === key) continue;
    loaded.set(m.id, key);
    const get = (kind: string) => fetch(`/api/media/${m.id}/${kind}`).then((r) => (r.ok ? r.json() : null));
    const [transcript, silences, waveform, filmstrip] = await Promise.all([get("transcript"), get("silences"), get("waveform"), get("filmstrip")]);
    store.set((s) => ({
      transcripts: transcript ? { ...s.transcripts, [m.id]: transcript } : s.transcripts,
      silences: silences ? { ...s.silences, [m.id]: silences } : s.silences,
      waveforms: waveform ? { ...s.waveforms, [m.id]: waveform } : s.waveforms,
      filmstrips: filmstrip ? { ...s.filmstrips, [m.id]: filmstrip } : s.filmstrips,
    }));
  }
}

let reviewTimer: number | undefined;
/** Refresh the agent-edit review (debounced; runs after every project change). */
export function loadReview(): Promise<void> {
  clearTimeout(reviewTimer);
  return new Promise((done) => {
    reviewTimer = window.setTimeout(async () => {
      const r = await request<{ active: boolean; since?: string; baseline?: Project; changes?: import("../../src/core/shared/diff").Change[] }>("GET", "/api/review").catch(() => null);
      const review = r?.active ? { since: r.since!, baseline: r.baseline!, changes: r.changes! } : null;
      store.set((s) => ({ review, reviewView: review ? s.reviewView : "after" }));
      done();
    }, 250);
  });
}

export async function loadBrand() {
  const brand = await request<import("../../src/core/shared/types").BrandKit>("GET", "/api/brand").catch(() => null);
  if (!brand) return;
  store.set({ brand });
  if (brand.fontFile && !loadedFonts.has(`brand:${brand.fontFile}`) && brand.fontFamily) {
    loadedFonts.add(`brand:${brand.fontFile}`);
    try {
      document.fonts.add(await new FontFace(brand.fontFamily, `url(/brand-kit/${encodeURIComponent(brand.fontFile)})`).load());
      window.dispatchEvent(new CustomEvent("cutroom:font"));
    } catch {
      /* preview falls back */
    }
  }
}

/** Fonts, LUTs and looks. Custom fonts are registered with the browser so captions preview in them. */
const loadedFonts = new Set<string>();
export async function loadStyles() {
  const styles = await request<Styles>("GET", "/api/styles").catch(() => null);
  if (!styles) return;
  store.set({ styles });
  for (const f of styles.fonts) {
    if (loadedFonts.has(f.file)) continue;
    loadedFonts.add(f.file);
    try {
      const face = new FontFace(f.family, `url(/fonts/${encodeURIComponent(f.file)})`);
      document.fonts.add(await face.load());
      window.dispatchEvent(new CustomEvent("cutroom:font"));
    } catch {
      toast(`Couldn't load font ${f.file}`, "error");
    }
  }
}

function applyProject(project: Project) {
  store.set((s) => {
    const ids = new Set([...project.clips.map((c) => c.id), ...project.overlays.map((o) => o.id), ...project.zooms.map((z) => z.id)]);
    return { project, items: s.items.filter((i) => ids.has(i.id)) };
  });
  void loadArtifacts(project);
}

interface StateResponse {
  project: Project;
  history: State["history"];
  jobs: Job[];
  dir: string;
  feedback: Feedback[];
  agent: AgentPresence | null;
}

async function loadState() {
  const st = await request<StateResponse>("GET", "/api/state");
  store.set({
    dir: st.dir,
    history: st.history,
    jobs: Object.fromEntries(st.jobs.map((j) => [j.id, j])),
    feedback: st.feedback,
    agent: st.agent,
  });
  applyProject(st.project);
  void loadStyles();
  void loadBrand();
  void loadReview();
}

function onFeedback(items: Feedback[]) {
  const before = new Map(store.get().feedback.map((f) => [f.id, f]));
  for (const f of items) {
    const old = before.get(f.id);
    const lastReply = f.replies[f.replies.length - 1];
    if (old && lastReply?.author === "agent" && f.replies.length > old.replies.length) toast(`Claude on #${f.n}: ${lastReply.text}`, "agent");
    else if (old && old.status !== f.status && f.status === "working") toast(`Claude is working on #${f.n}`, "agent");
  }
  store.set({ feedback: items });
}

export async function connect() {
  // Retry until the server answers; the editor may open before the server is up.
  for (let attempt = 0; ; attempt++) {
    try {
      await loadState();
      break;
    } catch (err) {
      if (attempt === 2) toast(`Can't reach the cutroom server (${(err as Error).message}). Retrying…`, "error");
      await new Promise((r) => setTimeout(r, Math.min(5000, 500 * 2 ** attempt)));
    }
  }

  const open = () => {
    const ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/ws`);
    ws.onopen = () => store.set({ connected: true });
    ws.onclose = () => {
      store.set({ connected: false });
      setTimeout(async () => {
        // Catch up on everything missed while disconnected, jobs included.
        await loadState().catch(() => {});
        open();
      }, 1500);
    };
    ws.onmessage = (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.type === "project") {
        applyProject(msg.project);
        void loadReview();
        store.set({ history: msg.history });
        if (msg.info?.origin === "agent") {
          store.set({ agentActiveAt: Date.now() });
          toast(`Claude: ${msg.info.label}`, "agent");
        }
      } else if (msg.type === "job") {
        const job: Job = msg.job;
        store.set((s) => ({ jobs: { ...s.jobs, [job.id]: job } }));
        if (job.status === "error") toast(`${job.label} failed: ${job.error}`, "error");
        if (job.status === "done" && job.kind === "export") toast(`Exported ${job.result?.file}`, "info");
        const failed = job.status === "done" && job.kind === "analyze" && typeof job.result?.transcript === "string" && job.result.transcript.startsWith("failed");
        if (failed) toast(`Transcription ${String(job.result!.transcript)}. Run \`cutroom doctor\` to check your setup.`, "error");
        if (job.status === "done" && job.kind === "analyze") {
          const p = store.get().project;
          if (p) void loadArtifacts(p, true);
        }
      } else if (msg.type === "feedback") {
        onFeedback(msg.items);
      } else if (msg.type === "agent") {
        store.set({ agent: msg.agent });
      } else if (msg.type === "styles") {
        void loadStyles();
      } else if (msg.type === "review") {
        void loadReview();
      } else if (msg.type === "brand") {
        store.set({ brand: msg.brand });
        void loadBrand();
      }
    };
  };
  open();
}
