# External Dataset Inventory & Recommendation

Research into publicly available datasets for the Duevy agent, with **verified
licenses** (checked against each Hugging Face dataset card's `license` field, not
secondary blogs) and an honest call on what's actually worth training on.

> **Thesis: relevance + clean license + right task-shape beats volume.** Duevy's
> own generated tool-calling data (`../datasets/out/`) is the backbone. We blend
> in only a *capped* slice of license-clean **function-calling** data (to harden
> tool-use) and *capped* **Pidgin** data (comprehension). We deliberately do
> **not** pour in general-instruction, US-finance, or numerical-reasoning
> corpora — they don't match the task and cause drift (the brief's explicit
> warning against padding with irrelevant financial/medical/coding/general data).

## Inventory

| Dataset | Source | Examples | Lang | License | SFT suitability | Relevance to Duevy | Integration status |
|---|---|---|---|---|---|---|---|
| **xLAM function-calling-60k** | [Salesforce/xlam-function-calling-60k](https://huggingface.co/datasets/Salesforce/xlam-function-calling-60k) | ~60k | en | **CC-BY-4.0** (commercial ✅, attribution) | High — verified function-calling w/ schemas | **High** — same task shape (intent→tool+args) | **Recommended (capped)** — normalizer in `../datasets/mix_external.py` |
| **Glaive function-calling v2** | [glaiveai/glaive-function-calling-v2](https://huggingface.co/datasets/glaiveai/glaive-function-calling-v2) | 100k–1M | en | **Apache-2.0** (✅) | Medium — large, synthetic, noisier | Medium — tool-use format, generic domain | Optional alt (capped) — pick ONE fc set |
| **Hermes function-calling v1** | [NousResearch/hermes-function-calling-v1](https://huggingface.co/datasets/NousResearch/hermes-function-calling-v1) | 10k–100k | en | **Apache-2.0** (✅) | Medium–High — multi-turn + tool results | Medium — good multi-turn tool patterns | Optional alt (capped) |
| **naijaPidgin** | [ahmadabdulnasir/naijaPidgin](https://huggingface.co/datasets/ahmadabdulnasir/naijaPidgin) | 3,893 / 687 | pcm/en (+ha/ig/yo tags) | **UNSPECIFIED** — gated `auto`, no `license` on card ⚠️ | Medium — general-domain Pidgin chat, no tools | **High** — Pidgin comprehension | **Built (capped ≤30%)** via `../datasets/mix_pidgin.py` — *commercial use pending license confirmation with author* |
| MAFAND-MT | [masakhane/mafand](https://huggingface.co/datasets/masakhane/mafand) | ~ per-pair | pcm/en +many | **CC-BY-NC-4.0** ❌ non-commercial | — | High (Pidgin↔En MT) | **Eval only** (NC blocks commercial training) |
| MasakhaNEWS | [masakhane/masakhanews](https://huggingface.co/datasets/masakhane/masakhanews) | per-lang | pcm/ha/ig/yo/en +more | **AFL-3.0** (✅) | Low — news classification, not tool-use | Low–Med (Pidgin/NG text exposure) | Eval / aux comprehension only |
| finance-alpaca | [gbharti/finance-alpaca](https://huggingface.co/datasets/gbharti/finance-alpaca) | 10k–100k | en | **MIT** (✅) | Low for us — generic finance Q&A, no tools | **Low** — US/markets, not fintech ops | **Rejected** — irrelevant, drift risk |
| FinQA / ConvFinQA | [czyssrs/FinQA](https://github.com/czyssrs/FinQA) · [AdaptLLM/ConvFinQA](https://huggingface.co/datasets/AdaptLLM/ConvFinQA) | ~8k / ~3.9k | en | MIT / CDLA-Perm (verify repo) | Low for us — numerical reasoning over SEC filings | **Very low** | **Rejected** — wrong domain & task |
| Tulu-3 SFT mix | [allenai/tulu-3-sft-mixture](https://huggingface.co/datasets/allenai/tulu-3-sft-mixture) | ~1M | en+ | **ODC-BY** w/ **CC-BY-NC** components ⚠️ | High general, but mixed licenses | Low (general chat) | **Rejected** — license risk + drift |
| OpenHermes 2.5 | [teknium/OpenHermes-2.5](https://huggingface.co/datasets/teknium/OpenHermes-2.5) | ~1M | en | mixed / synthetic (ShareGPT-derived) | High general | Low (general chat) | **Rejected** — license ambiguity + drift |

(“Examples” are the dataset cards' figures / size-category tags; confirm exact
counts on each card before a run.)

## Recommended combination (quality + relevance, not volume)

Train on, in this priority order, with the **Duevy generated set as the majority**:

1. **Duevy generated tool-calling set** — `../datasets/out/*.jsonl` (the backbone; ~1,834 train).
2. **xLAM function-calling-60k**, *down-sampled & capped* (e.g. ≤400 examples, ≤~15% of the mix) — hardens generic tool-selection/argument-formatting. **CC-BY-4.0 → keep attribution.** Normalize with `mix_external.py` (schema → our chat format).
3. **naijaPidgin**, *capped ≤30%* — Pidgin comprehension (already wired via `mix_pidgin.py`). **Resolve the license with the author before commercial training.**

Everything else is **eval-only or rejected**. Rationale:
- Adding Glaive *and* xLAM *and* Hermes is redundant — pick **one** function-calling set; xLAM is the cleanest (verified schemas, CC-BY). Use Hermes instead only if you want more multi-turn tool-result patterns.
- US-finance / numerical-reasoning sets (finance-alpaca, FinQA) are off-domain for Nigerian student-dues operations and would teach the model nothing it needs while risking drift.
- NC-licensed Pidgin MT (MAFAND) is excellent for **evaluation** of Pidgin↔English understanding but cannot be used for commercial training.

## Normalization & attribution

- All external data is normalized to our chat format (`{messages, tools, meta}`) and tagged `meta.source` for provenance; `mix_pidgin.py` and `mix_external.py` apply dedup + a leakage guard + a ratio cap.
- **Attribution to preserve** on release: xLAM (Salesforce, CC-BY-4.0), naijaPidgin (ahmadabdulnasir), plus any eval sets used (MAFAND/MasakhaNEWS — Masakhane).
- **Do not** mix any CC-BY-NC or license-unclear data into a commercially trained model. naijaPidgin's missing license is tracked as an open item.

## Open license items to resolve before commercial training
- [ ] **naijaPidgin** — no license on the card; confirm commercial permission with the author (or drop to eval-only).
- [ ] **xLAM** — CC-BY-4.0 requires attribution in the model/dataset release notes.
- [ ] Verify FinQA/ConvFinQA repo LICENSE files *only if* you reconsider them (not recommended).
