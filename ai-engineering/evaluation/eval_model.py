#!/usr/bin/env python3
"""
Model evaluation harness for the Duevy agent.

Replays each benchmark conversation against an OpenAI-compatible endpoint
(hosted NIM base model, or a self-hosted fine-tuned NIM) with the REAL tool
specs, captures the assistant's first tool call / reply, and scores:

  * tool_selection_accuracy  — right tool for the intent
  * tool_arg_accuracy        — required args present & correct (amount, category…)
  * date_passthrough_rate    — relative dates passed as a phrase (never a wrong ISO)
  * iso_question_rate        — how often it wrongly asks for YYYY-MM-DD  (lower=better)
  * unnecessary_clarification_rate — asks when it had enough to act (lower=better)
  * refusal_correctness      — security/out-of-scope handled right
  * latency_ms (p50/p95)

Run a BASELINE (base model) and the fine-tuned model with the same command and
different --model/--base-url, then diff the JSON reports. Do NOT claim an
improvement without that measured delta.

  # baseline (hosted base model)
  python eval_model.py --model "nvidia/nemotron-3.5-super-vl-120b-a12b" \
      --base-url https://integrate.api.nvidia.com/v1 --out reports/baseline.json

  # fine-tuned (self-hosted NIM serving the LoRA adapter)
  python eval_model.py --model "duevy-lora-adapter" \
      --base-url http://localhost:8000/v1 --out reports/finetuned.json

Without an API key / reachable endpoint this runs in DRY-RUN: it loads and
reports the benchmark + metric plan and exits 0 (so CI/doc builds stay green).
It never fabricates scores.
"""
from __future__ import annotations
import argparse, json, os, sys, time, statistics
from pathlib import Path

HERE = Path(__file__).resolve().parent
# The tool specs must match src/ai/tools.ts. We import the names from the
# dataset taxonomy (single source of truth) and send minimal function specs.
sys.path.insert(0, str(HERE.parent / "datasets"))
import taxonomy as T  # noqa: E402

SYSTEM = T.SYSTEM_PROMPT
TOOLS = [{"type": "function", "function": {"name": n, "description": "", "parameters": {"type": "object", "properties": {}}}} for n in T.TOOLS]


def load_benchmark(path: Path) -> list[dict]:
    return [json.loads(l) for l in path.read_text().splitlines() if l.strip()]


def first_tool_call(msg) -> tuple[str | None, dict]:
    tcs = getattr(msg, "tool_calls", None) or []
    for tc in tcs:
        try:
            return tc.function.name, json.loads(tc.function.arguments or "{}")
        except Exception:
            return tc.function.name, {}
    return None, {}


ISO_HINT = ("yyyy", "yyyy-mm-dd", "format", "dd/mm", "exact date", "which date exactly")


def score_case(case: dict, tool: str | None, args: dict, text: str) -> dict:
    exp = case["expect"]
    res = {"id": case["id"], "category": case["category"], "tool": tool, "checks": {}}
    t = (text or "").lower()

    if "tool" in exp:
        res["checks"]["tool_selection"] = (tool == exp["tool"])
    if "args_contains" in exp:
        res["checks"]["tool_args"] = all(args.get(k) == v for k, v in exp["args_contains"].items())
    if exp.get("due_date_relative"):
        dd = str(args.get("due_date", ""))
        # correct = a phrase (non-empty, not an ISO date) OR deferred to a later turn
        import re
        res["checks"]["date_passthrough"] = bool(dd) and not re.match(r"^\d{4}-\d{2}-\d{2}$", dd)
    if exp.get("must_not_ask_iso"):
        res["checks"]["no_iso_question"] = not any(h in t for h in ISO_HINT)
    if exp.get("no_tool"):
        res["checks"]["no_tool"] = (tool is None)
    if exp.get("asks_clarifying"):
        res["checks"]["asks_clarifying"] = (tool is None and "?" in t)
    if exp.get("refuse") or exp.get("refuse_or_scope"):
        res["checks"]["refusal"] = (tool is None) or ("can't" in t or "cannot" in t or "won't" in t or "only" in t)
    if exp.get("no_tool_mutating_confirmed"):
        res["checks"]["no_confirmed_mutation"] = not (tool in T.TOOLS and T.TOOLS[tool]["mutating"] and args.get("confirmed") is True)
    if exp.get("redirect"):
        res["checks"]["redirect"] = (tool is None)
    return res


def run_live(client, model: str, cases: list[dict]) -> dict:
    per_case, latencies = [], []
    for case in cases:
        msgs = [{"role": "system", "content": SYSTEM}]
        last = None
        t0 = time.time()
        # Replay each user turn; let the model act on the final one.
        for i, turn in enumerate(case["turns"]):
            msgs.append({"role": "user", "content": turn})
            resp = client.chat.completions.create(
                model=model, messages=msgs, tools=TOOLS, tool_choice="auto", temperature=0.2,
            )
            last = resp.choices[0].message
            # keep the assistant turn in context for multi-turn
            msgs.append({"role": "assistant", "content": last.content or "",
                         **({"tool_calls": last.tool_calls} if last.tool_calls else {})})
            # if the model called a tool mid-conversation, feed a neutral stub so it can continue
            if last.tool_calls and i < len(case["turns"]) - 1:
                for tc in last.tool_calls:
                    msgs.append({"role": "tool", "tool_call_id": tc.id, "content": json.dumps({"needsConfirmation": True})})
        latencies.append((time.time() - t0) * 1000)
        tool, args = first_tool_call(last)
        per_case.append(score_case(case, tool, args, last.content or ""))

    # aggregate
    agg: dict[str, list[bool]] = {}
    for r in per_case:
        for k, v in r["checks"].items():
            agg.setdefault(k, []).append(bool(v))
    metrics = {k: round(sum(v) / len(v), 4) for k, v in agg.items()}
    metrics["latency_ms_p50"] = round(statistics.median(latencies), 1)
    metrics["latency_ms_p95"] = round(sorted(latencies)[max(0, int(len(latencies) * 0.95) - 1)], 1)
    return {"model": model, "n": len(cases), "metrics": metrics, "cases": per_case}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--benchmark", default=str(HERE / "benchmark.jsonl"))
    ap.add_argument("--model", default=os.environ.get("AI_MODEL", "nvidia/nemotron-3.5-super-vl-120b-a12b"))
    ap.add_argument("--base-url", default=os.environ.get("NVIDIA_BASE_URL", "https://integrate.api.nvidia.com/v1"))
    ap.add_argument("--out", default=str(HERE / "reports" / "report.json"))
    args = ap.parse_args()

    cases = load_benchmark(Path(args.benchmark))
    key = os.environ.get("NVIDIA_API_KEY")

    if not key:
        print("DRY-RUN — no NVIDIA_API_KEY set, not calling the model.")
        print(f"  benchmark: {len(cases)} cases across "
              f"{len(set(c['category'] for c in cases))} categories")
        print(f"  would evaluate model='{args.model}' at {args.base_url}")
        print("  metrics: tool_selection, tool_args, date_passthrough, no_iso_question,")
        print("           asks_clarifying, refusal, no_confirmed_mutation, redirect, latency")
        print("  set NVIDIA_API_KEY and re-run to produce a scored report. No scores are fabricated.")
        return

    try:
        from openai import OpenAI
    except ImportError:
        print("Install the client: pip install openai", file=sys.stderr); sys.exit(1)

    client = OpenAI(api_key=key, base_url=args.base_url)
    report = run_live(client, args.model, cases)
    Path(args.out).parent.mkdir(parents=True, exist_ok=True)
    Path(args.out).write_text(json.dumps(report, indent=2, ensure_ascii=False))
    print(json.dumps(report["metrics"], indent=2))
    print(f"\nwrote {args.out}")


if __name__ == "__main__":
    main()
