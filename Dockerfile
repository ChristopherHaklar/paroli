# Use Python 3.11 slim image as base
FROM python:3.11-slim

# Install system dependencies needed for phonemizer, audio processing, and Japanese support
RUN --mount=type=cache,target=/var/cache/apt,sharing=locked \
    apt-get update && apt-get install -y --no-install-recommends \
    espeak-ng \
    build-essential

# Set working directory
WORKDIR /app

# Copy requirements first to leverage Docker cache
COPY requirements.txt .

# Install PyTorch with CUDA 12.1 wheels (compatible with driver 535 / CUDA 12.2)
RUN --mount=type=cache,target=/pip-cache \
    pip install --cache-dir /pip-cache torch --index-url https://download.pytorch.org/whl/cu121

# Install Python dependencies
RUN --mount=type=cache,target=/pip-cache \
    pip install --cache-dir /pip-cache -r requirements.txt

# Pre-download Kokoro model weights and spacy model into the image
RUN python3 -c "from kokoro import KPipeline; KPipeline(lang_code='a'); KPipeline(lang_code='j')"

# Copy application files
COPY server.py .

# Expose the port the app runs on
EXPOSE 8000

# Health check
HEALTHCHECK --interval=30s --timeout=10s --start-period=5s --retries=3 \
    CMD python -c "import httpx; httpx.get('http://localhost:8000/v1')" || exit 1

# Run the application
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8000"]