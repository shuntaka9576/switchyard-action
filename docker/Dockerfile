# syntax=docker/dockerfile:1

# --- builder: nemo-switchyard ships a Rust native extension (maturin), so
# the sdist needs cargo + a C toolchain. Build into a venv here; the
# runtime stage copies only the venv.
FROM python:3.12-slim AS builder

# Pin to a main commit that includes the streaming-usage stats fix
# (PR #64). Same pin as switchyard-opencode-bundle.
ARG SWITCHYARD_SHA=060ad758fe50a8dd4704b6de08a5d45502d9958b

RUN apt-get update \
    && apt-get install -y --no-install-recommends build-essential curl \
    && rm -rf /var/lib/apt/lists/*
RUN curl -sSf https://sh.rustup.rs | sh -s -- -y --profile minimal
ENV PATH="/root/.cargo/bin:${PATH}"

# Strip debug symbols from the maturin-built extension at compile time.
ENV RUSTFLAGS="-C strip=symbols"

RUN python -m venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cache/pip \
    pip install \
    "nemo-switchyard[server] @ https://github.com/NVIDIA-NeMo/Switchyard/archive/${SWITCHYARD_SHA}.tar.gz"

# Some OpenAI-compatible SaaS providers reject the vLLM-only
# `chat_template_kwargs` reasoning hint with HTTP 400; swap the classifier's
# injected body for the OpenAI-style `reasoning_effort: "none"`. Patch
# inherited from switchyard-opencode-bundle; the greps make a silent
# upstream change fail the build instead.
RUN RP="$(python -c 'import switchyard.lib.processors.llm_classifier.request_processor as m; print(m.__file__)')" \
    && grep -q 'extra_body = {"chat_template_kwargs": {"enable_thinking": False}}' "$RP" \
    && sed -i 's/extra_body = {"chat_template_kwargs": {"enable_thinking": False}}/extra_body = {"reasoning_effort": "none"}/' "$RP" \
    && grep -q 'extra_body = {"reasoning_effort": "none"}' "$RP" \
    && python -c "import switchyard.lib.processors.llm_classifier.request_processor"

# The venv only needs to run, not to install: drop installer tooling and
# bytecode caches (bytecode regenerates in memory at import time).
RUN pip uninstall -y pip setuptools wheel || true
RUN find /opt/venv -depth -type d -name '__pycache__' -exec rm -rf {} +

# --- runtime
FROM python:3.12-slim

# Everything lives in the venv; the base image's pip/setuptools are dead
# weight at runtime.
RUN python -m pip uninstall -y pip setuptools wheel && rm -rf /root/.cache

COPY --from=builder /opt/venv /opt/venv
ENV PATH="/opt/venv/bin:${PATH}"

RUN useradd --create-home switchyard
WORKDIR /app

# No route bundle is baked in — the image is provider-neutral. Bind-mount
# a route bundle at /app/route.yaml (switchyard-action generates and
# mounts one automatically from its inputs).
RUN mkdir -p /app/logs && chown switchyard:switchyard /app/logs
USER switchyard

EXPOSE 4100

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
    CMD python -c "import urllib.request; urllib.request.urlopen('http://127.0.0.1:4100/health', timeout=3)"

# Route-bundle mode with the per-request JSONL log. Intake sink stays
# disabled: request bodies never leave the container except toward the
# configured endpoints.
CMD ["sh", "-c", "test -f /app/route.yaml || { echo 'error: no route bundle found. Bind-mount one at /app/route.yaml (switchyard-action does this automatically).' >&2; exit 1; }; exec switchyard --routing-profiles /app/route.yaml serve --host 0.0.0.0 --port 4100 --routing-log-file /app/logs/routing.jsonl"]
