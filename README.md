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

The `mix` voice is the standout option here — it auto-detects Japanese script within English text and switches pipelines per segment, so you can read mixed-language pages without manually changing voices or limiting your selection to one language.

## Running

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
