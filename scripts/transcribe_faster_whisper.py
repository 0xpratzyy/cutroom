# Word-level transcription with faster-whisper. Invoked by cutroom via:
#   uv run --python 3.12 --with faster-whisper python transcribe_faster_whisper.py <audio.f32> <model> [language]
# <audio.f32> is raw mono float32 PCM at 16 kHz (cutroom extracts it with ffmpeg), which
# avoids depending on PyAV's decoder.
# Prints one JSON object to stdout: {"language": str, "words": [{"text", "start", "end", "conf"}]}
import json
import sys

import numpy as np

from faster_whisper import WhisperModel

# Whisper tends to "clean up" disfluencies. Priming it with a disfluent prompt
# makes it far more likely to keep the ums and uhs we want to cut.
FILLER_PROMPT = "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking. Uh, so, um, yeah."


def main() -> None:
    audio = sys.argv[1]
    model_name = sys.argv[2] if len(sys.argv) > 2 else "base.en"
    language = sys.argv[3] if len(sys.argv) > 3 and sys.argv[3] != "auto" else None

    samples = np.fromfile(audio, dtype=np.float32)
    model = WhisperModel(model_name, device="auto", compute_type="auto")
    segments, info = model.transcribe(
        samples,
        language=language,
        word_timestamps=True,
        initial_prompt=FILLER_PROMPT,
        vad_filter=False,
        condition_on_previous_text=False,
    )

    words = []
    total = max(info.duration, 0.001)
    for seg in segments:
        for w in seg.words or []:
            text = w.word.strip()
            if not text:
                continue
            words.append({"text": text, "start": round(w.start, 3), "end": round(w.end, 3), "conf": round(w.probability, 3)})
        print(json.dumps({"progress": min(seg.end / total, 1.0)}), file=sys.stderr, flush=True)

    print(json.dumps({"language": info.language, "words": words}))


if __name__ == "__main__":
    main()
