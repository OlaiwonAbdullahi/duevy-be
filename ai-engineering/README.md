# Duevy AI Engineering

Everything for making the Duevy assistant a reliable, natural conversational
agent for Nigerian student reps — audit, model report, deterministic utilities,
training datasets, fine-tuning pipeline, evaluation, and deployment/rollback.

The live assistant lives in [`../src/ai`](../src/ai). This directory is the
engineering around it.

## TL;DR — what's real vs. what needs infra

| Piece | Status |
|---|---|
| Deterministic date layer (`src/ai/dates.ts`) + tests + benchmark | ✅ **implemented, runs, passes here** |
| Agent/tooling integration (date passthrough, tz-correct "today") | ✅ **implemented, tests green** |
| Audit + model-compatibility report | ✅ written (`docs/`) |
| Training dataset generator + validator + generated data | ✅ **runs here** (`datasets/`) |
| Model eval harness | ✅ **runs here** (dry-run without a key; scores with one) |
| LoRA fine-tuning pipeline (NeMo AutoModel) | ⏸ **prepared, needs 8×80GB GPUs** (`training/`) |
| Serving a fine-tuned model | ⏸ **needs self-hosted NIM** (`docs/deployment.md`) |

No training run or benchmark score is claimed to have happened. Numbers that
require a real run are marked **"to be measured."**

## Why this shape (the senior call)

The base model — **NVIDIA Nemotron 3.5 Super VL 120B-A12B** — already handles
Nigerian English, slang, typos and multi-turn well. The reliability that
actually matters for a money app (dates, amounts, confirmation, auth) **must be
deterministic**, so it lives in code and is enforced by the backend, not learned
by weights. Fine-tuning is therefore *optional polish*, not the fix — see
[`docs/model-compatibility.md`](docs/model-compatibility.md). The full pipeline
is provided because it was requested; the deterministic layer is where the
guaranteed wins are.

## Layout

```
ai-engineering/
  docs/
    architecture.md          # current AI architecture (from the audit)
    model-compatibility.md   # verified model + fine-tuning report, recommendation
    dataset-inventory.md     # researched external datasets + licenses + recommendation
    limitations.md           # known limits & design choices
    deployment.md            # train → serve → integrate → rollback
  datasets/
    taxonomy.py  generate.py  validate.py   out/{train,val,test}.jsonl
    mix_pidgin.py            # blend naijaPidgin (Pidgin comprehension, capped)
    mix_external.py          # blend xLAM function-calling (capped, CC-BY)
  rag/                       # Duevy knowledge base (chunk → embed → retrieve, attributed)
  training/
    lora_config.yaml  train.sh  requirements.txt
  evaluation/
    eval_dates.ts            # deterministic date benchmark (runs here)
    eval_model.py            # model benchmark (dry-run without a key)
    benchmark.jsonl          # curated held-out cases incl. the date regression
```

## Reproduce end to end

```bash
# 1. Deterministic date layer — unit tests + benchmark (no GPU, no model)
npx vitest run src/ai/dates.test.ts src/ai/tools.test.ts
npx tsx ai-engineering/evaluation/eval_dates.ts        # 15/15 required cases

# 2. Datasets — generate + validate
cd ai-engineering/datasets
python generate.py --out out --seed 7 --target 4000
python validate.py --dir out
cd ../..

# 3. Model eval — baseline (needs an NVIDIA key to score; dry-runs otherwise)
NVIDIA_API_KEY=$KEY python ai-engineering/evaluation/eval_model.py \
  --model "nvidia/nemotron-3.5-super-vl-120b-a12b" \
  --base-url https://integrate.api.nvidia.com/v1 \
  --out ai-engineering/evaluation/reports/baseline.json

# 4. Fine-tune (on an 8×80GB GPU node — see docs/deployment.md)
cd ai-engineering/training && ./train.sh lora_config.yaml

# 5. Serve the adapter via NIM, then eval the fine-tuned model and diff vs. baseline
NVIDIA_API_KEY=$KEY python ai-engineering/evaluation/eval_model.py \
  --model "duevy-lora-adapter" --base-url http://localhost:8000/v1 \
  --out ai-engineering/evaluation/reports/finetuned.json
```

## Integration & rollback (no app code change)

Model selection is env-driven in [`src/ai/nim.ts`](../src/ai/nim.ts):
`AI_MODEL` + `NVIDIA_BASE_URL`. Point them at a self-hosted NIM to use the
fine-tuned adapter; revert them to the hosted endpoint to roll back instantly.
The backend stays the source of truth either way. Details in
[`docs/deployment.md`](docs/deployment.md).
