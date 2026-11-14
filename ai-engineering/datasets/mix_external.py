#!/usr/bin/env python3
"""
Normalize an external, license-clean FUNCTION-CALLING dataset into the Duevy
chat format and blend it in (capped), to harden generic tool selection /
argument formatting. The Duevy generated set stays the dominant signal.

Default source (top pick in ../docs/dataset-inventory.md):
  Salesforce/xlam-function-calling-60k  — CC-BY-4.0 (commercial OK, ATTRIBUTION
  REQUIRED), schema: {query, tools, answers}. Gated 'auto' → needs an HF token
  and accepting the terms. So this runs at pipeline time, not in the dev env.

Why capped: adding too much generic tool-calling data dilutes Duevy's domain
(departments, dues, confirm-first, Pidgin). Default ≤15% of the mixed train set.

Normalization (xLAM → ours):
  query   -> user message
  tools   -> our `tools` list (names only; we only train selection+args shape)
  answers -> assistant tool_calls  [{name, arguments}]  ->  one assistant turn

Composable with mix_pidgin.py: both read the current base (train.mixed.jsonl if
it exists, else train.jsonl) so you can run external then pidgin (or vice-versa)
and accumulate. Ratio is computed against that base.

Usage:
  export HF_TOKEN=hf_xxx
  python mix_external.py --dataset xlam --ratio 0.15 --max 400
  python validate.py --dir out

Without a token this DRY-RUNS and fabricates nothing.
"""
from __future__ import annotations
import argparse, json, os, re, sys, hashlib, urllib.request, urllib.error, urllib.parse
from pathlib import Path

PRESETS = {
    "xlam": {
        "repo": "Salesforce/xlam-function-calling-60k",
        "config": "default", "split": "train",
        "source_tag": "xlam-function-calling-60k",
        "license": "CC-BY-4.0 (attribution required)",
    },
}
SYSTEM_FC = (
    "You are a function-calling assistant. Given the user's request and the "
    "available tools, call the right tool(s) with correct arguments."
)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def dedup_key(ex: dict) -> str:
    fu = next((m["content"] for m in ex["messages"] if m["role"] == "user"), "")
    return hashlib.sha1(f'{ex["meta"]["category"]}|{norm(fu)}'.encode()).hexdigest()

def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []

def write_jsonl(p: Path, rows: list[dict]) -> None:
    with open(p, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def fetch_rows(preset: dict, token: str, want: int) -> list[dict]:
    """Page the authenticated datasets-server rows API (JSON, no parquet deps)."""
    base = "https://datasets-server.huggingface.co/rows"
    out, offset, PAGE = [], 0, 100
    while len(out) < want:
        url = (f"{base}?dataset={urllib.parse.quote(preset['repo'])}"
               f"&config={preset['config']}&split={preset['split']}"
               f"&offset={offset}&length={PAGE}")
        req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
        try:
            with urllib.request.urlopen(req, timeout=60) as r:
                data = json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            print(f"ERROR: HTTP {e.code} fetching rows. Confirm your HF token is valid and "
                  f"you accepted the terms at https://huggingface.co/datasets/{preset['repo']}", file=sys.stderr)
            sys.exit(2)
        rows = data.get("rows", [])
        if not rows:
            break
        out.extend(r["row"] for r in rows)
        offset += PAGE
    return out[:want]


def _as_obj(v):
    if isinstance(v, (list, dict)):
        return v
    try:
        return json.loads(v)
    except Exception:
        return None


def normalize_xlam(rows: list[dict], source_tag: str) -> list[dict]:
    out = []
    for row in rows:
        query = (row.get("query") or "").strip()
        tools = _as_obj(row.get("tools")) or []
        answers = _as_obj(row.get("answers")) or []
        if not query or not isinstance(answers, list) or not answers:
            continue
        tool_names = [t.get("name") for t in tools if isinstance(t, dict) and t.get("name")]
        tool_calls = []
        for a in answers:
            if not isinstance(a, dict) or not a.get("name"):
                continue
            tool_calls.append({"type": "function", "function": {
                "name": a["name"], "arguments": json.dumps(a.get("arguments", {}), ensure_ascii=False)}})
        if not tool_calls:
            continue
        out.append({
            "messages": [
                {"role": "system", "content": SYSTEM_FC},
                {"role": "user", "content": query},
                {"role": "assistant", "tool_calls": tool_calls},
            ],
            "tools": [{"type": "function", "function": {"name": n}} for n in tool_names] or
                     [{"type": "function", "function": {"name": tc["function"]["name"]}} for tc in tool_calls],
            "meta": {"category": "external_fc", "intent": "function_call", "source": source_tag},
        })
    return out


def cap_count(n_base: int, ratio: float, hard_max: int, available: int) -> int:
    by_ratio = int((ratio / (1 - ratio)) * n_base) if ratio < 1 else available
    return max(0, min(hard_max, by_ratio, available))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dataset", choices=list(PRESETS), default="xlam")
    ap.add_argument("--in", dest="indir", default="out")
    ap.add_argument("--ratio", type=float, default=0.15)
    ap.add_argument("--max", type=int, default=400)
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    import random
    rng = random.Random(args.seed)
    preset = PRESETS[args.dataset]

    indir = Path(args.indir)
    # Compose: prefer an existing mixed base so external + pidgin accumulate.
    base_train_p = indir / ("train.mixed.jsonl" if (indir / "train.mixed.jsonl").exists() else "train.jsonl")
    base_val_p = indir / ("val.mixed.jsonl" if (indir / "val.mixed.jsonl").exists() else "val.jsonl")
    base_train, base_val = read_jsonl(base_train_p), read_jsonl(base_val_p)
    if not base_train:
        print(f"No base train set in {indir} — run generate.py first.", file=sys.stderr); sys.exit(1)

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    cap = cap_count(len(base_train), args.ratio, args.max, 60000)
    if not token:
        print(f"DRY-RUN — no HF_TOKEN set, not downloading {preset['repo']} (gated).")
        print(f"  license: {preset['license']}  (preserve attribution on release)")
        print(f"  base train: {len(base_train)} (from {base_train_p.name})")
        print(f"  would add up to {cap} normalized function-calling examples "
              f"(ratio≤{args.ratio}, hard max {args.max})")
        print(f"  → mixed train ≈ {len(base_train)+cap} ({cap/(len(base_train)+cap)*100:.0f}% external)")
        print("  set HF_TOKEN + accept the dataset terms, then re-run.")
        return

    # oversample a bit to survive dedup/normalization drops
    raw = fetch_rows(preset, token, want=min(60000, cap * 4 + 50))
    norm_rows = normalize_xlam(raw, preset["source_tag"])
    # dedup within + against base
    seen = {dedup_key(e) for e in base_train} | {dedup_key(e) for e in base_val}
    uniq = []
    for e in norm_rows:
        k = dedup_key(e)
        if k in seen:
            continue
        seen.add(k); uniq.append(e)
    rng.shuffle(uniq)
    add_train = uniq[:cap]
    # small held-out slice into val (10%)
    n_val = max(1, int(cap * 0.1)) if cap else 0
    add_val = uniq[cap:cap + n_val]

    mixed_train = base_train + add_train
    mixed_val = base_val + add_val
    rng.shuffle(mixed_train); rng.shuffle(mixed_val)
    ktr, kva = {dedup_key(e) for e in mixed_train}, {dedup_key(e) for e in mixed_val}
    assert not (ktr & kva), "leakage between mixed train and val"

    write_jsonl(indir / "train.mixed.jsonl", mixed_train)
    write_jsonl(indir / "val.mixed.jsonl", mixed_val)
    stats = {"source": preset["source_tag"], "license": preset["license"],
             "base_train": len(base_train), "added_train": len(add_train), "added_val": len(add_val),
             "mixed_train": len(mixed_train), "external_share_train": round(len(add_train) / len(mixed_train), 3)}
    prev = {}
    sp = indir / "mix_stats.json"
    if sp.exists():
        try: prev = json.loads(sp.read_text())
        except Exception: prev = {}
    prev["external_fc"] = stats
    sp.write_text(json.dumps(prev, indent=2))
    print("Wrote out/train.mixed.jsonl + out/val.mixed.jsonl")
    print(json.dumps(stats, indent=2))
    print("Attribution required on release:", preset["license"])


if __name__ == "__main__":
    main()
