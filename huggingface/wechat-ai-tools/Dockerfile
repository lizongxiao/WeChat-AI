# wechat-ai-tools — Hugging Face Spaces / self-hosted Docker image
#
# Build:
#   docker build -t wechat-ai-tools:latest -f huggingface/wechat-ai-tools/Dockerfile huggingface/wechat-ai-tools
#   # or from this directory:
#   docker build -t wechat-ai-tools:latest .
#
# Run:
#   docker run --rm -p 7860:7860 --env-file .env wechat-ai-tools:latest
#
# HF Spaces: set SDK to Docker; Space will use this Dockerfile.

FROM docker.1panel.live/library/python:3.12-slim-bookworm

ARG PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple

LABEL org.opencontainers.image.title="wechat-ai-tools" \
      org.opencontainers.image.description="WeChat-AI tools gateway: web search + user custom LLM proxy" \
      org.opencontainers.image.source="https://github.com/wechat-ai/wechat-ai"

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    PIP_DISABLE_PIP_VERSION_CHECK=1 \
    PIP_INDEX_URL=$PIP_INDEX_URL \
    HOST=0.0.0.0 \
    PORT=7860

# Non-root user (HF Spaces compatible)
RUN groupadd --system --gid 1000 app \
  && useradd --system --uid 1000 --gid app --create-home --home-dir /home/app app

WORKDIR /app

COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY --chown=app:app . .

USER app

EXPOSE 7860

HEALTHCHECK --interval=30s --timeout=8s --start-period=20s --retries=3 \
  CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:7860/health', timeout=5)"

# HF Spaces and local both use PORT (default 7860)
CMD ["sh", "-c", "uvicorn app:app --host ${HOST:-0.0.0.0} --port ${PORT:-7860}"]
