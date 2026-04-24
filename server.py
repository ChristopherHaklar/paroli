import re
import io
import numpy as np
import soundfile as sf
from fastapi import FastAPI, Request, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from kokoro import KPipeline

# how aggressively to trim (absolute amplitude threshold)
SILENCE_THRESH = 1e-4
# how long to cross-fade in seconds
CROSSFADE_SEC = 0.05
SR = 24000

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# voice→lang map
voice2lang = {
    "af_heart": "a",   # English
    "jf_alpha": "j",   # Japanese
    "mix":      "mix", # special auto switch
}

# one pipeline per real language
pipelines = {
    "a": KPipeline(lang_code="a"),
    "j": KPipeline(lang_code="j"),
}

DEFAULT_VOICE = "af_heart"

# regex to split Japanese vs non-Japanese runs
_jp_re = re.compile(r"[\u3000-\u30FF\u4E00-\u9FFF]+")


def segment_text(text):
    parts = _jp_re.split(text)
    splits = _jp_re.findall(text)
    runs = []
    for i, part in enumerate(parts):
        if part:
            runs.append(("a", part))
        if i < len(splits):
            runs.append(("j", splits[i]))
    return runs


@app.get("/v1")
async def health():
    return {"status": "ok"}


@app.get("/v1/models")
async def models():
    return {"data": [{"id": "tts-1", "object": "model"}]}


@app.get("/v1/voices")
async def voices():
    return {
        "voices": [
            {"voice": "af_heart", "lang": "en-US", "description": ""},
            {"voice": "jf_alpha", "lang": "ja-JP", "description": ""},
            {"voice": "mix",      "lang": "en-US", "description": "Auto-detect EN/JA"},
        ]
    }


def trim_silence(wave, thresh=SILENCE_THRESH):
    mask = np.abs(wave) > thresh
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return np.zeros((0,), dtype=wave.dtype)
    return wave[idx[0]:idx[-1] + 1]


def concat_with_crossfade(chunks, sr=SR, crossfade_sec=CROSSFADE_SEC):
    fade_len = int(sr * crossfade_sec)
    out = chunks[0]
    for seg in chunks[1:]:
        if fade_len > 0 and len(out) >= fade_len and len(seg) >= fade_len:
            fade_out = np.linspace(1.0, 0.0, fade_len)
            fade_in  = np.linspace(0.0, 1.0, fade_len)
            tail   = out[-fade_len:] * fade_out
            head   = seg[:fade_len]  * fade_in
            middle = np.add(tail, head)
            out = np.concatenate([out[:-fade_len], middle, seg[fade_len:]])
        else:
            out = np.concatenate([out, seg])
    return out


async def do_tts(text, voice_id):
    waves = []

    if voice_id == "mix":
        runs = segment_text(text)
        for lang, seg in runs:
            if not seg.strip():
                continue
            vid = "jf_alpha" if lang == "j" else "af_heart"
            for _, _, chunk in pipelines[lang](seg, voice=vid):
                waves.append(chunk)
    else:
        lang = voice2lang.get(voice_id, "a")
        for _, _, chunk in pipelines[lang](text, voice=voice_id):
            waves.append(chunk)

    # trim silence from each chunk and discard empties
    trimmed = [w for w in (trim_silence(c) for c in waves) if len(w) > 0]
    if not trimmed:
        raise HTTPException(status_code=500, detail="No audio generated")

    final = concat_with_crossfade(trimmed)

    buf = io.BytesIO()
    sf.write(buf, final, SR, format="WAV")
    buf.seek(0)
    return buf


@app.post("/v1/audio/speech")
@app.post("/v1/audio/speech/create")
async def tts_create(req: Request):
    j     = await req.json()
    text  = j.get("input", "")
    voice = j.get("voice", DEFAULT_VOICE)
    buf   = await do_tts(text, voice)
    return StreamingResponse(buf, media_type="audio/wav")