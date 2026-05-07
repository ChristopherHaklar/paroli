import re
import struct
import logging
import time
import warnings
import itertools
import numpy as np
from pydantic import BaseModel, Field
from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
import torch
from kokoro import KPipeline

warnings.filterwarnings("ignore", category=UserWarning, module="torch")
warnings.filterwarnings("ignore", category=FutureWarning, module="torch")
logging.getLogger("huggingface_hub").setLevel(logging.ERROR)
logging.getLogger("httpx").setLevel(logging.WARNING)
logging.getLogger("misaki").setLevel(logging.ERROR)

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger(__name__)
_req_id = itertools.count(1)

log.info("device=%s", "cuda" if torch.cuda.is_available() else "cpu")

SILENCE_THRESH = 1e-4
SR = 24000

app = FastAPI()
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

voice2lang = {
    "af_heart": "a",
    "jf_alpha": "j",
    "mix":      "mix",
}

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"

pipelines = {
    "a": KPipeline(lang_code="a", repo_id="hexgrad/Kokoro-82M", device=DEVICE),
    "j": KPipeline(lang_code="j", repo_id="hexgrad/Kokoro-82M", device=DEVICE),
}

DEFAULT_VOICE = "af_heart"

_jp_re = re.compile(r"[　-ヿ一-鿿]+")


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
    wave = np.asarray(wave)
    mask = np.abs(wave) > thresh
    idx = np.flatnonzero(mask)
    if idx.size == 0:
        return np.zeros((0,), dtype=wave.dtype)
    return wave[idx[0]:idx[-1] + 1]


def _wav_header(sample_rate=SR, channels=1, bits=16) -> bytes:
    # 0xFFFFFFFF signals unknown/streaming size to compliant WAV parsers
    byte_rate = sample_rate * channels * bits // 8
    block_align = channels * bits // 8
    return struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", 0xFFFFFFFF, b"WAVE",
        b"fmt ", 16, 1, channels, sample_rate, byte_rate, block_align, bits,
        b"data", 0xFFFFFFFF,
    )


def _pcm16(chunk) -> bytes:
    arr = np.asarray(chunk)
    return (np.clip(arr, -1.0, 1.0) * 32767).astype(np.int16).tobytes()


async def stream_tts(text: str, voice_id: str, speed: float = 1.0):
    yield _wav_header()

    if voice_id == "mix":
        for lang, seg in segment_text(text):
            if not seg.strip():
                continue
            vid = "jf_alpha" if lang == "j" else "af_heart"
            for _, _, chunk in pipelines[lang](seg, voice=vid, speed=speed):
                trimmed = trim_silence(chunk)
                if len(trimmed) > 0:
                    yield _pcm16(trimmed)
    else:
        lang = voice2lang.get(voice_id, "a")
        for _, _, chunk in pipelines[lang](text, voice=voice_id, speed=speed):
            trimmed = trim_silence(chunk)
            if len(trimmed) > 0:
                yield _pcm16(trimmed)


class TTSRequest(BaseModel):
    input: str
    voice: str = DEFAULT_VOICE
    speed: float = Field(1.0, ge=0.25, le=4.0)


@app.post("/v1/audio/speech")
@app.post("/v1/audio/speech/create")
async def tts_create(req: TTSRequest):
    if not req.input.strip():
        raise HTTPException(status_code=400, detail="input must not be empty")
    if req.voice not in voice2lang:
        raise HTTPException(status_code=400, detail=f"unknown voice '{req.voice}'")

    rid = next(_req_id)
    log.info("[%d] start voice=%s speed=%s chars=%d", rid, req.voice, req.speed, len(req.input))
    t0 = time.perf_counter()

    async def timed_stream():
        first = True
        async for chunk in stream_tts(req.input, req.voice, req.speed):
            if first:
                log.info("[%d] ttfb=%.3fs", rid, time.perf_counter() - t0)
                first = False
            yield chunk
        log.info("[%d] done total=%.3fs", rid, time.perf_counter() - t0)

    headers = {"X-Accel-Buffering": "no"}
    return StreamingResponse(timed_stream(), media_type="audio/wav", headers=headers)
