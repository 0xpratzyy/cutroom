// Generates the demo "talking head" for the launch film: an illustrated presenter on a
// warm studio wall, lip-synced to TTS. Placed left-of-center in 16:9 so a 9:16 crop at the
// default focus cuts them off (the problem the viewer "boxes" in the film).
// Usage: npx tsx launch/speaker.mts   ->  launch/out/speaker.webm
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import { createCanvas, type SKRSContext2D } from "@napi-rs/canvas";

const OUT = "launch/out";
mkdirSync(OUT, { recursive: true });
const W = 1920, H = 1080, FPS = 30;
const LINE = "Hey, I'm Reed. [[slnc 350]] Um, today I wanna show you something cool. [[slnc 700]] So the idea is... [[slnc 600]] so the idea is really simple. [[slnc 300]] You point at what's wrong, and the AI just fixes it. [[slnc 500]] Let's go.";

// The presenter's voice: ElevenLabs when launch/eleven.mts has run, else macOS `say`.
const eleven = "launch/out/eleven/speaker.mp3";
if (existsSync(eleven)) execFileSync("ffmpeg", ["-v", "error", "-y", "-i", eleven, "-af", "adelay=300:all=1,apad=pad_dur=0.4", `${OUT}/speaker.aiff`]);
else execFileSync("say", ["-v", "Reed (English (US))", "-r", "185", "-o", `${OUT}/speaker.aiff`, LINE]);
const pcm = execFileSync("ffmpeg", ["-v", "error", "-i", `${OUT}/speaker.aiff`, "-ac", "1", "-ar", "48000", "-f", "s16le", "-"], { maxBuffer: 1 << 28 });
const samples = new Int16Array(pcm.buffer, pcm.byteOffset, pcm.byteLength / 2);
const dur = samples.length / 48000 + 0.6;
const frames = Math.ceil(dur * FPS);
// Mouth openness per frame from RMS, smoothed with fast attack / slower release.
const amp: number[] = [];
let env = 0;
for (let f = 0; f < frames; f++) {
  const a = Math.floor((f / FPS) * 48000), b = Math.min(samples.length, a + 1600);
  let sum = 0;
  for (let i = a; i < b; i++) sum += (samples[i] / 32768) ** 2;
  const rms = b > a ? Math.sqrt(sum / (b - a)) : 0;
  const target = Math.min(1, rms * 5.5);
  env = target > env ? env + (target - env) * 0.75 : env + (target - env) * 0.35;
  amp.push(env);
}

const c = createCanvas(W, H);
const x = c.getContext("2d");
const ff = spawn("ffmpeg", ["-v", "error", "-y", "-f", "rawvideo", "-pix_fmt", "rgba", "-s", `${W}x${H}`, "-r", String(FPS), "-i", "-", "-i", `${OUT}/speaker.aiff`,
  "-c:v", "libvpx-vp9", "-b:v", "7M", "-deadline", "realtime", "-cpu-used", "8", "-row-mt", "1", "-pix_fmt", "yuv420p", "-c:a", "libopus", "-b:a", "128k", "-shortest", `${OUT}/speaker.webm`], { stdio: ["pipe", "inherit", "inherit"] });

const noise = (t: number, s: number) => Math.sin(t * 1.3 + s) * 0.5 + Math.sin(t * 2.7 + s * 2.1) * 0.3 + Math.sin(t * 0.7 + s * 0.5) * 0.2;

function background(t: number) {
  const g = x.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, "#ff8a4c"); g.addColorStop(0.55, "#f2663a"); g.addColorStop(1, "#c94626");
  x.fillStyle = g; x.fillRect(0, 0, W, H);
  // ribbed wall panels
  for (let i = 0; i < W; i += 64) {
    const s = x.createLinearGradient(i, 0, i + 64, 0);
    s.addColorStop(0, "rgba(255,255,255,0.06)"); s.addColorStop(0.5, "rgba(0,0,0,0.0)"); s.addColorStop(1, "rgba(0,0,0,0.10)");
    x.fillStyle = s; x.fillRect(i, 0, 64, H);
  }
  // key light pool behind the speaker
  const p = x.createRadialGradient(600, 380, 0, 600, 380, 700);
  p.addColorStop(0, "rgba(255,220,180,0.35)"); p.addColorStop(1, "rgba(255,220,180,0)");
  x.fillStyle = p; x.fillRect(0, 0, W, H);
  plant(t);
  // vignette
  const v = x.createRadialGradient(W / 2, H / 2, H * 0.35, W / 2, H / 2, H * 1.05);
  v.addColorStop(0, "rgba(0,0,0,0)"); v.addColorStop(1, "rgba(30,8,0,0.55)");
  x.fillStyle = v; x.fillRect(0, 0, W, H);
}

function plant(t: number) {
  // pot
  x.fillStyle = "#b8442a";
  x.beginPath(); x.moveTo(1420, 760); x.lineTo(1660, 760); x.lineTo(1630, 1080); x.lineTo(1450, 1080); x.closePath(); x.fill();
  x.fillStyle = "rgba(0,0,0,0.18)"; x.fillRect(1420, 760, 240, 26);
  // leaves (calathea-ish), gentle sway
  const leaves = [[-62, 300, 1.0], [-30, 360, 1.15], [8, 330, 1.05], [40, 370, 1.2], [70, 290, 0.95], [-10, 250, 0.85], [24, 230, 0.8]];
  for (const [ang, len, k] of leaves) {
    const sway = Math.sin(t * 0.9 + ang) * 2.2;
    x.save(); x.translate(1540, 770); x.rotate(((ang + sway) * Math.PI) / 180);
    const lg = x.createLinearGradient(0, 0, 0, -len);
    lg.addColorStop(0, "#2d1530"); lg.addColorStop(0.5, "#5b2a52"); lg.addColorStop(1, "#3c1d3d");
    x.fillStyle = lg;
    x.beginPath(); x.ellipse(0, -len / 2, 62 * k, len / 2, 0, 0, Math.PI * 2); x.fill();
    x.strokeStyle = "rgba(255,170,210,0.35)"; x.lineWidth = 3;
    x.beginPath(); x.moveTo(0, -10); x.lineTo(0, -len + 20); x.stroke();
    for (let i = 1; i < 6; i++) { x.beginPath(); x.moveTo(0, -len * i / 6); x.lineTo(40 * k, -len * i / 6 - 26); x.moveTo(0, -len * i / 6); x.lineTo(-40 * k, -len * i / 6 - 26); x.stroke(); }
    x.restore();
  }
}

function person(t: number, a: number) {
  const cx = 600, breathe = Math.sin(t * 1.6) * 4;
  const bob = noise(t, 1) * 5 + a * 6;
  const tilt = (noise(t * 0.8, 4) * 2.2 + a * 1.2) * (Math.PI / 180);
  // boom mic arm
  x.strokeStyle = "#1c1717"; x.lineWidth = 16; x.lineCap = "round";
  x.beginPath(); x.moveTo(-40, 120); x.lineTo(250, 360); x.lineTo(330, 610); x.stroke();
  x.lineWidth = 10; x.strokeStyle = "#2c2626"; x.beginPath(); x.moveTo(-40, 150); x.lineTo(250, 390); x.stroke();
  // torso / hoodie
  x.save(); x.translate(cx, 700 + breathe);
  const hg = x.createLinearGradient(0, 0, 0, 420);
  hg.addColorStop(0, "#2f3352"); hg.addColorStop(1, "#1d2036");
  x.fillStyle = hg;
  x.beginPath(); x.moveTo(-300, 380); x.bezierCurveTo(-310, 120, -230, 40, -120, 20); x.lineTo(120, 20); x.bezierCurveTo(230, 40, 310, 120, 300, 380); x.closePath(); x.fill();
  x.fillStyle = "#262a45"; x.beginPath(); x.ellipse(0, 40, 150, 60, 0, 0, Math.PI * 2); x.fill(); // hood rim
  x.strokeStyle = "#e8f47c"; x.lineWidth = 7; // drawstrings
  x.beginPath(); x.moveTo(-40, 70); x.lineTo(-46, 190); x.moveTo(40, 70); x.lineTo(46, 175); x.stroke();
  x.restore();
  // neck
  x.fillStyle = "#b8774f"; x.fillRect(cx - 55, 600 + breathe, 110, 120);
  // head
  x.save(); x.translate(cx, 440 + bob + breathe * 0.6); x.rotate(tilt);
  x.fillStyle = "#c98a5e"; // ears
  x.beginPath(); x.ellipse(-152, 20, 28, 42, 0, 0, Math.PI * 2); x.ellipse(152, 20, 28, 42, 0, 0, Math.PI * 2); x.fill();
  const sk = x.createRadialGradient(-40, -40, 20, 0, 0, 220);
  sk.addColorStop(0, "#d99a6c"); sk.addColorStop(1, "#b9784e");
  x.fillStyle = sk; x.beginPath(); x.ellipse(0, 0, 155, 185, 0, 0, Math.PI * 2); x.fill();
  // hair (curly top)
  x.fillStyle = "#1e1414";
  x.beginPath(); x.ellipse(0, -120, 160, 95, 0, Math.PI, 0); x.fill();
  for (let i = -5; i <= 5; i++) { x.beginPath(); x.arc(i * 28, -150 - Math.abs(i) * -3 + Math.sin(i) * 6, 34, 0, Math.PI * 2); x.fill(); }
  x.beginPath(); x.ellipse(-140, -60, 30, 70, 0.2, 0, Math.PI * 2); x.ellipse(140, -60, 30, 70, -0.2, 0, Math.PI * 2); x.fill();
  // brows
  const lift = a * 10 + Math.max(0, noise(t * 2, 7)) * 4;
  x.fillStyle = "#1e1414";
  x.beginPath(); x.roundRect(-105, -62 - lift, 72, 14, 7); x.roundRect(33, -64 - lift, 72, 14, 7); x.fill();
  // eyes + blink
  const blinkPhase = (t % 3.4) / 3.4;
  const open = blinkPhase > 0.955 ? 0.12 : 1;
  for (const ex of [-68, 68]) {
    x.fillStyle = "#fff"; x.beginPath(); x.ellipse(ex, -10, 26, 20 * open, 0, 0, Math.PI * 2); x.fill();
    if (open > 0.5) { x.fillStyle = "#2a1a12"; x.beginPath(); x.arc(ex + 4, -8, 11, 0, Math.PI * 2); x.fill(); x.fillStyle = "#fff"; x.beginPath(); x.arc(ex + 8, -12, 3.5, 0, Math.PI * 2); x.fill(); }
  }
  // glasses
  x.strokeStyle = "#151010"; x.lineWidth = 8;
  x.beginPath(); x.arc(-68, -10, 46, 0, Math.PI * 2); x.moveTo(114, -10); x.arc(68, -10, 46, 0, Math.PI * 2); x.moveTo(-22, -14); x.lineTo(22, -14); x.stroke();
  // nose
  x.strokeStyle = "rgba(120,60,30,0.6)"; x.lineWidth = 6; x.lineCap = "round";
  x.beginPath(); x.moveTo(4, 10); x.quadraticCurveTo(18, 52, -6, 60); x.stroke();
  // mouth
  const mh = 8 + a * 44, mw = 70 - a * 12;
  x.fillStyle = "#5a1d1d"; x.beginPath(); x.ellipse(0, 108, mw / 2, mh / 2, 0, 0, Math.PI * 2); x.fill();
  if (mh > 20) { x.fillStyle = "#f4ece6"; x.beginPath(); x.ellipse(0, 108 - mh / 2 + 6, mw / 2 - 8, 6, 0, 0, Math.PI * 2); x.fill(); }
  x.restore();
  // mic capsule in front
  x.save(); x.translate(360, 640); x.rotate(-0.35);
  const mg = x.createLinearGradient(-40, 0, 40, 0); mg.addColorStop(0, "#111"); mg.addColorStop(0.5, "#3a3434"); mg.addColorStop(1, "#111");
  x.fillStyle = mg; x.beginPath(); x.roundRect(-42, -95, 84, 190, 40); x.fill();
  x.strokeStyle = "rgba(255,255,255,0.12)"; x.lineWidth = 2;
  for (let i = -70; i < 70; i += 14) { x.beginPath(); x.moveTo(-36, i); x.lineTo(36, i); x.stroke(); }
  x.restore();
}

for (let f = 0; f < frames; f++) {
  const t = f / FPS;
  background(t);
  person(t, amp[f] ?? 0);
  const buf = Buffer.from(x.getImageData(0, 0, W, H).data.buffer);
  if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
}
ff.stdin.end();
await new Promise((r) => ff.on("close", r));
console.log(`speaker.webm: ${frames} frames, ${dur.toFixed(1)}s`);
