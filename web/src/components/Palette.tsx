// Command palette (⌘K): every action by name, plus "Ask Claude" for anything else.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Op } from "../../../src/core/shared/ops";
import { addZoomHere, openComposer, splitAtPlayhead, toggleAnnotate } from "../actions";
import { api } from "../api";
import { engine } from "../engine";
import { store, toast, useStore } from "../store";
import { Icon } from "./Icon";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: string;
  keys?: string;
  run: () => void | Promise<void>;
}

const edit = (ops: Op[], label?: string) => void api.edit(ops, label);
const panel = (rightTab: "feedback" | "edit" | "style" | "output") => store.set({ rightTab, rightOpen: true, inspectorOpen: true });

function commands(): Command[] {
  return [
    { id: "fillers", label: "Remove filler words", icon: "wand", run: () => edit([{ op: "remove_fillers" }]) },
    { id: "pauses", label: "Tighten pauses", icon: "compress", run: () => edit([{ op: "remove_silences" }]) },
    { id: "jumpcuts", label: "Hide jump cuts", hint: "Alternate framing at each cut", icon: "zoom", run: () => edit([{ op: "jump_cut_zoom" }], "hide jump cuts") },
    {
      id: "takes",
      label: "Keep the best takes",
      hint: "Cut repeated attempts",
      icon: "refresh",
      run: async () => {
        const groups = await fetch("/api/retakes").then((r) => r.json());
        for (const g of groups) await fetch("/api/retakes/use", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id: g.id, take: g.best }) });
        toast(groups.length ? `Kept the best take in ${groups.length} place${groups.length === 1 ? "" : "s"}` : "No retakes found");
      },
    },
    { id: "split", label: "Split at playhead", icon: "split", keys: "S", run: splitAtPlayhead },
    { id: "zoom", label: "Punch-in zoom here", icon: "zoom", keys: "Z", run: () => addZoomHere() },
    { id: "annotate", label: "Annotate the frame", icon: "pin", keys: "A", run: () => toggleAnnotate(true) },
    { id: "note", label: "Leave a note for Claude", icon: "message", keys: "C", run: () => openComposer() },
    { id: "vertical", label: "Make it vertical (9:16)", icon: "film", run: () => edit([{ op: "set_settings", aspect: "9:16" }], "aspect 9:16") },
    { id: "landscape", label: "Make it landscape (16:9)", icon: "film", run: () => edit([{ op: "set_settings", aspect: "16:9" }], "aspect 16:9") },
    { id: "square", label: "Make it square (1:1)", icon: "film", run: () => edit([{ op: "set_settings", aspect: "1:1" }], "aspect 1:1") },
    { id: "captions-on", label: "Turn captions on", icon: "captions", run: () => edit([{ op: "set_captions", enabled: true }]) },
    { id: "captions-off", label: "Turn captions off", icon: "captions", run: () => edit([{ op: "set_captions", enabled: false }]) },
    { id: "cap-pop", label: "Captions: Pop template", icon: "captions", run: () => edit([{ op: "set_captions", preset: "pop" }]) },
    { id: "cap-karaoke", label: "Captions: Karaoke template", icon: "captions", run: () => edit([{ op: "set_captions", preset: "karaoke" }]) },
    { id: "cap-bold", label: "Captions: One word template", icon: "captions", run: () => edit([{ op: "set_captions", preset: "bold" }]) },
    { id: "sound", label: "Studio sound: Podcast", icon: "audio", run: () => edit([{ op: "set_audio", preset: "podcast" }]) },
    { id: "look-warm", label: "Look: Warm", icon: "cube", run: () => edit([{ op: "set_look", lut: "warm" }]) },
    { id: "look-cine", label: "Look: Teal & Orange", icon: "cube", run: () => edit([{ op: "set_look", lut: "teal-orange" }]) },
    { id: "brand", label: "Apply my brand kit", icon: "sparkle", run: () => void api.applyBrand().then((r) => r && toast("Brand applied")) },
    { id: "hook", label: "Edit the hook title", icon: "type", run: () => panel("style") },
    { id: "style", label: "Open Style (looks, captions, sound, brand)", icon: "cube", run: () => panel("style") },
    { id: "export", label: "Export video", icon: "download", run: () => panel("output") },
    { id: "undo", label: "Undo", icon: "undo", keys: "⌘Z", run: () => void api.undo() },
    { id: "redo", label: "Redo", icon: "redo", keys: "⇧⌘Z", run: () => void api.redo() },
    { id: "play", label: "Play / pause", icon: "play", keys: "Space", run: () => engine.toggle() },
  ];
}

function score(label: string, q: string): number {
  const l = label.toLowerCase();
  const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
  if (!terms.length) return 1;
  let s = 0;
  for (const t of terms) {
    const i = l.indexOf(t);
    if (i < 0) return 0;
    s += i === 0 || l[i - 1] === " " ? 3 : 1;
  }
  return s;
}

export function Palette() {
  const open = useStore((s) => s.paletteOpen);
  const [q, setQ] = useState("");
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const all = useMemo(commands, []);

  useEffect(() => {
    if (open) {
      setQ("");
      setSel(0);
      input.current?.focus();
    }
  }, [open]);

  const results = useMemo(() => {
    const matches = all
      .map((c) => ({ c, s: score(c.label + " " + (c.hint ?? ""), q) }))
      .filter((x) => x.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((x) => x.c);
    const ask: Command | null = q.trim()
      ? {
          id: "ask",
          label: `Ask Claude: “${q.trim()}”`,
          hint: "Sends a note to the connected agent",
          icon: "sparkle",
          run: async () => {
            const s = store.get();
            const fb = await api.addFeedback({ note: q.trim(), time: s.range ? { start: s.range.start, end: s.range.end } : { start: s.time, end: null } });
            if (fb) {
              toast(`Sent to Claude (note #${fb.n})`, "agent");
              panel("feedback");
            }
          },
        }
      : null;
    // Free text that matches nothing is most likely an instruction for Claude.
    return ask ? (matches.length ? [...matches.slice(0, 7), ask] : [ask]) : matches.slice(0, 9);
  }, [all, q]);

  if (!open) return null;
  const close = () => store.set({ paletteOpen: false });
  const run = (c: Command) => {
    close();
    void c.run();
  };

  return (
    <div className="palette-backdrop" onMouseDown={close}>
      <div className="palette" onMouseDown={(e) => e.stopPropagation()} role="dialog" aria-label="Command palette">
        <div className="palette-input">
          <Icon name="search" size={16} />
          <input
            ref={input}
            autoFocus
            value={q}
            placeholder="Search actions, or tell Claude what to change…"
            onChange={(e) => {
              setQ(e.target.value);
              setSel(0);
            }}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") close();
              else if (e.key === "ArrowDown") {
                e.preventDefault();
                setSel((n) => Math.min(results.length - 1, n + 1));
              } else if (e.key === "ArrowUp") {
                e.preventDefault();
                setSel((n) => Math.max(0, n - 1));
              } else if (e.key === "Enter" && results[sel]) run(results[sel]);
            }}
          />
          <kbd>esc</kbd>
        </div>
        <div className="palette-list" role="listbox">
          {results.map((c, i) => (
            <button key={c.id} role="option" aria-selected={i === sel} className={`palette-item ${i === sel ? "sel" : ""} ${c.id === "ask" ? "ask" : ""}`} onMouseEnter={() => setSel(i)} onClick={() => run(c)}>
              <span className="palette-ico">
                <Icon name={c.icon} size={14} />
              </span>
              <span className="palette-label">
                {c.label}
                {c.hint && <span className="palette-hint">{c.hint}</span>}
              </span>
              {c.keys && <kbd>{c.keys}</kbd>}
            </button>
          ))}
          {!results.length && <p className="hint" style={{ padding: 14 }}>Type to search actions.</p>}
        </div>
      </div>
    </div>
  );
}
