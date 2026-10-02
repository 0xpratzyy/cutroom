// Hook title, studio sound and brand kit sections of the Style tab.
import { useEffect, useRef, useState } from "react";
import { AUDIO_PRESETS } from "../../../src/core/shared/audio";
import { CAPTION_PRESETS, type Ctx2D } from "../../../src/core/shared/captions";
import { drawHook, HOOK_PRESETS } from "../../../src/core/shared/hook";
import { BUILTIN_LOOKS } from "../../../src/core/shared/looks";
import type { Op } from "../../../src/core/shared/ops";
import type { BrandKit, HookTitle, Project, Watermark } from "../../../src/core/shared/types";
import { api } from "../api";
import { engine } from "../engine";
import { store, toast, useStore } from "../store";
import { Icon } from "./Icon";
import { FontSelect, Slider, Swatch, useFrameTick } from "./Style";

const edit = (op: Op, label?: string) => void api.edit([op], label);

async function askClaude(note: string) {
  const fb = await api.addFeedback({ note, time: { start: 0, end: null } });
  if (fb) {
    toast(`Asked Claude (note #${fb.n})`, "agent");
    store.set({ rightTab: "feedback" });
  }
}

// ------------------------------------------------------------------ hook title

function HookCard({ preset, hook, bg }: { preset: HookTitle["preset"]; hook: HookTitle; bg: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const name = HOOK_PRESETS.find((p) => p.id === preset)!.name;
  useEffect(() => {
    const c = ref.current!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      c.width = c.clientWidth * dpr;
      c.height = c.clientHeight * dpr;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, c.width, c.height);
      const sample: HookTitle = { ...hook, enabled: true, preset, text: hook.text.trim() || "Stop editing videos by hand", position: 0.5, fontSize: 0.15, start: 0, duration: 10 };
      drawHook(ctx as unknown as Ctx2D, c.width, c.height, sample, 2);
    };
    draw();
    window.addEventListener("cutroom:font", draw);
    return () => window.removeEventListener("cutroom:font", draw);
  }, [hook, preset]);
  return (
    <button className={`preset-card ${hook.enabled && hook.preset === preset ? "on" : ""}`} onClick={() => edit({ op: "set_hook", preset, enabled: true }, `hook style ${name}`)}>
      <span className="preset-stage" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
        <canvas ref={ref} />
      </span>
      <span className="look-name">{name}</span>
    </button>
  );
}

export function HookSection({ project }: { project: Project }) {
  const h = project.hook;
  const tick = useFrameTick();
  const [bg, setBg] = useState<string | null>(null);
  const [text, setText] = useState(h.text);
  useEffect(() => setText(h.text), [h.text]);
  useEffect(() => {
    let live = true;
    void engine.lookThumbs([project.look], 200).then(([u]) => live && setBg(u));
    return () => {
      live = false;
    };
  }, [tick, project.look]);
  const set = (patch: Partial<HookTitle>, label = "hook title") => edit({ op: "set_hook", ...patch } as Op, label);
  const commitText = () => text !== h.text && set({ text }, "hook text");

  return (
    <div className="section">
      <div className="section-title">
        Hook title
        <input type="checkbox" checked={h.enabled} onChange={(e) => set({ enabled: e.target.checked }, e.target.checked ? "hook on" : "hook off")} title="Show a title over the opening seconds" />
      </div>
      <textarea
        className="hook-text"
        rows={2}
        placeholder="Stop editing videos by hand"
        value={text}
        onChange={(e) => setText(e.target.value)}
        onBlur={commitText}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            commitText();
          }
        }}
      />
      <button className="sm agent-btn" style={{ marginBottom: 12 }} onClick={() => void askClaude("Write a hook title for the opening (3–8 punchy words) based on the transcript, and set it with set_hook. Pick the style that fits.")}>
        <Icon name="sparkle" size={12} /> Write it with Claude
      </button>
      <div className="preset-grid">
        {HOOK_PRESETS.map((p) => (
          <HookCard key={p.id} preset={p.id} hook={h} bg={bg} />
        ))}
      </div>
      <div style={{ height: 10 }} />
      <Slider label="Duration" min={1} max={8} step={0.25} value={h.duration} format={(v) => `${v.toFixed(1)}s`} onCommit={(v) => set({ duration: v })} />
      <Slider label="Position" min={0.08} max={0.92} step={0.01} value={h.position} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set({ position: v })} />
      <Slider label="Size" min={0.03} max={0.12} step={0.0025} value={h.fontSize} format={(v) => `${(v * 100).toFixed(1)}%`} onCommit={(v) => set({ fontSize: v })} />
      <FontSelect family={h.fontFamily} weight={h.fontWeight} onFamily={(f) => set({ fontFamily: f })} onWeight={(w) => set({ fontWeight: w })} />
      <div className="swatch-row" style={{ gridTemplateColumns: "repeat(2, 1fr)" }}>
        <Swatch label="Text" value={h.color} onCommit={(v) => set({ color: v })} />
        <Swatch label="Accent" value={h.accent} onCommit={(v) => set({ accent: v })} />
      </div>
      <label className="toggle-row">
        <span>UPPERCASE</span>
        <input type="checkbox" checked={h.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} />
      </label>
    </div>
  );
}

// ---------------------------------------------------------------- studio sound

export function SoundSection({ project }: { project: Project }) {
  const a = project.audio;
  const bypass = useStore((s) => s.soundBypass);
  const [hearing, setHearing] = useState<"idle" | "rendering" | "playing">("idle");
  const audioEl = useRef<HTMLAudioElement | null>(null);
  const set = (patch: Partial<typeof a>, label = "studio sound") => {
    engine.enableSound(); // runs inside the click, so the browser lets Web Audio start
    edit({ op: "set_audio", ...patch } as Op, label);
  };

  const hear = async () => {
    if (hearing === "playing") {
      audioEl.current?.pause();
      setHearing("idle");
      return;
    }
    engine.pause();
    const t = store.get().time;
    setHearing("rendering");
    const r = await api.audioPreview(t, t + 8);
    if (!r) return setHearing("idle");
    const el = (audioEl.current ??= new Audio());
    el.src = r.url;
    el.onended = () => setHearing("idle");
    try {
      await el.play();
      setHearing("playing");
    } catch {
      setHearing("idle");
    }
  };

  return (
    <div className="section">
      <div className="section-title">Studio sound</div>
      <div className="sound-grid">
        {AUDIO_PRESETS.map((p) => (
          <button key={p.id} className={`sound-card ${a.preset === p.id ? "on" : ""}`} onClick={() => set({ preset: p.id }, `studio sound ${p.name}`)}>
            <span className="sound-name">{p.name}</span>
            <span className="sound-desc">{p.description}</span>
          </button>
        ))}
      </div>
      {a.preset !== "off" && (
        <>
          <Slider label="Strength" min={0} max={1} step={0.05} value={a.strength} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set({ strength: v })} />
          <div className="row" style={{ marginTop: 6 }}>
            <button
              className={`sm grow ${bypass ? "on" : ""}`}
              title="Hold to hear the original"
              onPointerDown={() => store.set({ soundBypass: true })}
              onPointerUp={() => store.set({ soundBypass: false })}
              onPointerLeave={() => bypass && store.set({ soundBypass: false })}
            >
              {bypass ? "Original" : "Hold to compare"}
            </button>
            <button className="sm grow" onClick={() => void hear()} disabled={hearing === "rendering"} title="Render 8 seconds from the playhead with the full export chain, including noise reduction">
              <Icon name={hearing === "playing" ? "pause" : "play"} size={11} /> {hearing === "rendering" ? "Rendering…" : hearing === "playing" ? "Stop" : "Hear it"}
            </button>
          </div>
          <p className="hint" style={{ margin: "8px 0 0" }}>The live preview applies EQ and compression. Noise reduction is added on export; use Hear it to listen to the final result.</p>
        </>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ brand kit

const CORNERS: { id: Watermark["corner"]; label: string }[] = [
  { id: "tl", label: "Top left" },
  { id: "tr", label: "Top right" },
  { id: "bl", label: "Bottom left" },
  { id: "br", label: "Bottom right" },
];

export function BrandSection({ project }: { project: Project }) {
  const brand = useStore((s) => s.brand);
  const logoInput = useRef<HTMLInputElement>(null);
  const fontInput = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(brand?.name ?? "");
  useEffect(() => setName(brand?.name ?? ""), [brand?.name]);
  if (!brand) return null;
  const save = async (patch: Partial<BrandKit>) => {
    const next = await api.saveBrand(patch as Record<string, unknown>);
    if (next) store.set({ brand: next as BrandKit });
  };
  const wm = project.watermark;
  const logoUrl = brand.logo ? `/brand-kit/${encodeURIComponent(brand.logo)}?v=${encodeURIComponent(JSON.stringify(brand).length)}` : null;

  return (
    <div className="section">
      <div className="section-title">Brand kit</div>
      <p className="hint" style={{ margin: "-6px 0 12px" }}>Saved on this computer and reusable in every project.</p>
      <div className="brand-head">
        <button className="brand-logo" onClick={() => logoInput.current?.click()} title="Upload a logo (PNG with transparency works best)">
          {logoUrl ? <img src={logoUrl} alt="Logo" /> : <Icon name="upload" size={16} />}
        </button>
        <div style={{ flex: 1, minWidth: 0 }}>
          <input className="brand-name" value={name} onChange={(e) => setName(e.target.value)} onBlur={() => name !== brand.name && void save({ name })} onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()} />
          <div className="hint">{brand.logo ? "Click the logo to replace it" : "Add your logo"}</div>
        </div>
        <input
          ref={logoInput}
          type="file"
          accept="image/png,image/jpeg,image/webp,image/svg+xml"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f && (await api.uploadBrand("logo", f))) toast("Logo saved to your brand kit");
          }}
        />
      </div>

      <div className="swatch-row" style={{ gridTemplateColumns: "repeat(3, 1fr)" }}>
        <Swatch label="Primary" value={brand.primary} onCommit={(v) => void save({ primary: v })} />
        <Swatch label="Secondary" value={brand.secondary} onCommit={(v) => void save({ secondary: v })} />
        <Swatch label="Text" value={brand.text} onCommit={(v) => void save({ text: v })} />
      </div>

      <div className="row">
        <label>Font</label>
        <select className="grow" value={brand.fontFamily ?? ""} onChange={(e) => (e.target.value === "__upload" ? fontInput.current?.click() : void save({ fontFamily: e.target.value || null }))}>
          <option value="">Keep project font</option>
          {brand.fontFamily && <option value={brand.fontFamily}>{brand.fontFamily}</option>}
          {(store.get().styles?.systemFonts ?? [])
            .filter((f) => f !== brand.fontFamily)
            .map((f) => (
              <option key={f} value={f}>
                {f}
              </option>
            ))}
          <option value="__upload">Upload a font…</option>
        </select>
        <input
          ref={fontInput}
          type="file"
          accept=".ttf,.otf,.woff2"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (f && (await api.uploadBrand("font", f))) toast("Font saved to your brand kit");
          }}
        />
      </div>
      <div className="row">
        <label>Captions</label>
        <select className="grow" value={brand.captionPreset ?? ""} onChange={(e) => void save({ captionPreset: e.target.value || null })}>
          <option value="">Keep project template</option>
          {CAPTION_PRESETS.map((p) => (
            <option key={p.id} value={p.id}>
              {p.name}
            </option>
          ))}
        </select>
      </div>
      <div className="row">
        <label>Look</label>
        <select className="grow" value={brand.look ?? ""} onChange={(e) => void save({ look: e.target.value || null })}>
          <option value="">Keep project look</option>
          {BUILTIN_LOOKS.map((l) => (
            <option key={l.id} value={l.id}>
              {l.name}
            </option>
          ))}
        </select>
      </div>

      <div className="subhead">Logo placement</div>
      <div className="corner-picker">
        {CORNERS.map((c) => (
          <button
            key={c.id}
            className={`corner ${c.id} ${brand.watermark.corner === c.id ? "on" : ""}`}
            title={c.label}
            onClick={() => {
              void save({ watermark: { ...brand.watermark, corner: c.id } });
              if (wm.enabled) edit({ op: "set_watermark", corner: c.id }, "logo position");
            }}
          />
        ))}
      </div>
      <Slider
        label="Size"
        min={0.05}
        max={0.4}
        step={0.01}
        value={brand.watermark.size}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => {
          void save({ watermark: { ...brand.watermark, size: v } });
          if (wm.enabled) edit({ op: "set_watermark", size: v }, "logo size");
        }}
      />
      <Slider
        label="Opacity"
        min={0.1}
        max={1}
        step={0.05}
        value={brand.watermark.opacity}
        format={(v) => `${Math.round(v * 100)}%`}
        onCommit={(v) => {
          void save({ watermark: { ...brand.watermark, opacity: v } });
          if (wm.enabled) edit({ op: "set_watermark", opacity: v }, "logo opacity");
        }}
      />

      <button
        className="primary"
        style={{ width: "100%", height: 34, marginTop: 10 }}
        onClick={async () => {
          const r = await api.applyBrand();
          if (r) toast(`Applied "${brand.name}" to this project`);
        }}
      >
        Apply brand to this project
      </button>
      {wm.file && (
        <label className="toggle-row" style={{ marginTop: 8 }}>
          <span>Show logo in this video</span>
          <input type="checkbox" checked={wm.enabled} onChange={(e) => edit({ op: "set_watermark", enabled: e.target.checked }, e.target.checked ? "logo on" : "logo off")} />
        </label>
      )}
    </div>
  );
}
