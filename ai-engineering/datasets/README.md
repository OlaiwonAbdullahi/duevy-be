# Duevy agent — training datasets

Synthetic, **programmatically generated** supervised-fine-tuning data for the
Duevy assistant. Generation is combinatorial and seeded, so it is reproducible
and grows as you add templates — not a hand-written pile of near-duplicates.

## Files

| File | What it is |
|---|---|
| `taxonomy.py` | Single source of truth: the real 25 tools (mirrors `src/ai/tools.ts`), real due categories, Nigerian slang/date maps, the 12 categories + target proportions, and the system prompt. |
| `generate.py` | Builds examples per category up to its target proportion, dedups by normalized first user turn, splits train/val/test (stratified, no leakage). |
| `validate.py` | Fails CI on any structural problem (bad schema, invented tool, hard-coded date target, broken confirm-first, cross-split leakage). |
| `out/` | Generated `train.jsonl` / `val.jsonl` / `test.jsonl` + `stats.json`. |

## Reproduce

```bash
cd ai-engineering/datasets
python generate.py --out out --seed 7 --target 4000
python validate.py --dir out
```

`--target` is an *upper bound per category* (via the proportions in `taxonomy.py`).
Categories whose template space is smaller fill what they can and the run prints
an **honest shortfall** list — grow them by adding templates/slots, not repeats.

## Blending external data (optional, capped)

See [`../docs/dataset-inventory.md`](../docs/dataset-inventory.md) for the full
researched inventory + licenses. Two normalizers blend license-clean external
data into capped `*.mixed.jsonl` files (the Duevy set stays dominant). Both are
**gated** (need an HF token + accepting the dataset's terms) and **dry-run**
without one — nothing is fabricated or downloaded.

```bash
export HF_TOKEN=hf_xxx
# Nigerian Pidgin comprehension (naijaPidgin), capped ≤30%
python mix_pidgin.py   --in out --ratio 0.3  --max 1500
# Generic function-calling robustness (xLAM, CC-BY-4.0), capped ≤15%
python mix_external.py --dataset xlam --ratio 0.15 --max 400
python validate.py --dir out          # validates the mixed files too
```

They compose (run either order) and write `out/train.mixed.jsonl` /
`out/val.mixed.jsonl` + `out/mix_stats.json`. Point training at the mixed files
(`../training/lora_config.yaml`). **Preserve attribution** for any external
source used (xLAM = Salesforce/CC-BY-4.0; naijaPidgin = ahmadabdulnasir).

## Format (one JSON object per line)

```json
{
  "messages": [
    {"role": "system", "content": "..."},
    {"role": "user", "content": "Abeg create 2k due for everybody in CSC, make dem pay before next Friday"},
    {"role": "assistant", "tool_calls": [{"type": "function", "function": {"name": "create_due", "arguments": "{\"title\":\"CSC Departmental Due\",\"amount_naira\":2000,\"due_date\":\"next friday\",\"category\":\"departmental_due\"}"}}]},
    {"role": "tool", "name": "create_due", "content": "{\"needsConfirmation\":true,...}"},
    {"role": "assistant", "content": "Summary: ... Create it?"},
    {"role": "user", "content": "yes"},
    {"role": "assistant", "tool_calls": [{"type": "function", "function": {"name": "create_due", "arguments": "{...,\"confirmed\":true}"}}]},
    {"role": "tool", "name": "create_due", "content": "{\"created\":{...},\"payLink\":\"...\"}"},
    {"role": "assistant", "content": "Done ✅ Share this link: ..."}
  ],
  "tools": [{"type": "function", "function": {"name": "create_due"}}],
  "meta": {"category": "tool_calling", "intent": "create_due"}
}
```

## Invariants the data teaches (and `validate.py` enforces)

- **Dates are passed through as phrases** (`due_date: "next friday"`), never as a
  baked ISO date. `src/ai/dates.ts` resolves them deterministically at runtime —
  the model must not learn calendar arithmetic.
- **Confirm-first**: a `confirmed:true` call on a mutating tool only appears
  after a summary call and a clear user "yes".
- **Only real tools** — every tool name must exist in `taxonomy.TOOLS`.
- **Backend is the source of truth** — assistant replies state only what a tool
  returned; no fabricated balances, links or counts.
