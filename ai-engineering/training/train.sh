#!/usr/bin/env bash
# Launch the Duevy agent LoRA fine-tune on a single 8× 80GB GPU node.
#
# PREREQUISITES (none of which exist in the Duevy dev environment — this is why
# training is prepared, not executed here):
#   * 1 node, 8× NVIDIA 80GB GPUs (H100/A100), CUDA + recent driver
#   * NeMo AutoModel installed (see requirements.txt / NeMo container)
#   * Base weights pulled: nvidia/NVIDIA-Nemotron-3.5-Super-VL-120B-A12B-BF16
#     (HuggingFace, OpenMDW license)
#   * Dataset generated + validated:
#       cd ../datasets && python generate.py --out out && python validate.py --dir out
#
# Recommended: run inside NVIDIA's NeMo container for pinned CUDA/driver deps.
set -euo pipefail
cd "$(dirname "$0")"

CONFIG="${1:-lora_config.yaml}"

echo "==> Validating dataset before training"
( cd ../datasets && python validate.py --dir out )

echo "==> Checking GPUs"
if ! command -v nvidia-smi >/dev/null 2>&1; then
  echo "ERROR: no nvidia-smi. This run needs an 8× 80GB GPU node." >&2
  echo "       Prepare the pipeline here; run it on GPU infra. See docs/deployment.md." >&2
  exit 2
fi
nvidia-smi --query-gpu=index,name,memory.total --format=csv,noheader

echo "==> Starting NeMo AutoModel LoRA fine-tune ($CONFIG)"
# The exact entrypoint depends on your NeMo AutoModel version; the canonical
# form is a torchrun launch of the finetune recipe with this config. Example:
torchrun --nproc_per_node=8 \
  -m nemo_automodel.recipes.llm.finetune \
  --config "$CONFIG"

echo "==> Done. Adapter exported to ./checkpoints/duevy-lora-adapter"
echo "    Next: serve it with NIM (NIM_PEFT_SOURCE) and evaluate — see docs/deployment.md"
