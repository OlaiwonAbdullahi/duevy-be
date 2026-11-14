#!/usr/bin/env python3
"""
Dataset validator. Fails (exit 1) on any structural problem, so a bad dataset
can't reach training. Checks every split file for:

  * valid JSON, required keys (messages/tools/meta)
  * message role order (system first; tool messages only after an assistant
    tool_call; assistant tool_calls reference real tools)
  * every tool name used exists in taxonomy.TOOLS (no invented backend ops)
  * mutating tools: a confirmed:true call must be preceded in the same
    conversation by a non-confirmed call OR a clear user "yes" (confirm-first)
  * no date target is a hard-coded calendar date in create_due.due_date
    (must be a relative phrase or deferred — we never memorise dates)
  * no leakage: dedup keys are disjoint across train/val/test

Usage: python validate.py --dir out
"""
from __future__ import annotations
import argparse, json, os, re, sys, hashlib
import taxonomy as T

ISO_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")

def dedup_key(ex):
    fu = next((m["content"] for m in ex["messages"] if m["role"] == "user"), "")
    norm = re.sub(r"\s+", " ", fu.strip().lower())
    return hashlib.sha1(f'{ex["meta"]["category"]}|{norm}'.encode()).hexdigest()

def check_example(ex, errors):
    for key in ("messages", "tools", "meta"):
        if key not in ex:
            errors.append(f"missing key {key}"); return
    msgs = ex["messages"]
    if not msgs or msgs[0]["role"] != "system":
        errors.append("first message must be system")
    # Externally-sourced rows (e.g. xLAM function-calling) intentionally use
    # foreign tool names — exempt them from the Duevy-tool membership check, but
    # still validate structure and JSON args.
    external = bool(ex.get("meta", {}).get("source")) and ex.get("meta", {}).get("category") in {"external_fc"}
    for i, m in enumerate(msgs):
        role = m.get("role")
        if role == "assistant" and m.get("tool_calls"):
            for tc in m["tool_calls"]:
                name = tc["function"]["name"]
                if not external and name not in T.TOOLS:
                    errors.append(f"unknown tool '{name}' (not in taxonomy.TOOLS)")
                # arguments must be valid JSON
                try:
                    args = json.loads(tc["function"]["arguments"])
                except Exception:
                    errors.append(f"tool {name}: arguments not valid JSON"); continue
                # never a hard-coded calendar date as a training target
                if name == "create_due" and ISO_RE.match(str(args.get("due_date", ""))):
                    errors.append("create_due.due_date is a hard-coded ISO date (should be a relative phrase)")
        if role == "tool":
            # a tool result must follow an assistant tool_call
            prev = msgs[i - 1]
            if not (prev.get("role") == "assistant" and prev.get("tool_calls")):
                errors.append("tool message not preceded by an assistant tool_call")

    # confirm-first for mutating tools
    confirmed_calls = [tc for m in msgs if m.get("role") == "assistant" and m.get("tool_calls")
                       for tc in m["tool_calls"]
                       if tc["function"]["name"] in T.TOOLS and T.TOOLS[tc["function"]["name"]]["mutating"]
                       and json.loads(tc["function"]["arguments"]).get("confirmed") is True]
    if confirmed_calls:
        has_user_yes = any(m.get("role") == "user" and re.search(r"\b(yes|yeah|go ahead|proceed|do am|create am|correct|ok(ay)?)\b", m.get("content", ""), re.I) for m in msgs)
        has_unconfirmed_first = any(m.get("role") == "assistant" and m.get("tool_calls") and
                                    any(not json.loads(tc["function"]["arguments"]).get("confirmed") for tc in m["tool_calls"]) for m in msgs)
        if not (has_user_yes or has_unconfirmed_first):
            errors.append("confirmed:true call without a preceding confirmation (summary or user yes)")

def main():
    ap = argparse.ArgumentParser(); ap.add_argument("--dir", default="out"); a = ap.parse_args()
    split_keys, total, total_err = {}, 0, 0
    for split in ("train", "val", "test"):
        path = os.path.join(a.dir, f"{split}.jsonl")
        if not os.path.exists(path):
            print(f"MISSING {path}"); sys.exit(1)
        keys = set()
        with open(path) as f:
            for ln, line in enumerate(f, 1):
                if not line.strip():
                    continue
                total += 1
                ex = json.loads(line)
                errs = []
                check_example(ex, errs)
                keys.add(dedup_key(ex))
                if errs:
                    total_err += len(errs)
                    print(f"  {split}:{ln} {ex.get('meta',{}).get('category','?')}: {'; '.join(errs)}")
        split_keys[split] = keys
    leak = (split_keys["train"] & split_keys["val"]) | (split_keys["train"] & split_keys["test"]) | (split_keys["val"] & split_keys["test"])
    print(f"\nchecked {total} examples across 3 splits")
    print(f"leakage across splits: {len(leak)} overlapping keys")
    print(f"structural errors: {total_err}")
    if total_err or leak:
        print("FAIL"); sys.exit(1)
    print("OK")

if __name__ == "__main__":
    main()
