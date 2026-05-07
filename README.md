# paroli

A lightweight TTS (text-to-speech) REST server built on [Kokoro](https://github.com/hexgrad/kokoro), with support for English and Japanese voices and automatic language mixing.

## Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/v1` | Health check |
| GET | `/v1/models` | List available models |
| GET | `/v1/voices` | List available voices |
| POST | `/v1/audio/speech` | Generate speech (streaming WAV) |
| POST | `/v1/audio/speech/create` | Alias for the above |

### Voices

| Voice | Language | Notes |
|-------|----------|-------|
| `af_heart` | English (US) | Default |
| `jf_alpha` | Japanese | |
| `mix` | EN + JA | Auto-detects and switches per segment |

### Request parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `input` | string | — | Text to synthesize (required) |
| `voice` | string | `af_heart` | Voice ID |
| `speed` | float | `1.0` | Playback speed, `0.25`–`4.0` |

Unknown fields (e.g. `model`) are silently ignored, so OpenAI-compatible TTS clients can point at this server without modification.

### Response format

Streaming WAV — 24 kHz, mono, 16-bit PCM. The `Content-Type` is `audio/wav` and the body is chunked, so playback can begin before synthesis is complete.

### Example request

```bash
curl -X POST http://localhost:8000/v1/audio/speech \
  -H "Content-Type: application/json" \
  -d '{"input": "Hello world", "voice": "af_heart", "speed": 1.5}' \
  --output speech.wav
```

## Browser integration — Read Aloud extension

A key use case for this server is pairing it with the [Read Aloud: A Text to Speech Voice Reader](https://chromewebstore.google.com/detail/read-aloud-a-text-to-spee/hdhinadidafjejdhmfkjgnolgimiaplp) Chrome extension. This lets you highlight any text on a webpage and have it read aloud using your local Kokoro models, including seamless switching between English and Japanese within the same selection.

**Setup:**

1. Open the Read Aloud extension settings
2. Go to the **Voice** tab and scroll to the bottom
3. Click **"Enable Custom Voices..."**
4. Under the **OpenAI** option, set:
   - **API URL:** `http://localhost:8000/v1/audio/speech`
   - **Voice List:**
     ```json
     [
       { "lang": "en-US", "model": "tts-1", "voice": "af_heart" },
       { "lang": "ja-JP", "model": "tts-1", "voice": "jf_alpha" },
       { "lang": "en-US", "model": "tts-1", "voice": "mix" }
     ]
     ```

The `mix` voice is the standout option here — it auto-detects Japanese script within English text and switches pipelines per segment, so you can read mixed-language pages without manually changing voices or limiting your selection to one language. For example, selecting a sentence like "今日 was a great day, but 明日 will be even better!" will read the Japanese words in Japanese and the English words in English, seamlessly.

## Running

**Docker (recommended):**

```bash
docker build -t paroli .
docker run -d --restart unless-stopped --name paroli --gpus all -p 8000:8000 paroli
```

The build bakes the Kokoro model weights directly into the image, so startup is fast but the image is large (~a few GB). No model downloads happen at runtime.

The server uses CUDA if available and falls back to CPU automatically. GPU mode requires driver 535+ (CUDA 12.2+) and [nvidia-container-toolkit](https://docs.nvidia.com/datacenter/cloud-native/container-toolkit/latest/install-guide.html) on the host. The image ships PyTorch cu121 wheels, which are compatible with any driver that supports CUDA 12.1 or later.

The server sets `X-Accel-Buffering: no` on responses, so streaming works correctly behind an nginx reverse proxy.

**Local (venv):**

```bash
python3 -m venv venv
source venv/bin/activate
pip install -r requirements.txt
uvicorn server:app --host 0.0.0.0 --port 8000
```

## Testing

```bash
source venv/bin/activate
pip install pytest
pytest test_server.py -v
```
