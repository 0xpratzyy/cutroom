// Studio sound preview with Web Audio: the same EQ/compression numbers as the export
// (audioParams), applied live. Noise reduction is export-only ("Hear it" renders it).
import { audioParams } from "../../src/core/shared/audio";
import type { AudioEnhance } from "../../src/core/shared/types";

export class AudioFx {
  private ctx: AudioContext | null = null;
  private nodes: { hp: BiquadFilterNode; low: BiquadFilterNode; mid: BiquadFilterNode; high: BiquadFilterNode; comp: DynamicsCompressorNode; gain: GainNode } | null = null;
  private analyser: AnalyserNode | null = null;
  private buf = new Float32Array(1024);
  private settings: AudioEnhance = { preset: "off", strength: 0.6 };
  private bypass = false;

  constructor(private elements: HTMLMediaElement[]) {}

  /** Build the graph. Must run inside a user gesture (browsers keep audio suspended otherwise). */
  ensure() {
    if (this.ctx) {
      if (this.ctx.state === "suspended") void this.ctx.resume();
      return;
    }
    let ctx: AudioContext;
    try {
      ctx = new AudioContext();
    } catch {
      return;
    }
    const hp = ctx.createBiquadFilter();
    hp.type = "highpass";
    const low = ctx.createBiquadFilter();
    low.type = "lowshelf";
    const mid = ctx.createBiquadFilter();
    mid.type = "peaking";
    const high = ctx.createBiquadFilter();
    high.type = "highshelf";
    const comp = ctx.createDynamicsCompressor();
    const gain = ctx.createGain();
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 1024;
    hp.connect(low).connect(mid).connect(high).connect(comp).connect(gain).connect(analyser).connect(ctx.destination);
    this.analyser = analyser;
    for (const el of this.elements) ctx.createMediaElementSource(el).connect(hp);
    this.ctx = ctx;
    this.nodes = { hp, low, mid, high, comp, gain };
    this.apply();
  }

  /** Current output level in dBFS (peak), or -Infinity when silent / not running. */
  level(): number {
    if (!this.analyser) return -Infinity;
    this.analyser.getFloatTimeDomainData(this.buf);
    let peak = 0;
    for (const v of this.buf) peak = Math.max(peak, Math.abs(v));
    return peak > 0 ? 20 * Math.log10(peak) : -Infinity;
  }

  set(settings: AudioEnhance, bypass: boolean) {
    this.settings = settings;
    this.bypass = bypass;
    this.apply();
  }

  private apply() {
    const n = this.nodes;
    if (!n || !this.ctx) return;
    const p = this.bypass ? null : audioParams(this.settings);
    const t = this.ctx.currentTime;
    n.hp.frequency.setTargetAtTime(p ? p.highpass : 10, t, 0.02);
    n.low.frequency.value = p?.lowShelf.f ?? 150;
    n.low.gain.setTargetAtTime(p?.lowShelf.g ?? 0, t, 0.02);
    n.mid.frequency.value = p?.presence.f ?? 3000;
    n.mid.Q.value = p?.presence.q ?? 0.9;
    n.mid.gain.setTargetAtTime(p?.presence.g ?? 0, t, 0.02);
    n.high.frequency.value = p?.highShelf.f ?? 9000;
    n.high.gain.setTargetAtTime(p?.highShelf.g ?? 0, t, 0.02);
    n.comp.threshold.setTargetAtTime(p ? p.comp.threshold : 0, t, 0.02);
    n.comp.ratio.setTargetAtTime(p ? p.comp.ratio : 1, t, 0.02);
    n.comp.attack.value = (p?.comp.attack ?? 8) / 1000;
    n.comp.release.value = (p?.comp.release ?? 120) / 1000;
    n.gain.gain.setTargetAtTime(p ? Math.pow(10, p.comp.makeup / 20) : 1, t, 0.02);
  }
}
