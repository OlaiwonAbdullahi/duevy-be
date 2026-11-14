# Model Compatibility & Fine-Tuning Report

Verified assessment of the model Duevy runs today and what fine-tuning it actually
requires. Figures that would require a training run or a benchmark we have not run
are marked **to be measured**.

## The model

**NVIDIA Nemotron 3.5 Super VL 120B-A12B**

| Property | Value |
| --- | --- |
| Released | 2026-10-15 |
| Weights | Open, under the **OpenMDW** license (commercial use, fine-tuning, redistribution) |
| Architecture | Mixture-of-Experts, **~121B total / ~12B active** params |
| Modality | Multimodal — text, image, video |
| Context window | **1M tokens** |
| Quantization | NVFP4 build ≈ **75 GB** weights; BF16 variant also published |
| Tool/function calling | Supported (used today via the OpenAI-compatible chat-completions API) |
| Served in Duevy via | Hosted NIM endpoint `integrate.api.nvidia.com/v1` (`src/ai/nim.ts`, `AI_MODEL` env var) |

Duevy currently consumes it as a **hosted inference endpoint** — no weights are
downloaded, no GPUs are owned.

## Fine-tuning support

The model is fine-tunable through **NVIDIA NeMo AutoModel**, which ships official
recipes for this exact model:

| Method | Supported | Notes |
| --- | --- | --- |
| Full SFT | ✅ | Tulu-3 recipe runs on **4 nodes** |
| LoRA | ✅ | Reference recipe runs **single-node, 8× 80 GB GPU** |
| QLoRA | ✅ (PEFT family) | Quantized LoRA; lowers VRAM at some quality cost — **to be measured** for this task |

- **Framework:** NeMo AutoModel (training) + PEFT adapters.
- **Hardware floor:** LoRA needs one node of **8× 80 GB** GPUs (H100/A100-class);
  full SFT needs **4 nodes**. Neither is available in the Duevy dev environment.
- **VRAM / throughput for our dataset:** **to be measured** on target hardware.

## Serving a fine-tuned model

Key constraint: **you cannot upload a custom adapter to the hosted
`integrate.api.nvidia.com` endpoint.** NVIDIA documents self-hosted serving only.

To serve a fine-tuned variant you **self-host a NIM container**:

- Mount the LoRA adapter directory and point NIM at it:
  `NIM_PEFT_SOURCE=/opt/nim/loras`.
- NIM exposes the same OpenAI-compatible chat-completions API, so Duevy's client
  code is unchanged — only `AI_MODEL` and `NVIDIA_BASE_URL` change.

See [deployment.md](./deployment.md) for the full train → serve → integrate → roll
back path.

## Inference options summary

| Option | Pros | Cons |
| --- | --- | --- |
| Hosted `integrate.api.nvidia.com` (today) | Zero infra, instant, base model is strong | No custom adapters |
| Self-hosted NIM + LoRA | Custom behaviour, data stays in-house | Owns/pays for 80 GB-class GPUs, ops burden |

## Recommendation

For a **tool-calling assistant over a REST backend**, the reliability that matters —
dates, money, confirmation, authorization — is best handled by **deterministic
code**, not model weights:

- Dates: `src/ai/dates.ts` (unit-tested, timezone-correct).
- Money: `src/lib/money.ts` (naira ↔ kobo, fees).
- Confirmation + auth: the `confirmed` gate and scoped JWT in `src/ai/tools.ts` /
  `identity.ts`; the backend stays the source of truth.

A frontier instruct model already handles Nigerian English, slang, typos and
multi-turn phrasing well, so **fine-tuning is optional** for this use case and its
main cost is the serving infra above. That said — the user opted into the full
fine-tuning push, so the complete, runnable LoRA pipeline (dataset generation,
config, training, evaluation) is provided under
[`../training`](../training) and [`../datasets`](../datasets); expected accuracy
deltas vs. the base model are **to be measured** once a run completes.

## Sources

- NeMo AutoModel model coverage — Nemotron 3.5 Super VL 120B-A12B (BF16):
  <https://docs.nvidia.com/nemo/automodel/model-coverage/omni/nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16.md>
- NIM — Fine-Tuning with LoRA:
  <https://docs.nvidia.com/nim/large-language-models/2.1.4/advanced-use-cases/finetune-lora.html>
- NIM — Parameter-Efficient Fine-Tuning (PEFT):
  <https://docs.nvidia.com/nim/large-language-models/1.4.0/peft.html>
- build.nvidia.com — Nemotron Super 120B-A12B:
  <https://build.nvidia.com/nvidia/nemotron-3-super-120b-a12b>
