// Export to OpenTimelineIO JSON so projects round-trip into Resolve, Premiere, etc.
import { pathToFileURL } from "node:url";
import type { ProjectStore } from "./project.js";
import { placeClips, timelineDuration } from "./shared/timeline.js";

export async function toOTIO(store: ProjectStore): Promise<object> {
  const p = await store.load();
  const rate = p.settings.fps;
  const frames = (seconds: number) => Math.round(seconds * rate);
  const rt = (value: number) => ({ OTIO_SCHEMA: "RationalTime.1", rate, value });
  // Durations are differences of rounded positions (start..end), so clips never drift off the frame grid.
  const range = (from: number, start: number, end: number) => ({ OTIO_SCHEMA: "TimeRange.1", start_time: rt(frames(from)), duration: rt(frames(end) - frames(start)) });
  const ref = (mediaId: string) => {
    const m = p.media.find((x) => x.id === mediaId)!;
    return {
      OTIO_SCHEMA: "ExternalReference.1",
      target_url: pathToFileURL(store.resolveMediaPath(m)).href,
      available_range: range(0, 0, m.duration),
      metadata: {},
    };
  };
  const clip = (name: string, mediaId: string, srcIn: number, start: number, end: number) => ({
    OTIO_SCHEMA: "Clip.2",
    name,
    source_range: range(srcIn, start, end),
    media_references: { DEFAULT_MEDIA: ref(mediaId) },
    active_media_reference_key: "DEFAULT_MEDIA",
    effects: [],
    markers: [],
    metadata: {},
  });
  const gap = (start: number, end: number) => ({ OTIO_SCHEMA: "Gap.1", name: "", source_range: range(0, start, end), effects: [], markers: [], metadata: {} });

  const main = placeClips(p).map((pc) => clip(pc.clip.id, pc.clip.mediaId, pc.clip.in, pc.start, pc.end));
  const broll: object[] = [];
  let t = 0;
  for (const o of [...p.overlays].sort((a, b) => a.start - b.start)) {
    if (o.start > t) broll.push(gap(t, o.start));
    broll.push(clip(o.id, o.mediaId, o.in, o.start, o.start + o.duration));
    t = o.start + o.duration;
  }
  const track = (name: string, kind: string, children: object[]) => ({ OTIO_SCHEMA: "Track.1", name, kind, children, source_range: null, effects: [], markers: [], metadata: {} });
  return {
    OTIO_SCHEMA: "Timeline.1",
    name: p.name,
    global_start_time: rt(0),
    metadata: { cutroom: { duration: timelineDuration(p), zooms: p.zooms, captions: p.captions } },
    tracks: {
      OTIO_SCHEMA: "Stack.1",
      name: "tracks",
      children: [track("A-roll", "Video", main), track("B-roll", "Video", broll), track("A-roll audio", "Audio", main)],
      source_range: null,
      effects: [],
      markers: [],
      metadata: {},
    },
  };
}
