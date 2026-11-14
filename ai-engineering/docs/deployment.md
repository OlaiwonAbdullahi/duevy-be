# Deployment, Model Switching & Rollback

How to train a fine-tuned adapter, serve it, point Duevy at it, and roll back — all
driven by environment variables, with **no application code change**.

Duevy's NIM client (`src/ai/nim.ts`) already reads both the model and the endpoint
from env (`AI_MODEL`, `NVIDIA_BASE_URL`, `NVIDIA_API_KEY`, validated in
`src/config/env`). Switching models is therefore a config change.

## (a) Train the adapter — 8× 80 GB GPUs

On a single node with 8× 80 GB (H100/A100-class) GPUs:

```bash
# from a NeMo AutoModel environment with the dataset built (see ../datasets)
bash ai-engineering/training/train.sh
# uses ai-engineering/training/lora_config.yaml
```

This produces a LoRA adapter directory (checkpoints under the configured output
dir). Full SFT instead of LoRA needs 4 nodes — see
[model-compatibility.md](./model-compatibility.md). None of this runs in the dev
environment.

## (b) Serve it — self-hosted NIM

The hosted `integrate.api.nvidia.com` endpoint does **not** accept custom adapters,
so serve a fine-tuned variant from a self-hosted NIM container:

```bash
# pull the Nemotron NIM container (per NVIDIA NGC instructions), then:
docker run --gpus all \
  -v /path/to/loras:/opt/nim/loras \
  -e NIM_PEFT_SOURCE=/opt/nim/loras \
  -p 8000:8000 \
  <nemotron-nim-image>
```

NIM exposes the same OpenAI-compatible chat-completions API Duevy already uses, at
e.g. `http://<host>:8000/v1`. The adapter is addressable by name.

## (c) Point Duevy at it — `.env` only

```dotenv
# switch from hosted base model to the self-hosted fine-tuned adapter
NVIDIA_BASE_URL="http://<nim-host>:8000/v1"
AI_MODEL="<fine-tuned-adapter-name>"
NVIDIA_API_KEY="<key-if-required-by-your-nim>"
```

Restart the app. No code change: `src/ai/nim.ts` builds the OpenAI client from these
vars, and `AI_MODEL` is passed straight into `chat.completions.create`. The tool
layer, confirmation gate, and backend auth are all unchanged — **the backend remains
the source of truth regardless of which model answers.**

## (d) Rollback — instant

Revert the two env vars to the hosted base model and restart:

```dotenv
NVIDIA_BASE_URL="https://integrate.api.nvidia.com/v1"
AI_MODEL="nvidia/nemotron-3.5-super-vl-120b-a12b"
```

No application redeploy, no data migration — model switching and rollback are pure
configuration. Keep both env profiles handy so you can flip between the hosted base
model and the self-hosted fine-tuned one in seconds.

## Versioning tips

- Treat the adapter name as the version (`duevy-rep-assistant-vN`); keep each
  checkpoint dir so you can mount an older one and flip `AI_MODEL` back.
- Record which `AI_MODEL` + `NVIDIA_BASE_URL` pair is live alongside the evaluation
  run (see [`../evaluation`](../evaluation)) that qualified it.
