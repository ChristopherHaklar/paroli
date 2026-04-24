# paroli

A lightweight TTS (text-to-speech) REST server built on [Kokoro](https://github.com/hexgrad/kokoro), with support for English and Japanese voices and automatic language mixing.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1` | Health check |
| GET | `/v1/models` | List available models |
| GET | `/v1/voices` | List available voices |
| POST | `/v1/audio/speech` | Generate speech (returns WAV) |

### Voices

| Voice | Language | Notes |
|-------|----------|-------|
| `af_heart` | English (US) | Default |
| `jf_alpha` | Japanese | |
| `mix` | EN + JA | Auto-detects and switches per segment |

### Example request

```bash
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world", "voice": "af_heart"}' \
  --output speech.wav
```

## Running

```bash
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

## Testing

```bash
pip install pytest
pytest test_server.py -v
```
