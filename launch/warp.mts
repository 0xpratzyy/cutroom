// Fake 3D for a 2D canvas: project a rectangle through a simple pinhole camera and draw an
// image onto the resulting quad (perspective-correct via a homography, rendered as a grid of
// affine-mapped triangles).
import type { Canvas, Image, SKRSContext2D } from "@napi-rs/canvas";

export type V2 = { x: number; y: number };
export type V3 = { x: number; y: number; z: number };

/** Rotate (degrees, X then Y then Z) and translate a point. */
export function transform(p: V3, rot: { x?: number; y?: number; z?: number }, t: V3): V3 {
  const rx = ((rot.x ?? 0) * Math.PI) / 180, ry = ((rot.y ?? 0) * Math.PI) / 180, rz = ((rot.z ?? 0) * Math.PI) / 180;
  let { x, y, z } = p;
  // X
  let y1 = y * Math.cos(rx) - z * Math.sin(rx), z1 = y * Math.sin(rx) + z * Math.cos(rx);
  y = y1; z = z1;
  // Y
  let x1 = x * Math.cos(ry) + z * Math.sin(ry);
  z1 = -x * Math.sin(ry) + z * Math.cos(ry);
  x = x1; z = z1;
  // Z
  x1 = x * Math.cos(rz) - y * Math.sin(rz);
  y1 = x * Math.sin(rz) + y * Math.cos(rz);
  return { x: x1 + t.x, y: y1 + t.y, z: z + t.z };
}
/** Pinhole projection onto the screen. `focal` in px; the camera sits at z = 0 looking down +z. */
export function project(p: V3, cx: number, cy: number, focal: number): V2 {
  const z = Math.max(1, p.z);
  return { x: cx + (p.x * focal) / z, y: cy + (p.y * focal) / z };
}
/** Screen corners (TL, TR, BR, BL) of a w×h plane centred at the origin, rotated and pushed to `t`. */
export function planeQuad(w: number, h: number, rot: { x?: number; y?: number; z?: number }, t: V3, cx: number, cy: number, focal: number): V2[] {
  return [
    { x: -w / 2, y: -h / 2, z: 0 },
    { x: w / 2, y: -h / 2, z: 0 },
    { x: w / 2, y: h / 2, z: 0 },
    { x: -w / 2, y: h / 2, z: 0 },
  ].map((p) => project(transform(p, rot, t), cx, cy, focal));
}

// Homography from the unit square to a quad.
function squareToQuad(q: V2[]) {
  const [p0, p1, p2, p3] = q;
  const dx1 = p1.x - p2.x, dx2 = p3.x - p2.x, dx3 = p0.x - p1.x + p2.x - p3.x;
  const dy1 = p1.y - p2.y, dy2 = p3.y - p2.y, dy3 = p0.y - p1.y + p2.y - p3.y;
  const det = dx1 * dy2 - dx2 * dy1;
  const g = (dx3 * dy2 - dx2 * dy3) / det, h = (dx1 * dy3 - dx3 * dy1) / det;
  const a = p1.x - p0.x + g * p1.x, b = p3.x - p0.x + h * p3.x, c = p0.x;
  const d = p1.y - p0.y + g * p1.y, e = p3.y - p0.y + h * p3.y, f = p0.y;
  return (u: number, v: number): V2 => {
    const w = g * u + h * v + 1;
    return { x: (a * u + b * v + c) / w, y: (d * u + e * v + f) / w };
  };
}

/** Draw one source triangle onto one destination triangle with an affine transform. */
function tri(x: SKRSContext2D, img: Image | Canvas, s: V2[], d: V2[]) {
  const [s0, s1, s2] = s, [d0, d1, d2] = d;
  const den = (s1.x - s0.x) * (s2.y - s0.y) - (s2.x - s0.x) * (s1.y - s0.y);
  if (Math.abs(den) < 1e-9) return;
  const a = ((d1.x - d0.x) * (s2.y - s0.y) - (d2.x - d0.x) * (s1.y - s0.y)) / den;
  const b = ((d1.y - d0.y) * (s2.y - s0.y) - (d2.y - d0.y) * (s1.y - s0.y)) / den;
  const c = ((d2.x - d0.x) * (s1.x - s0.x) - (d1.x - d0.x) * (s2.x - s0.x)) / den;
  const dd = ((d2.y - d0.y) * (s1.x - s0.x) - (d1.y - d0.y) * (s2.x - s0.x)) / den;
  const e = d0.x - a * s0.x - c * s0.y;
  const f = d0.y - b * s0.x - dd * s0.y;
  // Expand the clip triangle a hair so neighbouring cells don't leave seams.
  const cxm = (d0.x + d1.x + d2.x) / 3, cym = (d0.y + d1.y + d2.y) / 3;
  const grow = (p: V2) => {
    const vx = p.x - cxm, vy = p.y - cym, l = Math.hypot(vx, vy) || 1;
    return { x: p.x + (vx / l) * 0.7, y: p.y + (vy / l) * 0.7 };
  };
  const g0 = grow(d0), g1 = grow(d1), g2 = grow(d2);
  x.save();
  x.beginPath();
  x.moveTo(g0.x, g0.y);
  x.lineTo(g1.x, g1.y);
  x.lineTo(g2.x, g2.y);
  x.closePath();
  x.clip();
  x.transform(a, b, c, dd, e, f);
  x.drawImage(img, 0, 0);
  x.restore();
}

/**
 * Draw `img` (or the sub-rectangle `src` of it) onto the screen quad `q` (TL, TR, BR, BL).
 * `cells` controls how finely the perspective is approximated.
 */
export function drawQuad(x: SKRSContext2D, img: Image | Canvas, q: V2[], src?: { x: number; y: number; w: number; h: number }, cells = 14) {
  const sw = src?.w ?? img.width, sh = src?.h ?? img.height;
  const sx = src?.x ?? 0, sy = src?.y ?? 0;
  const map = squareToQuad(q);
  const grid: V2[][] = [];
  for (let j = 0; j <= cells; j++) {
    grid.push([]);
    for (let i = 0; i <= cells; i++) grid[j].push(map(i / cells, j / cells));
  }
  for (let j = 0; j < cells; j++) {
    for (let i = 0; i < cells; i++) {
      const s00 = { x: sx + (i / cells) * sw, y: sy + (j / cells) * sh };
      const s10 = { x: sx + ((i + 1) / cells) * sw, y: s00.y };
      const s01 = { x: s00.x, y: sy + ((j + 1) / cells) * sh };
      const s11 = { x: s10.x, y: s01.y };
      tri(x, img, [s00, s10, s11], [grid[j][i], grid[j][i + 1], grid[j + 1][i + 1]]);
      tri(x, img, [s00, s11, s01], [grid[j][i], grid[j + 1][i + 1], grid[j + 1][i]]);
    }
  }
}

/** Path the outline of a quad (for shadows, borders and masks). */
export function quadPath(x: SKRSContext2D, q: V2[]) {
  x.beginPath();
  x.moveTo(q[0].x, q[0].y);
  for (let i = 1; i < 4; i++) x.lineTo(q[i].x, q[i].y);
  x.closePath();
}
