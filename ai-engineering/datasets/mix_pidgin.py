#!/usr/bin/env python3
"""
Blend the naijaPidgin general-domain corpus into the Duevy agent SFT set so the
model understands Nigerian Pidgin fluently — WITHOUT letting general chat drown
the tool-calling signal.

Source: https://huggingface.co/datasets/ahmadabdulnasir/naijaPidgin
  * format: {"conversations": [{"role","content"}, ...]}  (3893 train / 687 val)
  * general-domain Pidgin: daily life, culture, proverbs, translation, code-switch
  * NO tool calls, NO Duevy domain  → used ONLY as a comprehension/style corpus
  * GATED ("auto"): you must accept the terms on the dataset page AND provide an
    HF token. So this runs at pipeline time, not in the Duevy dev env.

Design (why a cap, not a 1:1 merge):
  The Duevy tool-calling data must stay the DOMINANT learning signal, or the
  model drifts into plain chatting and stops calling tools (catastrophic
  forgetting). So we cap the Pidgin corpus to a ratio of the final mix
  (default ≤30%) and give it its OWN system prompt (a Pidgin tutor, not the
  tool-using Duevy prompt). Its train rows blend into train, its val into val
  (no leakage). Deduplicated by normalized first user turn.

Usage:
  export HF_TOKEN=hf_xxx            # token for an account that accepted the terms
  python mix_pidgin.py --in out --ratio 0.3 --max 1500
  python validate.py --dir out     # validates the mixed files too

Outputs (alongside the Duevy-only files, which are left untouched):
  out/train.mixed.jsonl   out/val.mixed.jsonl   out/mix_stats.json
Point training at the *.mixed.jsonl files (see ../training/lora_config.yaml).
Without a token this DRY-RUNS: it explains the steps and exits 0, fabricating
nothing.
"""
from __future__ import annotations
import argparse, json, os, re, sys, hashlib, urllib.request, urllib.error
from pathlib import Path

REPO = "ahmadabdulnasir/naijaPidgin"
FILES = {"train": "train.jsonl", "val": "val.jsonl"}  # raw JSONL siblings in the repo

# A dedicated system prompt: teach Pidgin comprehension/fluency, NOT tool use.
PIDGIN_SYSTEM = (
    "You are a helpful, friendly assistant who fully understands Nigerian Pidgin "
    "(Naija) and code-switching between Pidgin and English. Understand the user "
    "whether they write in Pidgin, English, or a mix, and reply naturally."
)


def norm(s: str) -> str:
    return re.sub(r"\s+", " ", (s or "").strip().lower())

def dedup_key(ex: dict) -> str:
    fu = next((m["content"] for m in ex["messages"] if m["role"] == "user"), "")
    return hashlib.sha1(f'{ex["meta"]["category"]}|{norm(fu)}'.encode()).hexdigest()


def download(split: str, token: str) -> list[dict]:
    url = f"https://huggingface.co/datasets/{REPO}/resolve/main/{FILES[split]}"
    req = urllib.request.Request(url, headers={"Authorization": f"Bearer {token}"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            raw = r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        print(f"ERROR downloading {split}: HTTP {e.code}. "
              "Confirm your HF token is valid and you ACCEPTED the dataset terms at "
              f"https://huggingface.co/datasets/{REPO}", file=sys.stderr)
        sys.exit(2)
    return [json.loads(l) for l in raw.splitlines() if l.strip()]


def convert(rows: list[dict], split: str) -> list[dict]:
    """naijaPidgin {conversations:[{role,content}]} → our chat format."""
    out = []
    for row in rows:
        convo = row.get("conversations") or row.get("messages") or []
        msgs = [{"role": "system", "content": PIDGIN_SYSTEM}]
        for turn in convo:
            role = turn.get("role", "").lower()
            if role in ("human", "user"):
                role = "user"
            elif role in ("gpt", "assistant", "bot"):
                role = "assistant"
            elif role == "system":
                continue  # we supply our own system prompt
            content = (turn.get("content") or turn.get("value") or "").strip()
            if content:
                msgs.append({"role": role, "content": content})
        # keep only well-formed 2+ turn exchanges that end on the assistant
        if len(msgs) >= 3 and msgs[-1]["role"] == "assistant" and any(m["role"] == "user" for m in msgs):
            out.append({"messages": msgs, "tools": [],
                        "meta": {"category": "pidgin_corpus", "intent": "pidgin_comprehension", "source": "naijaPidgin"}})
    return out


def read_jsonl(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text().splitlines() if l.strip()] if p.exists() else []

def write_jsonl(p: Path, rows: list[dict]) -> None:
    with open(p, "w") as f:
        for r in rows:
            f.write(json.dumps(r, ensure_ascii=False) + "\n")


def cap_count(n_duevy: int, ratio: float, hard_max: int, available: int) -> int:
    # pidgin / (pidgin + duevy) <= ratio  ->  pidgin <= ratio/(1-ratio) * duevy
    by_ratio = int((ratio / (1 - ratio)) * n_duevy) if ratio < 1 else available
    return max(0, min(hard_max, by_ratio, available))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--in", dest="indir", default="out")
    ap.add_argument("--ratio", type=float, default=0.3, help="max pidgin share of the mixed TRAIN set")
    ap.add_argument("--max", type=int, default=1500, help="hard cap on pidgin train examples")
    ap.add_argument("--seed", type=int, default=7)
    args = ap.parse_args()
    import random
    rng = random.Random(args.seed)

    indir = Path(args.indir)
    duevy_train = read_jsonl(indir / "train.jsonl")
    duevy_val = read_jsonl(indir / "val.jsonl")
    if not duevy_train:
        print(f"No {indir}/train.jsonl — run generate.py first.", file=sys.stderr); sys.exit(1)

    token = os.environ.get("HF_TOKEN") or os.environ.get("HUGGINGFACE_TOKEN")
    if not token:
        n = len(duevy_train)
        cap = cap_count(n, args.ratio, args.max, 3893)
        print("DRY-RUN — no HF_TOKEN set, not downloading the gated dataset.")
        print(f"  source: {REPO} (gated 'auto' — accept terms + provide a token)")
        print(f"  Duevy train: {n} examples")
        print(f"  would add up to {cap} Pidgin examples (ratio≤{args.ratio}, hard max {args.max})")
        print(f"  → mixed train ≈ {n + cap} ({cap/(n+cap)*100:.0f}% Pidgin), Duevy stays dominant")
        print("  set HF_TOKEN and re-run to produce out/train.mixed.jsonl + out/val.mixed.jsonl")
        print("  (nothing fabricated; the Duevy-only files are untouched.)")
        return

    # --- download + convert ---
    pid_train = convert(download("train", token), "train")
    pid_val = convert(download("val", token), "val")

    # dedup within pidgin, and against Duevy (shouldn't overlap, but be safe)
    seen = {dedup_key(e) for e in duevy_train} | {dedup_key(e) for e in duevy_val}
    def dedup(rows):
        out = []
        for e in rows:
            k = dedup_key(e)
            if k in seen:
                continue
            seen.add(k); out.append(e)
        return out
    pid_train, pid_val = dedup(pid_train), dedup(pid_val)

    # cap the train share; scale val proportionally
    cap = cap_count(len(duevy_train), args.ratio, args.max, len(pid_train))
    rng.shuffle(pid_train); rng.shuffle(pid_val)
    pid_train = pid_train[:cap]
    val_cap = max(1, int(cap * len(duevy_val) / max(1, len(duevy_train)))) if cap else 0
    pid_val = pid_val[:val_cap]

    mixed_train = duevy_train + pid_train
    mixed_val = duevy_val + pid_val
    rng.shuffle(mixed_train); rng.shuffle(mixed_val)

    # leakage guard across the mixed splits
    ktrain = {dedup_key(e) for e in mixed_train}
    kval = {dedup_key(e) for e in mixed_val}
    assert not (ktrain & kval), "leakage between mixed train and val"

    write_jsonl(indir / "train.mixed.jsonl", mixed_train)
    write_jsonl(indir / "val.mixed.jsonl", mixed_val)
    stats = {
        "duevy_train": len(duevy_train), "duevy_val": len(duevy_val),
        "pidgin_train_added": len(pid_train), "pidgin_val_added": len(pid_val),
        "mixed_train": len(mixed_train), "mixed_val": len(mixed_val),
        "pidgin_share_train": round(len(pid_train) / len(mixed_train), 3),
        "ratio_cap": args.ratio, "hard_max": args.max,
    }
    (indir / "mix_stats.json").write_text(json.dumps(stats, indent=2))
    print("Wrote out/train.mixed.jsonl + out/val.mixed.jsonl")
    print(json.dumps(stats, indent=2))
    print("Point ../training/lora_config.yaml at the *.mixed.jsonl files to train with Pidgin.")


if __name__ == "__main__":
    main()
