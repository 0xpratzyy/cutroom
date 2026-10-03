// Writes cutroom's brand assets from one app icon: the icon at every size, the favicons (PNG and SVG),
// the editor's title-bar and touch icons, the flat mark, the README banner and the wordmark.
// Usage: npx tsx launch/brand/brand.mts <icon-1024.png>
//   e.g. after recolor.mts: npx tsx launch/brand/brand.mts launch/out/brand/palette-ultraviolet.png
import { copyFileSync, writeFileSync } from "node:fs";
import { createCanvas, GlobalFonts, loadImage, Path2D, type Canvas, type Image, type SKRSContext2D } from "@napi-rs/canvas";

const SRC = process.argv[2];
if (!SRC) throw new Error("usage: npx tsx launch/brand/brand.mts <icon-1024.png>");
GlobalFonts.registerFromPath("/System/Library/Fonts/SFNS.ttf", "SF");
const icon = await loadImage(SRC);

// the palette (Ultraviolet): ground light → deep, the glyph's ink, the lime cut
const C = { bloom: "#f7f2ff", light: "#cbb6ff", mid: "#8b5cff", deep: "#5b2bd9", ink: "#120a1f", lime: "#e8f47c", bone: "#f4f2ef", soft: "#a8a49e" };

/** Downscale in halving steps, so small sizes stay crisp instead of aliasing. */
function resized(img: Image | Canvas, size: number): Canvas {
  let cur: Image | Canvas = img, w = img.width;
  while (w / 2 >= size) {
    const c = createCanvas(Math.round(w / 2), Math.round(w / 2)), x = c.getContext("2d");
    x.imageSmoothingQuality = "high";
    x.drawImage(cur, 0, 0, c.width, c.height);
    cur = c;
    w = c.width;
  }
  const out = createCanvas(size, size), x = out.getContext("2d");
  x.imageSmoothingQuality = "high";
  x.drawImage(cur, 0, 0, size, size);
  return out;
}
const png = (file: string, c: Canvas) => (writeFileSync(file, c.toBuffer("image/png")), console.log("wrote", file));

copyFileSync(SRC, "assets/brand/icon-1024.png");
for (const s of [512, 256, 128, 64]) png(`assets/brand/icon-${s}.png`, resized(icon, s));
png("assets/brand/favicon-180.png", resized(icon, 180));
png("assets/brand/favicon-32.png", resized(icon, 32));
png("web/public/icon-128.png", resized(icon, 128));
png("web/public/apple-touch-icon.png", resized(icon, 180));

// The mark's geometry (a 512 box): the pin's head at (256, 232), r 150, its point at (256, 452); the
// counter r 66; the cut is the wedge between -45° and 0°; the lime edge along the -45° side.
const PIN = "M146.3 334.3A150 150 0 1 1 365.7 334.3L256 452Z";
const MASK = `<mask id="cut"><rect x="-200" y="-200" width="912" height="912" fill="#fff"/><circle cx="256" cy="232" r="66" fill="#000"/><polygon points="256,232 560,-72 700,232" fill="#000"/></mask>`;
const LIME_LINE = (w: number) => `<line x1="304" y1="184" x2="362.6" y2="125.4" stroke="${C.lime}" stroke-width="${w}" stroke-linecap="round"/>`;
// favicon: the app icon in vector: a luminous tile with the glyph oversized and cropped by its edge
const favicon = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="bg" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="${C.bloom}"/>
      <stop offset="0.42" stop-color="${C.mid}"/>
      <stop offset="1" stop-color="${C.deep}"/>
    </linearGradient>
    <clipPath id="tile"><rect width="512" height="512" rx="114"/></clipPath>
    ${MASK}
  </defs>
  <g clip-path="url(#tile)">
    <rect width="512" height="512" fill="url(#bg)"/>
    <g transform="translate(-92.8 -86.6) scale(1.3)">
      <path d="${PIN}" fill="${C.ink}" mask="url(#cut)"/>
      ${LIME_LINE(9)}
    </g>
  </g>
</svg>
`;
writeFileSync("assets/brand/favicon.svg", favicon);
writeFileSync("web/public/favicon.svg", favicon);
// the flat mark, for anywhere the tile doesn't fit
const mark = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 512">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="0" y2="1">
      <stop offset="0" stop-color="${C.light}"/>
      <stop offset="1" stop-color="${C.deep}"/>
    </linearGradient>
    ${MASK}
  </defs>
  <path d="${PIN}" fill="url(#g)" mask="url(#cut)"/>
  ${LIME_LINE(7)}
</svg>
`;
writeFileSync("assets/brand/mark.svg", mark);
console.log("wrote favicon.svg (assets/brand, web/public) and mark.svg");

/** The flat mark on a canvas, `size` px across its 512 box, top-left at (px, py). */
function drawMark(x: SKRSContext2D, px: number, py: number, size: number) {
  const k = size / 512;
  x.save();
  x.translate(px, py);
  x.scale(k, k);
  const hole = new Path2D();
  hole.rect(-200, -200, 912, 912);
  hole.moveTo(256 + 66, 232);
  hole.arc(256, 232, 66, 0, Math.PI * 1.75, false);
  hole.lineTo(560, -72);
  hole.lineTo(700, 232);
  hole.closePath();
  x.save();
  x.clip(hole, "evenodd");
  const g = x.createLinearGradient(0, 82, 0, 452);
  g.addColorStop(0, C.light);
  g.addColorStop(1, C.deep);
  x.fillStyle = g;
  x.fill(new Path2D(PIN));
  x.restore();
  x.strokeStyle = C.lime;
  x.lineWidth = 7;
  x.lineCap = "round";
  x.beginPath();
  x.moveTo(304, 184);
  x.lineTo(362.6, 125.4);
  x.stroke();
  x.restore();
}

// README banner, 1280×640: the icon on a dark ground with a violet glow, the wordmark, the line
{
  const W = 1280, H = 640, cv = createCanvas(W, H), x = cv.getContext("2d") as SKRSContext2D;
  x.fillStyle = "#0b0a0e";
  x.fillRect(0, 0, W, H);
  const glow = x.createRadialGradient(260, 320, 0, 260, 320, 620);
  glow.addColorStop(0, "rgba(139,92,255,0.30)");
  glow.addColorStop(1, "rgba(139,92,255,0)");
  x.fillStyle = glow;
  x.fillRect(0, 0, W, H);
  const glow2 = x.createRadialGradient(1120, 120, 0, 1120, 120, 520);
  glow2.addColorStop(0, "rgba(232,244,124,0.06)");
  glow2.addColorStop(1, "rgba(232,244,124,0)");
  x.fillStyle = glow2;
  x.fillRect(0, 0, W, H);
  // a faint grid, like a crop overlay
  x.strokeStyle = "rgba(255,255,255,0.045)";
  x.lineWidth = 1;
  for (const gx of [W / 3, (2 * W) / 3]) (x.beginPath(), x.moveTo(gx, 0), x.lineTo(gx, H), x.stroke());
  for (const gy of [H / 3, (2 * H) / 3]) (x.beginPath(), x.moveTo(0, gy), x.lineTo(W, gy), x.stroke());
  x.drawImage(icon, 80, 140, 360, 360);
  x.fillStyle = C.bone;
  x.font = "700 150px SF";
  (x as unknown as { letterSpacing: string }).letterSpacing = "-4px";
  x.fillText("cutroom", 470, 318);
  (x as unknown as { letterSpacing: string }).letterSpacing = "0px";
  x.fillStyle = C.lime;
  x.font = "500 50px SF";
  x.fillText("Point at it. Claude fixes it.", 476, 392);
  x.fillStyle = C.soft;
  x.font = "400 29px SF";
  x.fillText("Open-source video editor built for AI agents · MCP · local-first", 478, 444);
  png("assets/brand/banner.png", cv);
}
// wordmark for dark backgrounds, 1200×300, transparent: the flat mark and the name
{
  const cv = createCanvas(1200, 300), x = cv.getContext("2d") as SKRSContext2D;
  drawMark(x, 40, 22, 256);
  x.fillStyle = C.bone;
  x.font = "700 170px SF";
  (x as unknown as { letterSpacing: string }).letterSpacing = "-5px";
  x.fillText("cutroom", 300, 212);
  png("assets/brand/wordmark-dark-bg.png", cv);
}
