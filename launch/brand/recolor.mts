// Colour studies for the cutroom app icon: the same glyph, light and grain, through other palettes.
// Each pixel's brightness is mapped through a five-stop ramp (ink → deep → mid → light → bloom), so
// the shading, the rim light and the grain survive; the thin accent line gets its own colour.
// Usage: npx tsx launch/brand/recolor.mts <icon.png>  ->  launch/out/brand/palette-<name>.png + palettes.png
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { createCanvas, GlobalFonts, loadImage, type Canvas } from "@napi-rs/canvas";

const OUT = "launch/out/brand";
const src = await loadImage(process.argv[2] ?? join(OUT, "codex-1.png"));
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");

type Palette = { name: string; ramp: [string, string, string, string, string]; accent: string };
const PALETTES: Palette[] = [
  { name: "Coral (as is)", ramp: ["#140b0e", "#e2372f", "#ff5f4f", "#ffb39a", "#fff4ec"], accent: "#e8f47c" },
  { name: "Cobalt", ramp: ["#0a1020", "#1d4ed8", "#4f86ff", "#a9c8ff", "#f2f6ff"], accent: "#e8f47c" },
  { name: "Ultraviolet", ramp: ["#120a1f", "#5b2bd9", "#8b5cff", "#cbb6ff", "#f7f2ff"], accent: "#e8f47c" },
  { name: "Lime", ramp: ["#0f140a", "#86a816", "#c4e43f", "#e7f6a2", "#fbffe9"], accent: "#ff5f4f" },
  { name: "Amber", ramp: ["#1a0f08", "#df5e0c", "#ff982b", "#ffd08a", "#fff6e6"], accent: "#8ef3e6" },
  { name: "Teal", ramp: ["#071413", "#0b8a81", "#27c2b3", "#9fe8df", "#f0fffd"], accent: "#ff6b57" },
  { name: "Graphite", ramp: ["#0b0b0c", "#45454a", "#85858b", "#cdcdd2", "#ffffff"], accent: "#ff5f4f" },
  { name: "Magenta", ramp: ["#170914", "#c0185a", "#ff4f98", "#ffb3d3", "#fff0f6"], accent: "#e8f47c" },
  { name: "Terracotta", ramp: ["#1a0f0b", "#b0502b", "#d97757", "#f2b89a", "#fdf3ea"], accent: "#e8f47c" },
];
// where each ramp stop sits in the original's brightness (measured: ink ~0.07, deep coral ~0.35,
// coral ~0.50, peach ~0.75, the bloom ~0.97)
const STOPS = [0.06, 0.34, 0.5, 0.74, 0.97];
const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16));

function recolor(p: Palette): Canvas {
  const c = createCanvas(src.width, src.height), x = c.getContext("2d");
  x.drawImage(src, 0, 0);
  const img = x.getImageData(0, 0, src.width, src.height), d = img.data;
  const ramp = p.ramp.map(hex), acc = hex(p.accent);
  const at = (L: number) => {
    if (L <= STOPS[0]) return ramp[0];
    for (let k = 1; k < STOPS.length; k++) {
      if (L <= STOPS[k]) {
        const u = (L - STOPS[k - 1]) / (STOPS[k] - STOPS[k - 1]);
        return ramp[k - 1].map((v, j) => v + (ramp[k][j] - v) * u);
      }
    }
    return ramp[STOPS.length - 1];
  };
  for (let i = 0; i < d.length; i += 4) {
    const r = d[i] / 255, g = d[i + 1] / 255, b = d[i + 2] / 255;
    const L = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    const base = at(L);
    // the lime line and its glow: green clearly above red and blue
    const lime = Math.max(0, Math.min(1, (g - Math.max(r * 0.92, b * 1.5)) * 6));
    const glowL = Math.min(1, L * 1.15);
    for (let j = 0; j < 3; j++) d[i + j] = base[j] * (1 - lime) + acc[j] * glowL * lime + 255 * Math.max(0, glowL - 0.85) * lime;
  }
  x.putImageData(img, 0, 0);
  return c;
}

const cols = 3, cell = 620, W = cols * cell, rows = Math.ceil(PALETTES.length / cols), H = rows * cell + 40;
const sheet = createCanvas(W, H), sx = sheet.getContext("2d");
sx.fillStyle = "#0c0c0d";
sx.fillRect(0, 0, W, H);
PALETTES.forEach((p, k) => {
  const c = recolor(p);
  writeFileSync(join(OUT, `palette-${p.name.split(" ")[0].toLowerCase()}.png`), c.toBuffer("image/png"));
  const cx = (k % cols) * cell, cy = 20 + Math.floor(k / cols) * cell;
  sx.drawImage(c, cx + 40, cy + 10, 400, 400);
  // small sizes, on dark then on light
  sx.drawImage(c, cx + 460, cy + 40, 128, 128);
  sx.drawImage(c, cx + 460, cy + 190, 64, 64);
  sx.drawImage(c, cx + 540, cy + 200, 32, 32);
  sx.fillStyle = "#ecebe8";
  sx.fillRect(cx + 450, cy + 280, 150, 130);
  sx.drawImage(c, cx + 462, cy + 300, 64, 64);
  sx.drawImage(c, cx + 540, cy + 316, 32, 32);
  sx.fillStyle = "#f4f2ef";
  sx.font = "600 34px SF";
  sx.fillText(`${k + 1} · ${p.name}`, cx + 44, cy + 470);
});
writeFileSync(join(OUT, "palettes.png"), sheet.toBuffer("image/png"));
console.log(join(OUT, "palettes.png"));
