#!/usr/bin/env python3
"""Aggregate normalized switchyard routing logs fetched by collect.sh.

Deterministic rollup of collected/**/routing.jsonl by repo / task_label /
route, with cost estimation against scripts/prices.yaml. Writes summary.json
and prints a table. With --ai-report, sends the rollup (never the raw log)
to an OpenAI-compatible endpoint for a written report.

Environment for --ai-report:
  REPORT_MODEL_BASE_URL  e.g. https://api.fireworks.ai/inference/v1
  REPORT_MODEL           e.g. accounts/fireworks/models/deepseek-v4-pro
  REPORT_MODEL_API_KEY   defaults to $FIREWORKS_API_KEY
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import urllib.request
from collections import defaultdict
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def load_prices(path: Path) -> dict[str, float]:
    prices = {"strong": 1.05, "weak": 0.15}
    if path.exists():
        for line in path.read_text().splitlines():
            m = re.match(r"^(strong|weak):\s*([0-9.]+)\s*$", line)
            if m:
                prices[m.group(1)] = float(m.group(2))
    return prices


def route_key(rec: dict) -> str:
    if rec.get("tier"):
        return rec["tier"]
    model = rec.get("model") or "unknown"
    return "pinned:" + model.rsplit("/", 1)[-1]


def is_strong(key: str) -> bool:
    if key == "strong":
        return True
    if key == "weak":
        return False
    return "pro" in key


def iter_records(collect_dir: Path):
    for path in sorted(collect_dir.glob("**/routing.jsonl")):
        for line in path.read_text().splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                yield json.loads(line)
            except json.JSONDecodeError:
                print(f"warning: skipping malformed line in {path}", file=sys.stderr)


def aggregate(records: list[dict], prices: dict[str, float]) -> dict:
    by_route: dict[str, dict] = defaultdict(lambda: {"requests": 0, "tokens": 0})
    by_repo: dict[str, dict] = defaultdict(lambda: {"requests": 0, "tokens": 0, "strong_tokens": 0})
    by_label: dict[str, dict] = defaultdict(
        lambda: {"requests": 0, "tokens": 0, "strong_requests": 0}
    )
    strong_tokens = weak_tokens = 0

    for rec in records:
        key = route_key(rec)
        tokens = rec.get("total_tokens") or 0
        by_route[key]["requests"] += 1
        by_route[key]["tokens"] += tokens

        repo = rec.get("repo") or "unknown"
        by_repo[repo]["requests"] += 1
        by_repo[repo]["tokens"] += tokens

        label = rec.get("task_label") or "(none)"
        by_label[label]["requests"] += 1
        by_label[label]["tokens"] += tokens

        if is_strong(key):
            strong_tokens += tokens
            by_repo[repo]["strong_tokens"] += tokens
            by_label[label]["strong_requests"] += 1
        else:
            weak_tokens += tokens

    total_tokens = strong_tokens + weak_tokens
    cost = (strong_tokens * prices["strong"] + weak_tokens * prices["weak"]) / 1e6
    pro_only = total_tokens * prices["strong"] / 1e6
    return {
        "records": len(records),
        "total_tokens": total_tokens,
        "strong_tokens": strong_tokens,
        "weak_tokens": weak_tokens,
        "estimated_cost_usd": round(cost, 4),
        "estimated_pro_only_cost_usd": round(pro_only, 4),
        "estimated_savings_usd": round(pro_only - cost, 4),
        "prices_per_mtok": prices,
        "by_route": dict(sorted(by_route.items(), key=lambda kv: -kv[1]["requests"])),
        "by_repo": dict(sorted(by_repo.items(), key=lambda kv: -kv[1]["tokens"])),
        "by_task_label": dict(sorted(by_label.items(), key=lambda kv: -kv[1]["tokens"])),
    }


def anomalies(records: list[dict]) -> list[dict]:
    """Weak-routed requests whose token count is in the top 5% overall —
    candidates for 'this should have gone to the strong tier'."""
    tokens = sorted(r.get("total_tokens") or 0 for r in records)
    if not tokens:
        return []
    p95 = tokens[max(0, int(len(tokens) * 0.95) - 1)]
    out = [
        r
        for r in records
        if not is_strong(route_key(r)) and (r.get("total_tokens") or 0) >= max(p95, 1)
    ]
    return sorted(out, key=lambda r: -(r.get("total_tokens") or 0))[:20]


def print_table(summary: dict) -> None:
    print(f"{'route':<28}{'requests':>9}{'req%':>8}{'total_tokens':>14}")
    total_reqs = sum(v["requests"] for v in summary["by_route"].values()) or 1
    for key, v in summary["by_route"].items():
        pct = 100 * v["requests"] / total_reqs
        print(f"{key:<28}{v['requests']:>9}{pct:>7.1f}%{v['tokens']:>14,}")
    print()
    print(
        f"estimated cost: ${summary['estimated_cost_usd']}  "
        f"(pro-only: ${summary['estimated_pro_only_cost_usd']}, "
        f"savings: ${summary['estimated_savings_usd']})"
    )


def ai_report(summary: dict, anomaly_list: list[dict]) -> str:
    base_url = os.environ.get("REPORT_MODEL_BASE_URL")
    model = os.environ.get("REPORT_MODEL")
    if not base_url or not model:
        sys.exit("--ai-report requires REPORT_MODEL_BASE_URL and REPORT_MODEL")
    api_key = os.environ.get("REPORT_MODEL_API_KEY") or os.environ.get("FIREWORKS_API_KEY") or "dummy"

    prompt = (
        "あなたは LLM ルーティングのコスト分析者です。以下は CI 上の Switchyard "
        "ルーター(strong=deepseek-v4-pro / weak=deepseek-v4-flash)の集計値と、"
        "weak に振られたのにトークン数が大きい異常候補です。日本語で簡潔な "
        "Markdown レポートを書いてください。構成: ハイライト(コスト・削減額・"
        "auto の strong 比率) / repo・task_label 別の気づき / 誤ルート疑いの指摘 / "
        "推奨アクション。数値の再計算はせず、与えられた数値だけを使うこと。\n\n"
        f"## summary\n{json.dumps(summary, ensure_ascii=False, indent=2)}\n\n"
        f"## anomalies (top {len(anomaly_list)})\n"
        f"{json.dumps(anomaly_list, ensure_ascii=False, indent=2)}"
    )
    req = urllib.request.Request(
        f"{base_url.rstrip('/')}/chat/completions",
        data=json.dumps(
            {"model": model, "messages": [{"role": "user", "content": prompt}]}
        ).encode(),
        headers={"content-type": "application/json", "authorization": f"Bearer {api_key}"},
    )
    with urllib.request.urlopen(req, timeout=120) as res:
        body = json.load(res)
    return body["choices"][0]["message"]["content"]


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--collect-dir", default=str(ROOT / "collected"))
    parser.add_argument("--out", default=str(ROOT / "summary.json"))
    parser.add_argument("--ai-report", action="store_true")
    args = parser.parse_args()

    collect_dir = Path(args.collect_dir)
    records = list(iter_records(collect_dir))
    if not records:
        sys.exit(f"no routing.jsonl records under {collect_dir} — run collect.sh first")

    prices = load_prices(ROOT / "scripts" / "prices.yaml")
    summary = aggregate(records, prices)
    Path(args.out).write_text(json.dumps(summary, ensure_ascii=False, indent=2) + "\n")

    print_table(summary)
    print(f"\nwrote {args.out}")

    if args.ai_report:
        print("\n--- AI report ---\n")
        print(ai_report(summary, anomalies(records)))


if __name__ == "__main__":
    main()
