// Voice notes: hold V (or the mic button) and talk while the video plays. On release the
// clip is uploaded, transcribed locally, and becomes a note anchored to what was on screen.
import { store, toast } from "./store";

let rec: MediaRecorder | null = null;
let stream: MediaStream | null = null;
let chunks: Blob[] = [];
let startedAt = 0;
let startTime = 0;
let region: { x: number; y: number; w: number; h: number } | null = null;
let meterRaf = 0;
let audioCtx: AudioContext | null = null;
let pointer: { x: number; y: number } | null = null;

// Remember where the cursor is over the video frame, to pin the note there.
window.addEventListener("pointermove", (e) => {
  const frame = (e.target as HTMLElement)?.closest?.(".frame");
  if (!frame) return void (pointer = null);
  const r = frame.getBoundingClientRect();
  pointer = { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
});

export async function startVoice() {
  if (rec || store.get().voice.sending) return;
  if (!store.get().project?.clips.length) return toast("Add a recording first", "error");
  if (!navigator.mediaDevices?.getUserMedia) return toast("This browser can't record audio", "error");
  startedAt = performance.now();
  startTime = store.get().time;
  region = pointer ? { ...pointer, w: 0, h: 0 } : null;
  store.set({ voice: { recording: true, sending: false, level: 0 } });
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } });
  } catch {
    store.set({ voice: { recording: false, sending: false, level: 0 } });
    return toast("Microphone access was blocked. Allow it in the browser to use voice notes.", "error");
  }
  if (!store.get().voice.recording) return cleanup(); // released before the mic opened
  const mime = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg"].find((m) => MediaRecorder.isTypeSupported(m)) ?? "";
  rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
  chunks = [];
  rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
  rec.start();
  meter(stream);
}

export async function stopVoice() {
  const s = store.get().voice;
  if (!s.recording) return;
  const r = rec;
  const held = performance.now() - startedAt;
  const endTime = store.get().time;
  store.set({ voice: { recording: false, sending: false, level: 0 } });
  if (!r) return cleanup();
  const done = new Promise<void>((ok) => (r.onstop = () => ok()));
  r.stop();
  await done;
  const type = r.mimeType || "audio/webm";
  cleanup();
  if (held < 500) return toast("Hold V while you talk, then let go", "info");
  const blob = new Blob(chunks, { type });
  const ext = type.includes("mp4") ? "m4a" : type.includes("ogg") ? "ogg" : "webm";
  store.set({ voice: { recording: false, sending: true, level: 0 } });
  const params = new URLSearchParams({ start: String(startTime), end: String(Math.max(endTime, startTime)), ext });
  if (region) {
    params.set("x", String(region.x));
    params.set("y", String(region.y));
  }
  try {
    const res = await fetch(`/api/voice-note?${params}`, { method: "POST", body: blob });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? res.statusText);
    store.set({ focusFeedback: data.id, rightTab: "feedback" });
    toast(`Note #${data.n}: "${data.note}"`, "info");
  } catch (err) {
    toast((err as Error).message, "error");
  } finally {
    store.set({ voice: { recording: false, sending: false, level: 0 } });
  }
}

function meter(s: MediaStream) {
  audioCtx = new AudioContext();
  const an = audioCtx.createAnalyser();
  an.fftSize = 512;
  audioCtx.createMediaStreamSource(s).connect(an);
  const buf = new Uint8Array(an.fftSize);
  const tick = () => {
    an.getByteTimeDomainData(buf);
    let peak = 0;
    for (const v of buf) peak = Math.max(peak, Math.abs(v - 128));
    const v = store.get().voice;
    if (v.recording) store.set({ voice: { ...v, level: Math.min(1, peak / 64) } });
    meterRaf = requestAnimationFrame(tick);
  };
  tick();
}

function cleanup() {
  cancelAnimationFrame(meterRaf);
  void audioCtx?.close();
  audioCtx = null;
  stream?.getTracks().forEach((t) => t.stop());
  stream = null;
  rec = null;
}
