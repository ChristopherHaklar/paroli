"""
Quick functional test for the Paroli TTS server.
Run with: pytest test_server.py -v
"""
import io
import wave
import pytest
from fastapi.testclient import TestClient
from server import app

client = TestClient(app)


def test_health():
    r = client.get("/v1")
    assert r.status_code == 200
    assert r.json() == {"status": "ok"}


def test_models():
    r = client.get("/v1/models")
    assert r.status_code == 200
    data = r.json()
    assert any(m["id"] == "tts-1" for m in data["data"])


def test_voices():
    r = client.get("/v1/voices")
    assert r.status_code == 200
    voice_ids = [v["voice"] for v in r.json()["voices"]]
    assert "af_heart" in voice_ids
    assert "jf_alpha" in voice_ids
    assert "mix" in voice_ids


def test_tts_english():
    r = client.post("/v1/audio/speech", json={"input": "Hello.", "voice": "af_heart"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    buf = io.BytesIO(r.content)
    with wave.open(buf) as w:
        assert w.getframerate() == 24000
        assert w.getnframes() > 0


def test_tts_japanese():
    r = client.post("/v1/audio/speech", json={"input": "こんにちは", "voice": "jf_alpha"})
    assert r.status_code == 200
    buf = io.BytesIO(r.content)
    with wave.open(buf) as w:
        assert w.getframerate() == 24000
        assert w.getnframes() > 0


def test_tts_mix():
    r = client.post("/v1/audio/speech", json={"input": "Hello こんにちは world", "voice": "mix"})
    assert r.status_code == 200
    buf = io.BytesIO(r.content)
    with wave.open(buf) as w:
        assert w.getframerate() == 24000
        assert w.getnframes() > 0


def test_tts_alias_endpoint():
    r = client.post("/v1/audio/speech/create", json={"input": "Test.", "voice": "af_heart"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"


def test_tts_default_voice():
    r = client.post("/v1/audio/speech", json={"input": "Default voice test."})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
