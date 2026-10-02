// Style: color looks (LUTs) and the caption studio (templates, fonts, animation, emphasis).
import { useEffect, useMemo, useRef, useState } from "react";
import { CAPTION_PRESETS, drawCaptionFrame, type CaptionPage, type Ctx2D } from "../../../src/core/shared/captions";
import type { Op } from "../../../src/core/shared/ops";
import { DEFAULT_LOOK, type CaptionStyle, type Look, type Project } from "../../../src/core/shared/types";
import { api } from "../api";
import { engine } from "../engine";
import { store, toast, useStore } from "../store";
import { Icon } from "./Icon";
import { BrandSection, HookSection, SoundSection } from "./Polish";

const edit = (op: Op, label?: string) => void api.edit([op], label);

export function StyleTab({ project }: { project: Project }) {
  return (
    <>
      <LookSection project={project} />
      <CaptionSection project={project} />
      <HookSection project={project} />
      <SoundSection project={project} />
      <BrandSection project={project} />
    </>
  );
}

// ----------------------------------------------------------------------- looks

export function useFrameTick() {
  // Re-render thumbnails when the playhead settles somewhere new.
  const time = useStore((s) => (s.playing ? -1 : Math.round(s.time * 2) / 2));
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (time < 0) return;
    const t = setTimeout(() => setTick((n) => n + 1), 350);
    return () => clearTimeout(t);
  }, [time]);
  return tick;
}

function LookSection({ project }: { project: Project }) {
  const styles = useStore((s) => s.styles);
  const look = project.look;
  const tick = useFrameTick();
  const [thumbs, setThumbs] = useState<Record<string, string | null>>({});
  const fileInput = useRef<HTMLInputElement>(null);

  const options = useMemo(() => {
    const builtins = (styles?.looks ?? []).map((l) => ({ id: l.id, name: l.name, hint: l.description }));
    const customs = (styles?.luts ?? []).map((f) => ({ id: `custom:${f}`, name: f.replace(/\.cube$/i, ""), hint: "Custom LUT" }));
    return [{ id: "", name: "None", hint: "Original color" }, ...builtins, ...customs];
  }, [styles]);

  useEffect(() => {
    let live = true;
    const looks: Look[] = options.map((o) => ({ ...DEFAULT_LOOK, lut: o.id || null }));
    void engine.lookThumbs(looks, 132).then((urls) => {
      if (!live) return;
      setThumbs(Object.fromEntries(options.map((o, i) => [o.id, urls[i]])));
    });
    return () => {
      live = false;
    };
  }, [options, tick, project.clips, project.settings.width, project.settings.height]);

  const current = look.lut ?? "";
  return (
    <div className="section">
      <div className="section-title">
        Look
        {!!(look.lut || look.exposure || look.contrast || look.saturation || look.temperature) && (
          <button className="ghost sm" onClick={() => edit({ op: "set_look", ...DEFAULT_LOOK }, "reset look")}>
            Reset
          </button>
        )}
      </div>
      <div className="look-grid">
        {options.map((o) => (
          <button key={o.id} className={`look-card ${current === o.id ? "on" : ""}`} title={o.hint} onClick={() => edit({ op: "set_look", lut: o.id || null, intensity: o.id ? look.intensity || 1 : look.intensity }, `look ${o.name}`)}>
            <span className="look-thumb" style={thumbs[o.id] ? { backgroundImage: `url(${thumbs[o.id]})` } : undefined} />
            <span className="look-name">{o.name}</span>
          </button>
        ))}
        <button className="look-card add" title="Add your own .cube LUT" onClick={() => fileInput.current?.click()}>
          <span className="look-thumb">
            <Icon name="plus" size={16} />
          </span>
          <span className="look-name">Add .cube</span>
        </button>
        <input
          ref={fileInput}
          type="file"
          accept=".cube"
          hidden
          onChange={async (e) => {
            const f = e.target.files?.[0];
            e.target.value = "";
            if (!f) return;
            const r = await api.uploadAsset("luts", f);
            if (r) {
              toast(`Added ${r.file}`);
              edit({ op: "set_look", lut: `custom:${r.file}`, intensity: 1 }, "custom LUT");
            }
          }}
        />
      </div>
      {look.lut && <Slider label="Intensity" min={0} max={1} step={0.01} value={look.intensity} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => edit({ op: "set_look", intensity: v })} />}
      <Slider label="Exposure" min={-1} max={1} step={0.02} value={look.exposure} format={signed} onCommit={(v) => edit({ op: "set_look", exposure: v })} />
      <Slider label="Contrast" min={-1} max={1} step={0.02} value={look.contrast} format={signed} onCommit={(v) => edit({ op: "set_look", contrast: v })} />
      <Slider label="Saturation" min={-1} max={1} step={0.02} value={look.saturation} format={signed} onCommit={(v) => edit({ op: "set_look", saturation: v })} />
      <Slider label="Temperature" min={-1} max={1} step={0.02} value={look.temperature} format={signed} onCommit={(v) => edit({ op: "set_look", temperature: v })} />
    </div>
  );
}

const signed = (v: number) => (Math.abs(v) < 0.005 ? "0" : `${v > 0 ? "+" : ""}${Math.round(v * 100)}`);

// --------------------------------------------------------------------- captions

const SAMPLE: CaptionPage = {
  start: 0,
  end: 3,
  words: [
    { text: "This", start: 0, end: 0.3 },
    { text: "is", start: 0.3, end: 0.5 },
    { text: "the", start: 0.5, end: 0.7 },
    { text: "hook", start: 0.7, end: 1.2 },
  ],
};

function PresetCard({ id, name, base, active, bg }: { id: string; name: string; base: CaptionStyle; active: boolean; bg: string | null }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const preset = CAPTION_PRESETS.find((p) => p.id === id)!;
  useEffect(() => {
    const c = ref.current!;
    const draw = () => {
      const dpr = window.devicePixelRatio || 1;
      const w = c.clientWidth * dpr;
      const h = c.clientHeight * dpr;
      c.width = w;
      c.height = h;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, w, h);
      // Scale each template's relative size up to the small card, keeping their proportions.
      const rel = (preset.style.fontSize ?? 0.055) / 0.055;
      const style: CaptionStyle = { ...base, ...preset.style, emphasisWords: ["hook"], position: 0.52, fontSize: Math.min(0.3, 0.19 * rel) };
      const page = style.maxWords < SAMPLE.words.length ? { ...SAMPLE, words: SAMPLE.words.slice(-Math.max(1, style.maxWords)) } : SAMPLE;
      drawCaptionFrame(ctx as unknown as Ctx2D, w, h, page, style, 0.9);
    };
    draw();
    window.addEventListener("cutroom:font", draw);
    return () => window.removeEventListener("cutroom:font", draw);
  }, [base, preset]);
  return (
    <button className={`preset-card ${active ? "on" : ""}`} onClick={() => edit({ op: "set_captions", preset: id as never, enabled: true }, `captions: ${name}`)} title={name}>
      <span className="preset-stage" style={bg ? { backgroundImage: `url(${bg})` } : undefined}>
        <canvas ref={ref} />
      </span>
      <span className="look-name">{name}</span>
    </button>
  );
}

function CaptionSection({ project }: { project: Project }) {
  const c = project.captions;
  const hasTranscript = useStore((s) => Object.keys(s.transcripts).length > 0);
  const tick = useFrameTick();
  const [bg, setBg] = useState<string | null>(null);
  const set = (patch: Partial<CaptionStyle>, label = "caption style") => edit({ op: "set_captions", ...patch } as Op, label);
  const aspect = project.settings.width / project.settings.height;

  useEffect(() => {
    let live = true;
    void engine.lookThumbs([project.look], 200).then(([url]) => live && setBg(url));
    return () => {
      live = false;
    };
  }, [tick, project.look, project.clips]);


  return (
    <div className="section">
      <div className="section-title">
        Captions
        <input type="checkbox" checked={c.enabled} onChange={(e) => set({ enabled: e.target.checked }, e.target.checked ? "captions on" : "captions off")} title="Burn captions into the video" />
      </div>
      {!hasTranscript && <p className="hint">Captions come from the transcript. Transcribe a recording first.</p>}
      <div className={`preset-grid ${aspect > 1 ? "wide" : ""}`}>
        {CAPTION_PRESETS.map((p) => (
          <PresetCard key={p.id} id={p.id} name={p.name} base={c} active={c.enabled && c.preset === p.id} bg={bg} />
        ))}
      </div>

      <div className="subhead">Font</div>
      <FontSelect
        family={c.fontFamily}
        weight={c.fontWeight}
        onFamily={(f) => set({ fontFamily: f }, `font ${f.split(",")[0]}`)}
        onWeight={(w) => set({ fontWeight: w })}
      />
      <Slider label="Size" min={0.025} max={0.12} step={0.0025} value={c.fontSize} format={(v) => `${(v * 100).toFixed(1)}%`} onCommit={(v) => set({ fontSize: v })} />
      <Slider label="Position" min={0.1} max={0.95} step={0.01} value={c.position} format={(v) => `${Math.round(v * 100)}%`} onCommit={(v) => set({ position: v })} />
      <Slider label="Words / line" min={1} max={10} step={1} value={c.maxWords} format={(v) => String(v)} onCommit={(v) => set({ maxWords: v })} />

      <div className="subhead">Motion</div>
      <div className="chip-row">
        {(["none", "pop", "bounce", "fade", "rise", "reveal"] as const).map((a) => (
          <button key={a} className={`pill ${c.animation === a ? "on" : ""}`} onClick={() => set({ animation: a })}>
            {a === "reveal" ? "Typewriter" : a[0].toUpperCase() + a.slice(1)}
          </button>
        ))}
      </div>
      <div className="subhead">Active word</div>
      <div className="chip-row">
        <button className={`pill ${!c.highlight ? "on" : ""}`} onClick={() => set({ highlight: false })}>
          Off
        </button>
        {(["color", "box", "scale", "underline"] as const).map((h) => (
          <button key={h} className={`pill ${c.highlight && c.highlightStyle === h ? "on" : ""}`} onClick={() => set({ highlight: true, highlightStyle: h })}>
            {h[0].toUpperCase() + h.slice(1)}
          </button>
        ))}
      </div>

      <div className="subhead">Color</div>
      <div className="swatch-row">
        <Swatch label="Text" value={c.color} onCommit={(v) => set({ color: v })} />
        <Swatch label={c.highlightStyle === "box" ? "Box" : "Active"} value={c.highlightStyle === "box" ? c.boxColor : c.highlightColor} onCommit={(v) => set(c.highlightStyle === "box" ? { boxColor: v } : { highlightColor: v })} />
        <Swatch label="Emphasis" value={c.emphasisColor} onCommit={(v) => set({ emphasisColor: v })} />
        <Swatch label="Outline" value={c.strokeColor} onCommit={(v) => set({ strokeColor: v })} />
      </div>
      <Slider label="Outline" min={0} max={0.3} step={0.01} value={c.strokeWidth} format={(v) => v.toFixed(2)} onCommit={(v) => set({ strokeWidth: v })} />
      <label className="toggle-row">
        <span>Glow</span>
        <input type="checkbox" checked={!!c.glow} onChange={(e) => set({ glow: e.target.checked ? "rgba(0,0,0,0.7)" : null })} />
      </label>
      <label className="toggle-row">
        <span>Background box</span>
        <input type="checkbox" checked={!!c.background} onChange={(e) => set({ background: e.target.checked ? "rgba(0,0,0,0.7)" : null })} />
      </label>
      <label className="toggle-row">
        <span>UPPERCASE</span>
        <input type="checkbox" checked={c.uppercase} onChange={(e) => set({ uppercase: e.target.checked })} />
      </label>

      <div className="subhead">Emphasis words</div>
      <EmphasisInput words={c.emphasisWords} onCommit={(w) => set({ emphasisWords: w }, "emphasis words")} />
      <button
        className="sm agent-btn"
        onClick={async () => {
          const fb = await api.addFeedback({
            note: "Pick the emphasis words for the captions: the key terms, numbers and punchlines (about one every few seconds). Set them with set_captions emphasisWords.",
            time: { start: 0, end: null },
          });
          if (fb) {
            toast(`Asked Claude (note #${fb.n})`, "agent");
            store.set({ rightTab: "feedback" });
          }
        }}
      >
        <Icon name="sparkle" size={12} /> Ask Claude to pick them
      </button>
    </div>
  );
}

/** Font family + weight picker: project fonts, popular and all installed fonts, plus upload. */
export function FontSelect({ family, weight, onFamily, onWeight }: { family: string; weight: number; onFamily: (f: string) => void; onWeight: (w: number) => void }) {
  const styles = useStore((s) => s.styles);
  const brand = useStore((s) => s.brand);
  const input = useRef<HTMLInputElement>(null);
  const opts = useMemo(() => {
    const sys = styles?.systemFonts ?? [];
    const popular = ["Helvetica Neue", "Arial Black", "Avenir Next", "Futura", "Montserrat", "Inter", "Poppins", "Bebas Neue", "Impact", "Georgia", "Comic Sans MS", "Menlo"].filter((f) => sys.includes(f));
    return { custom: styles?.fonts ?? [], popular, rest: sys.filter((f) => !popular.includes(f)) };
  }, [styles]);
  const current = family.split(",")[0].trim();
  const known = opts.popular.includes(current) || opts.custom.some((f) => f.family === current) || opts.rest.includes(current) || brand?.fontFamily === current;
  const full = (f: string) => `${f}, Helvetica Neue, Arial, sans-serif`;
  return (
    <div className="row">
      <select
        className="grow"
        value={current}
        onChange={(e) => {
          const f = e.target.value;
          if (f === "__upload") return input.current?.click();
          onFamily(full(f));
        }}
      >
        {!known && <option value={current}>{current}</option>}
        {brand?.fontFamily && (
          <optgroup label="Brand">
            <option value={brand.fontFamily}>{brand.fontFamily}</option>
          </optgroup>
        )}
        {opts.custom.length > 0 && (
          <optgroup label="Project fonts">
            {opts.custom.map((f) => (
              <option key={f.file} value={f.family}>
                {f.family}
              </option>
            ))}
          </optgroup>
        )}
        <optgroup label="Popular">
          {opts.popular.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </optgroup>
        <optgroup label="All installed">
          {opts.rest.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </optgroup>
        <option value="__upload">Upload a font…</option>
      </select>
      <select value={weight} onChange={(e) => onWeight(Number(e.target.value))} title="Weight" style={{ width: 76 }}>
        {[400, 500, 600, 700, 800, 900].map((w) => (
          <option key={w} value={w}>
            {w}
          </option>
        ))}
      </select>
      <button className="sm icon" title="Upload a .ttf, .otf or .woff2 font" onClick={() => input.current?.click()}>
        <Icon name="upload" size={13} />
      </button>
      <input
        ref={input}
        type="file"
        accept=".ttf,.otf,.woff2"
        hidden
        onChange={async (e) => {
          const f = e.target.files?.[0];
          e.target.value = "";
          if (!f) return;
          const r = await api.uploadAsset("fonts", f);
          if (r?.family) {
            toast(`Added font ${r.family}`);
            onFamily(full(r.family));
          }
        }}
      />
    </div>
  );
}

function EmphasisInput({ words, onCommit }: { words: string[]; onCommit: (w: string[]) => void }) {
  const [text, setText] = useState(words.join(", "));
  useEffect(() => setText(words.join(", ")), [words]);
  const commit = () => {
    const next = text.split(/[,\n]/).map((w) => w.trim()).filter(Boolean);
    if (next.join("|") !== words.join("|")) onCommit(next);
  };
  return <input className="emphasis-input" placeholder="money, 10x, secret" value={text} onChange={(e) => setText(e.target.value)} onBlur={commit} onKeyDown={(e) => e.key === "Enter" && commit()} />;
}

export function Swatch({ label, value, onCommit }: { label: string; value: string; onCommit: (v: string) => void }) {
  const ref = useRef<HTMLInputElement>(null);
  const [local, setLocal] = useState(toHex(value));
  const commit = useRef(onCommit);
  commit.current = (v) => v !== toHex(value) && onCommit(v);
  useEffect(() => setLocal(toHex(value)), [value]);
  useEffect(() => {
    const el = ref.current!;
    const fn = () => commit.current(el.value);
    el.addEventListener("change", fn);
    return () => el.removeEventListener("change", fn);
  }, []);
  return (
    <label className="swatch" title={label}>
      <span className="swatch-chip" style={{ background: local }} />
      <span>{label}</span>
      <input ref={ref} type="color" value={local} onChange={(e) => setLocal(e.target.value)} />
    </label>
  );
}

function toHex(c: string): string {
  if (/^#[0-9a-f]{6}$/i.test(c)) return c;
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(c);
  return m ? "#" + m.slice(1, 4).map((n) => Number(n).toString(16).padStart(2, "0")).join("") : "#ffffff";
}

export function Slider({ label, min, max, step, value, format, onCommit }: { label: string; min: number; max: number; step: number; value: number; format: (v: number) => string; onCommit: (v: number) => void }) {
  const [local, setLocal] = useState(value);
  useEffect(() => setLocal(value), [value]);
  const commit = () => local !== value && onCommit(local);
  return (
    <div className="row">
      <label>{label}</label>
      <input className="grow" type="range" min={min} max={max} step={step} value={local} onChange={(e) => setLocal(Number(e.target.value))} onPointerUp={commit} onKeyUp={commit} onBlur={commit} onDoubleClick={() => (min < 0 ? onCommit(0) : undefined)} />
      <span className="val">{format(local)}</span>
    </div>
  );
}
