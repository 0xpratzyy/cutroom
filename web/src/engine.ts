// Real-time preview of the edit, without rendering.
//
// The main track plays through two <video> elements: one is on screen while the
// other is already seeked to the next piece, so jumps across cuts are near-instant.
// Framing uses the same computeCrop() and drawCaptionPage() as the exporter.
//
// Every async operation (seek, start, edit re-sync) takes a token; a newer
// operation invalidates older ones, so rapid seeks and live agent edits can't
// leave two elements playing or the playhead fighting itself.
import { drawCaptionFrame, type Ctx2D } from "../../src/core/shared/captions";
import { bakeLook, isNeutral, parseCube, type Cube } from "../../src/core/shared/looks";
import { buildPlan, pieceZoomAt, type PlanPiece, type RenderPlan } from "../../src/core/shared/plan";
import { computeCrop, sourceToTimeline } from "../../src/core/shared/timeline";
import type { Look, MediaAsset, Project } from "../../src/core/shared/types";
import { Grader, type Crop as UvCrop } from "./grade";
import { AudioFx } from "./audiofx";
import { drawHook } from "../../src/core/shared/hook";
import { store } from "./store";

export interface EngineElements {
  frame: HTMLDivElement;
  a: HTMLVideoElement;
  b: HTMLVideoElement;
  overlay: HTMLVideoElement;
  overlayImg: HTMLImageElement;
  captions: HTMLCanvasElement;
  grade: HTMLCanvasElement;
  logo: HTMLImageElement;
}

const mediaUrl = (id: string) => `/media/${id}/file`;

class Engine {
  private els?: EngineElements;
  private plan: RenderPlan | null = null;
  private planKey = "";
  private active: HTMLVideoElement | null = null;
  private piece = -1;
  private raf = 0;
  private displayW = 0;
  private displayH = 0;
  private token = 0;
  private lastStoreTime = 0;
  private lastProject: unknown = null;
  private lastTranscripts: unknown = null;
  /** Source position of the playhead, so a live edit doesn't make playback jump. */
  private srcPos: { mediaId: string; src: number } | null = null;
  // Color grading (WebGL). Videos keep decoding underneath at opacity 0.
  private grader: Grader | null = null;
  private gradeOn = false;
  private lookKey = "";
  private gradeRaf = 0;
  private uv = new WeakMap<HTMLVideoElement, UvCrop>();
  private cubes = new Map<string, Promise<Cube | null>>();
  private fx: AudioFx | null = null;

  attach(els: EngineElements): () => void {
    this.els = els;
    for (const v of [els.a, els.b, els.overlay]) {
      v.preload = "auto";
      v.playsInline = true;
    }
    els.overlay.muted = true;
    this.active = els.a;
    try {
      if (Grader.supported()) this.grader = new Grader(els.grade);
    } catch (err) {
      console.warn("Color grading preview unavailable:", err);
    }
    this.fx = new AudioFx([els.a, els.b]);
    const unsub = store.subscribe(() => this.onStore());
    // Browsers suspend requestAnimationFrame in hidden tabs while <video> keeps playing,
    // which would play straight through cuts. Pause instead.
    const onVis = () => document.hidden && this.pause();
    document.addEventListener("visibilitychange", onVis);
    this.onStore();
    return () => {
      unsub();
      document.removeEventListener("visibilitychange", onVis);
      cancelAnimationFrame(this.gradeRaf);
      this.pause();
    };
  }

  resize(w: number, h: number) {
    this.displayW = w;
    this.displayH = h;
    if (!this.els) return;
    const dpr = window.devicePixelRatio || 1;
    this.els.captions.width = Math.round(w * dpr);
    this.els.captions.height = Math.round(h * dpr);
    this.els.grade.width = Math.round(w * dpr);
    this.els.grade.height = Math.round(h * dpr);
    this.renderFrame(store.get().time);
    const piece = this.plan?.pieces[this.piece];
    if (piece && this.active) this.frameVideo(this.active, piece);
    const project = this.proj();
    if (project) this.updateWatermark(project);
  }

  get duration() {
    return this.plan?.duration ?? 0;
  }

  private onStore() {
    const s = store.get();
    const project = this.proj();
    if (!project) return;
    this.fx?.set(project.audio, s.soundBypass);
    if (project === this.lastProject && s.transcripts === this.lastTranscripts) return;
    void this.updateLook(project.look);
    this.updateWatermark(project);
    const transcriptsChanged = s.transcripts !== this.lastTranscripts;
    this.lastProject = project;
    this.lastTranscripts = s.transcripts;
    const key = JSON.stringify([project.clips, project.overlays, project.zooms, project.captions, project.settings, project.hook]);
    if (key === this.planKey && !transcriptsChanged) return;
    const editChanged = key !== this.planKey;
    this.planKey = key;
    this.plan = buildPlan(project, s.transcripts);
    this.piece = -1;

    // Keep the playhead on the same footage through the edit.
    let t = Math.min(s.time, this.plan.duration);
    if (editChanged && this.srcPos) {
      const mapped = sourceToTimeline(project, this.srcPos.mediaId, this.srcPos.src);
      if (mapped !== null) t = mapped;
    }
    if (s.playing) void this.startAt(t);
    else void this.seek(t);
  }

  /** The project being previewed: the "before" version while reviewing, otherwise the current edit. */
  private proj(): Project | null {
    const s = store.get();
    return s.reviewView === "before" && s.review?.baseline ? s.review.baseline : s.project;
  }

  private media(id: string): MediaAsset | undefined {
    return this.proj()?.media.find((m) => m.id === id);
  }

  private pieceAt(t: number): number {
    if (!this.plan) return -1;
    const ps = this.plan.pieces;
    let lo = 0;
    let hi = ps.length - 1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (t < ps[mid].start - 1e-4) hi = mid - 1;
      else if (t >= ps[mid].end - 1e-4) lo = mid + 1;
      else return mid;
    }
    return ps.length && t >= ps[ps.length - 1].end - 1e-4 ? ps.length - 1 : -1;
  }

  private frameVideo(v: HTMLVideoElement, p: PlanPiece | undefined, t?: number) {
    if (!p) return;
    const m = this.media(p.mediaId);
    const project = this.proj();
    if (!m || !project || !this.displayW) return;
    if (!m.hasVideo) {
      v.style.visibility = "hidden";
      return;
    }
    const k = this.displayW / project.settings.width;
    const W = project.settings.width;
    const H = project.settings.height;
    const c = computeCrop(m.width, m.height, W, H, pieceZoomAt(p, t ?? p.start), p.focus);
    Object.assign(v.style, { width: `${c.width * k}px`, height: `${c.height * k}px`, left: `${-c.x * k}px`, top: `${-c.y * k}px` });
    this.uv.set(v, [c.x / c.width, c.y / c.height, (c.x + W) / c.width, (c.y + H) / c.height]);
  }

  /** Output level in dBFS for the meter. */
  level(): number {
    return this.fx?.level() ?? -Infinity;
  }

  /** Call from a click handler: lets studio sound take over the audio path. */
  enableSound() {
    this.fx?.ensure();
  }

  private updateWatermark(project: Project) {
    const img = this.els?.logo;
    if (!img) return;
    const wm = project.watermark;
    if (!wm.enabled || !wm.file || !this.displayW) {
      img.style.visibility = "hidden";
      return;
    }
    const src = `/pfile/${wm.file.split("/").map(encodeURIComponent).join("/")}`;
    if (img.dataset.src !== src) {
      img.dataset.src = src;
      img.src = src;
    }
    const w = wm.size * this.displayW;
    const m = wm.margin * this.displayW;
    Object.assign(img.style, {
      visibility: "visible",
      width: `${w}px`,
      height: "auto",
      opacity: String(wm.opacity),
      left: wm.corner.endsWith("l") ? `${m}px` : "auto",
      right: wm.corner.endsWith("r") ? `${m}px` : "auto",
      top: wm.corner.startsWith("t") ? `${m}px` : "auto",
      bottom: wm.corner.startsWith("b") ? `${m}px` : "auto",
    });
  }

  // ---------------------------------------------------------------- grading

  private cube(file: string): Promise<Cube | null> {
    if (!this.cubes.has(file)) {
      this.cubes.set(
        file,
        fetch(`/luts/${encodeURIComponent(file)}`)
          .then((r) => (r.ok ? r.text() : Promise.reject(new Error(r.statusText))))
          .then(parseCube)
          .catch(() => null),
      );
    }
    return this.cubes.get(file)!;
  }

  private async bake(look: Look): Promise<Float32Array | null> {
    if (isNeutral(look)) return null;
    const custom = look.lut?.startsWith("custom:") ? await this.cube(look.lut.slice(7)) : null;
    return bakeLook(look, custom);
  }

  private async updateLook(look: Look) {
    const key = JSON.stringify(look);
    if (key === this.lookKey || !this.grader || !this.els) return;
    this.lookKey = key;
    const data = await this.bake(look);
    if (key !== this.lookKey) return;
    this.grader.setLut(data);
    this.gradeOn = !!data;
    this.els.frame.classList.toggle("graded", this.gradeOn);
    cancelAnimationFrame(this.gradeRaf);
    if (this.gradeOn) this.gradeLoop();
  }

  private gradeLoop = () => {
    const v = this.active;
    const uv = v && this.uv.get(v);
    if (this.grader && v && uv && v.readyState >= 2 && v.style.visibility !== "hidden") this.grader.draw(v, uv);
    this.gradeRaf = requestAnimationFrame(this.gradeLoop);
  };

  /** Thumbnails of the current frame through each look (for the Style panel). */
  async lookThumbs(looks: Look[], width = 160): Promise<(string | null)[]> {
    const project = this.proj();
    const v = this.active;
    const uv = v && this.uv.get(v);
    if (!project || !v || !uv || v.readyState < 2 || !Grader.supported()) return looks.map(() => null);
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = Math.round((width * project.settings.height) / project.settings.width);
    const g = new Grader(canvas);
    const out: (string | null)[] = [];
    for (const look of looks) {
      g.setLut(await this.bake(look));
      out.push(g.draw(v, uv) ? canvas.toDataURL("image/jpeg", 0.82) : null);
    }
    return out;
  }

  /** Force a redraw of overlays/captions (e.g. after a web font loads). */
  refresh() {
    this.renderFrame(store.get().time);
  }

  /** Load a media file into an element and seek it. Resolves when the frame is ready. */
  private load(v: HTMLVideoElement, mediaId: string, time: number): Promise<void> {
    return new Promise((resolve) => {
      const doSeek = () => {
        if (Math.abs(v.currentTime - time) < 0.01 && v.readyState >= 2) return resolve();
        const done = () => {
          v.removeEventListener("seeked", done);
          resolve();
        };
        v.addEventListener("seeked", done);
        v.currentTime = time;
      };
      if (v.dataset.media !== mediaId) {
        v.dataset.media = mediaId;
        v.src = mediaUrl(mediaId);
        v.addEventListener("loadedmetadata", doSeek, { once: true });
        v.addEventListener("error", () => resolve(), { once: true });
      } else if (v.readyState >= 1) doSeek();
      else v.addEventListener("loadedmetadata", doSeek, { once: true });
    });
  }

  private other(v: HTMLVideoElement) {
    return v === this.els!.a ? this.els!.b : this.els!.a;
  }

  private show(v: HTMLVideoElement) {
    const o = this.other(v);
    v.style.visibility = "visible";
    o.style.visibility = "hidden";
    v.muted = false;
    o.muted = true;
    o.pause();
    this.active = v;
  }

  private preloadNext() {
    if (!this.plan || !this.active) return;
    const next = this.plan.pieces[this.piece + 1];
    const cur = this.plan.pieces[this.piece];
    if (!next || !cur || this.isContinuous(cur, next)) return;
    const o = this.other(this.active);
    o.pause();
    void this.load(o, next.mediaId, next.srcIn);
    this.frameVideo(o, next);
  }

  private isContinuous(a: PlanPiece, b: PlanPiece) {
    return a.mediaId === b.mediaId && Math.abs(a.srcOut - b.srcIn) < 0.05;
  }

  private remember(p: PlanPiece, t: number) {
    this.srcPos = { mediaId: p.mediaId, src: p.srcIn + (t - p.start) };
  }

  /** Move the playhead. Keeps playing if playback is running. */
  async seek(t: number) {
    if (!this.els || !this.plan) return;
    if (store.get().playing) return this.startAt(t);
    const token = ++this.token;
    cancelAnimationFrame(this.raf);
    t = Math.max(0, Math.min(t, this.plan.duration));
    store.set({ time: t });
    this.renderFrame(t);
    const i = this.pieceAt(t);
    if (i < 0) {
      this.els.a.style.visibility = this.els.b.style.visibility = "hidden";
      this.srcPos = null;
      return;
    }
    const p = this.plan.pieces[i];
    this.remember(p, t);
    const target = this.active?.dataset.media === p.mediaId ? this.active : this.other(this.active!).dataset.media === p.mediaId ? this.other(this.active!) : this.active!;
    this.frameVideo(target, p, t);
    await this.load(target, p.mediaId, p.srcIn + (t - p.start));
    if (token !== this.token) return;
    this.piece = i;
    this.show(target);
    this.preloadNext();
  }

  toggle() {
    store.get().playing ? this.pause() : this.play();
  }

  play() {
    if (!this.plan || !this.plan.pieces.length) return;
    this.fx?.ensure();
    let t = store.get().time;
    if (t >= this.plan.duration - 0.05) t = 0;
    store.set({ playing: true });
    void this.startAt(t);
  }

  private async startAt(t: number) {
    if (!this.plan || !this.els) return;
    const token = ++this.token;
    cancelAnimationFrame(this.raf);
    t = Math.max(0, Math.min(t, this.plan.duration));
    const i = this.pieceAt(t);
    if (i < 0) return this.pause();
    const p = this.plan.pieces[i];
    const v = this.active!;
    store.set({ time: t });
    this.frameVideo(v, p);
    await this.load(v, p.mediaId, p.srcIn + (t - p.start));
    if (token !== this.token || !store.get().playing) return;
    this.piece = i;
    this.remember(p, t);
    this.show(v);
    this.preloadNext();
    try {
      await v.play();
    } catch {
      // Autoplay is blocked until a user gesture.
      if (token === this.token) this.pause();
      return;
    }
    if (token !== this.token) return;
    this.raf = requestAnimationFrame(() => this.tick(token));
  }

  pause() {
    this.token++;
    store.set({ playing: false });
    cancelAnimationFrame(this.raf);
    this.els?.a.pause();
    this.els?.b.pause();
    this.els?.overlay.pause();
  }

  private tick(token: number) {
    if (token !== this.token || !store.get().playing || !this.plan || !this.active) return;
    const p = this.plan.pieces[this.piece];
    if (!p) return this.pause();
    const v = this.active;
    let t = p.start + (v.currentTime - p.srcIn);

    if (v.currentTime >= p.srcOut - 0.012 || v.ended) {
      const next = this.plan.pieces[this.piece + 1];
      if (!next) {
        this.pause();
        store.set({ time: this.plan.duration });
        return;
      }
      this.piece++;
      if (this.isContinuous(p, next)) {
        this.frameVideo(v, next); // same file keeps playing; only framing changes (zoom)
      } else {
        const o = this.other(v);
        const ready = o.dataset.media === next.mediaId && o.readyState >= 2 && !o.seeking && Math.abs(o.currentTime - next.srcIn) < 0.1;
        if (ready) {
          this.frameVideo(o, next);
          this.show(o);
          void o.play().catch(() => {});
        } else {
          // The other element isn't ready (very short piece or slow decode): seek in place.
          v.currentTime = next.srcIn;
          this.frameVideo(v, next);
        }
      }
      this.preloadNext();
      t = next.start;
    }

    const cur = this.plan.pieces[this.piece];
    t = Math.max(cur.start, Math.min(t, cur.end));
    if (cur.zoom !== cur.zoomTo) this.frameVideo(this.active!, cur, t); // smooth zoom ramp
    this.remember(cur, t);
    this.renderFrame(t);
    const now = performance.now();
    if (now - this.lastStoreTime > 33) {
      this.lastStoreTime = now;
      store.set({ time: t });
    }
    this.raf = requestAnimationFrame(() => this.tick(token));
  }

  /** Overlays and captions for time t. */
  private renderFrame(t: number) {
    if (!this.els || !this.plan) return;
    const project = this.proj() as Project;
    const { overlay, overlayImg, captions } = this.els;
    const o = this.plan.overlays.find((x) => t >= x.start && t < x.end);
    const k = this.displayW / project.settings.width;
    const playing = store.get().playing;

    if (o) {
      const m = this.media(o.mediaId);
      const el: HTMLVideoElement | HTMLImageElement = m?.kind === "image" ? overlayImg : overlay;
      (el === overlay ? overlayImg : overlay).style.visibility = "hidden";
      if (m) {
        if (o.mode === "pip") {
          const pip = o.pip ?? { x: 0.68, y: 0.06, w: 0.28 };
          const w = pip.w * this.displayW;
          Object.assign(el.style, { width: `${w}px`, height: `${(w * m.height) / m.width}px`, left: `${pip.x * this.displayW}px`, top: `${pip.y * this.displayH}px`, borderRadius: "6px" });
        } else {
          const c = computeCrop(m.width, m.height, project.settings.width, project.settings.height, 1, o.focus);
          Object.assign(el.style, { width: `${c.width * k}px`, height: `${c.height * k}px`, left: `${-c.x * k}px`, top: `${-c.y * k}px`, borderRadius: "0" });
        }
        el.style.visibility = "visible";
        const src = o.srcIn + (t - o.start);
        if (el === overlayImg) {
          if (overlayImg.dataset.media !== m.id) {
            overlayImg.dataset.media = m.id;
            overlayImg.src = mediaUrl(m.id);
          }
        } else {
          if (overlay.dataset.media !== m.id) {
            overlay.dataset.media = m.id;
            overlay.src = mediaUrl(m.id);
          }
          overlay.muted = o.volume === 0;
          overlay.volume = Math.min(1, o.volume || 0);
          if (Math.abs(overlay.currentTime - src) > (playing ? 0.3 : 0.04)) overlay.currentTime = src;
          if (playing && overlay.paused) void overlay.play().catch(() => {});
          if (!playing && !overlay.paused) overlay.pause();
        }
      }
    } else {
      overlay.style.visibility = "hidden";
      overlayImg.style.visibility = "hidden";
      if (!overlay.paused) overlay.pause();
    }

    const ctx = captions.getContext("2d")!;
    ctx.clearRect(0, 0, captions.width, captions.height);
    const page = this.plan.captions.find((pg) => t >= pg.start && t < pg.end);
    if (page) drawCaptionFrame(ctx as unknown as Ctx2D, captions.width, captions.height, page, project.captions, t);
    if (this.plan.hook) {
      // Paused on the opening frame: show the settled title rather than the first frame of its entrance.
      const h = this.plan.hook;
      const ht = !playing && t >= h.start && t < h.start + 0.3 ? h.start + 0.3 : t;
      drawHook(ctx as unknown as Ctx2D, captions.width, captions.height, h, ht);
    }
  }
}

export const engine = new Engine();
