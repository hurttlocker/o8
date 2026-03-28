#!/usr/bin/env python3
from __future__ import annotations

import argparse
import json
import re
import signal
import sqlite3
import subprocess
import time
import urllib.request
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from typing import Any


ROOT = Path("/Users/marquisehurtt/clawd/repos/cortex-ide")


def parse_args() -> argparse.Namespace:
    ap = argparse.ArgumentParser(description="Head-to-head LoCoMo benchmark: ungated vs import-quality-gated")
    ap.add_argument("--binary", required=True, help="Path to cortex binary")
    ap.add_argument("--run-dir", required=True, help="Run output directory")
    ap.add_argument("--model", default="openrouter/google/gemini-2.5-flash", help="Ask model")
    ap.add_argument("--embed-model", default="all-minilm", help="Model name for embed_with_timeout.py")
    ap.add_argument("--embed-provider", default="ollama/all-minilm", help="Embed provider/model passed to cortex search/ask")
    ap.add_argument("--search-timeout", type=int, default=10)
    ap.add_argument("--ask-timeout", type=int, default=20)
    ap.add_argument("--embed-timeout", type=int, default=8)
    ap.add_argument("--workers", type=int, default=3, help="Parallel question workers per mode")
    ap.add_argument("--questions-limit", type=int, default=0, help="Optional cap for debugging")
    ap.add_argument("--dataset-url", default="https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json")
    return ap.parse_args()


def ensure_dataset(dataset_path: Path, dataset_url: str) -> list[dict[str, Any]]:
    if not dataset_path.exists():
        dataset_path.write_text(urllib.request.urlopen(dataset_url).read().decode())
    return json.loads(dataset_path.read_text())


def render_corpus(data: list[dict[str, Any]], corpus_dir: Path) -> None:
    corpus_dir.mkdir(parents=True, exist_ok=True)
    for item in data:
        c = item["conversation"]
        lines = [f"# {item['sample_id']}", "", f"Participants: {c['speaker_a']}, {c['speaker_b']}", ""]
        for i in range(1, 17):
            date = c.get(f"session_{i}_date_time")
            turns = c.get(f"session_{i}")
            if not date or not isinstance(turns, list):
                continue
            lines.append(f"## Session {i} - {date}")
            lines.append("")
            for turn in turns:
                dia = f" ({turn['dia_id']})" if turn.get("dia_id") else ""
                lines.append(f"{turn['speaker']}{dia}: {turn.get('text', '')}")
                if isinstance(turn.get("img_url"), list) and turn["img_url"]:
                    lines.append("Image URLs: " + ", ".join(turn["img_url"]))
                if turn.get("blip_caption"):
                    lines.append(f"Image caption: {turn['blip_caption']}")
                if turn.get("query"):
                    lines.append(f"Image query: {turn['query']}")
                lines.append("")
            (corpus_dir / f"{item['sample_id']}.md").write_text("\n".join(lines))


def select_questions(data: list[dict[str, Any]], questions_limit: int) -> list[dict[str, Any]]:
    conv30 = next(item for item in data if item["sample_id"] == "conv-30")
    questions = [q for q in conv30["qa"] if q["category"] in (1, 2, 4)]
    if questions_limit > 0:
        questions = questions[:questions_limit]
    return questions


def normalize_answer(value: str) -> str:
    value = value.lower()
    value = re.sub(r"\[\d+\]", " ", value)
    value = re.sub(r"\b(a|an|the)\b", " ", value)
    value = re.sub(r"[^a-z0-9]+", " ", value)
    return re.sub(r"\s+", " ", value).strip()


def token_f1(predicted: str, expected: str) -> float:
    pred_tokens = normalize_answer(predicted).split() if normalize_answer(predicted) else []
    exp_tokens = normalize_answer(expected).split() if normalize_answer(expected) else []
    if not pred_tokens and not exp_tokens:
        return 1.0
    if not pred_tokens or not exp_tokens:
        return 0.0
    counts: dict[str, int] = {}
    for token in exp_tokens:
        counts[token] = counts.get(token, 0) + 1
    overlap = 0
    for token in pred_tokens:
        if counts.get(token, 0) > 0:
            overlap += 1
            counts[token] -= 1
    if overlap == 0:
        return 0.0
    precision = overlap / len(pred_tokens)
    recall = overlap / len(exp_tokens)
    return 2 * precision * recall / (precision + recall)


def kill_embed_worker(db_path: Path) -> None:
    lock_path = db_path.with_name("embed.lock")
    if not lock_path.exists():
        return
    content = lock_path.read_text()
    match = re.search(r"pid=(\d+)", content)
    if not match:
        return
    pid = int(match.group(1))
    try:
        os_kill(pid)
    except Exception:
        return


def os_kill(pid: int) -> None:
    import os
    os.kill(pid, signal.SIGTERM)


def run_json(cmd: list[str], cwd: Path, timeout: int) -> tuple[Any | None, str | None]:
    try:
        out = subprocess.check_output(cmd, cwd=cwd, text=True, timeout=timeout)
        return json.loads(out), None
    except subprocess.TimeoutExpired:
        return None, "timeout"
    except subprocess.CalledProcessError as exc:
        return None, f"error:{exc.returncode}"


def score_question(
    binary: str,
    db_path: Path,
    question: dict[str, Any],
    model: str,
    embed_provider: str,
    search_timeout: int,
    ask_timeout: int,
) -> dict[str, Any]:
    search, search_err = run_json(
        [
            binary,
            "--db",
            str(db_path),
            "search",
            question["question"],
            "--mode",
            "rrf",
            "--limit",
            "5",
            "--embed",
            embed_provider,
            "--json",
        ],
        ROOT,
        search_timeout,
    )
    ask, ask_err = run_json(
        [
            binary,
            "--db",
            str(db_path),
            "ask",
            question["question"],
            "--mode",
            "rrf",
            "--budget",
            "600",
            "--model",
            model,
            "--embed",
            embed_provider,
            "--json",
        ],
        ROOT,
        ask_timeout,
    )
    results = search if isinstance(search, list) else (search.get("results", []) if search else [])
    evidence_hit = any(
        any(ev in (r.get("content") or "") or ev in (r.get("snippet") or "") for ev in question["evidence"])
        for r in results[:5]
    )
    answer = ask.get("answer", "") if ask else ""
    exact = normalize_answer(answer) == normalize_answer(str(question["answer"])) if answer else False
    f1 = token_f1(answer, str(question["answer"])) if answer else 0.0
    degraded = True if ask is None else bool(ask.get("degraded"))
    reason = search_err or ask_err or (ask.get("reason", "") if ask else "")
    return {
        "question": question["question"],
        "category": question["category"],
        "expected": str(question["answer"]),
        "answer": answer,
        "evidence_hit": evidence_hit,
        "exact_match": exact,
        "token_f1": f1,
        "degraded": degraded,
        "reason": reason,
    }


def summarize(label: str, gated: bool, import_secs: float, embed_secs: float, stats: dict[str, Any], rows: list[dict[str, Any]]) -> dict[str, Any]:
    out = {
        "label": label,
        "gated": gated,
        "import_secs": round(import_secs, 3),
        "embed_secs": round(embed_secs, 3),
        "stats": stats,
        "questions": len(rows),
        "evidence_hits": sum(1 for row in rows if row["evidence_hit"]),
        "exact_matches": sum(1 for row in rows if row["exact_match"]),
        "non_degraded": sum(1 for row in rows if not row["degraded"]),
        "avg_f1": sum(row["token_f1"] for row in rows) / max(1, len(rows)),
        "by_category": {},
    }
    for category in sorted({row["category"] for row in rows}):
        subset = [row for row in rows if row["category"] == category]
        out["by_category"][str(category)] = {
            "count": len(subset),
            "evidence_hits": sum(1 for row in subset if row["evidence_hit"]),
            "exact_matches": sum(1 for row in subset if row["exact_match"]),
            "non_degraded": sum(1 for row in subset if not row["degraded"]),
            "avg_f1": sum(row["token_f1"] for row in subset) / max(1, len(subset)),
        }
    return out


def run_mode(args: argparse.Namespace, label: str, gated: bool, corpus_dir: Path, questions: list[dict[str, Any]]) -> dict[str, Any]:
    db_path = Path(args.run_dir) / f"{label}.db"
    for suffix in ("", "-shm", "-wal"):
        target = Path(str(db_path) + suffix)
        if target.exists():
            target.unlink()

    import_cmd = [
        args.binary,
        "--db",
        str(db_path),
        "import",
        str(corpus_dir),
        "--recursive",
        "--extract",
        "--no-enrich",
        "--no-classify",
    ]
    if gated:
        import_cmd.append("--import-quality-gate")

    import_start = time.time()
    subprocess.run(import_cmd, cwd=ROOT, check=True)
    import_secs = time.time() - import_start

    kill_embed_worker(db_path)

    embed_start = time.time()
    subprocess.run(
        [
            "python3",
            str(ROOT / "scripts/research/embed_with_timeout.py"),
            str(db_path),
            args.embed_model,
            str(args.embed_timeout),
        ],
        cwd=ROOT,
        check=True,
    )
    embed_secs = time.time() - embed_start

    stats = json.loads(subprocess.check_output([args.binary, "--db", str(db_path), "stats"], cwd=ROOT, text=True))

    rows: list[dict[str, Any]] = []
    with ThreadPoolExecutor(max_workers=args.workers) as pool:
        futures = [
            pool.submit(
                score_question,
                args.binary,
                db_path,
                question,
                args.model,
                args.embed_provider,
                args.search_timeout,
                args.ask_timeout,
            )
            for question in questions
        ]
        for idx, future in enumerate(as_completed(futures), 1):
            rows.append(future.result())
            if idx % 10 == 0 or idx == len(futures):
                print(f"[{label}] {idx}/{len(futures)} done")

    rows.sort(key=lambda row: row["question"])
    return {
        "summary": summarize(label, gated, import_secs, embed_secs, stats, rows),
        "results": rows,
    }


def render_report(result: dict[str, Any], output_path: Path) -> None:
    lines = ["# Import Quality Gate LoCoMo Head-to-Head", ""]
    for label in ("ungated", "gated"):
        summary = result[label]["summary"]
        lines.append(f"## {label}")
        lines.append("")
        lines.append(f"- import secs: `{summary['import_secs']}`")
        lines.append(f"- embed secs: `{summary['embed_secs']}`")
        lines.append(f"- memories: `{summary['stats'].get('memories', 0)}`")
        lines.append(f"- denied_at_import_count: `{summary['stats'].get('denied_at_import_count', 0)}`")
        lines.append(f"- evidence hits: `{summary['evidence_hits']}/{summary['questions']}`")
        lines.append(f"- exact matches: `{summary['exact_matches']}/{summary['questions']}`")
        lines.append(f"- non-degraded: `{summary['non_degraded']}/{summary['questions']}`")
        lines.append(f"- avg token F1: `{summary['avg_f1']:.4f}`")
        lines.append("")
    output_path.write_text("\n".join(lines) + "\n")


def main() -> int:
    args = parse_args()
    run_dir = Path(args.run_dir)
    run_dir.mkdir(parents=True, exist_ok=True)

    data = ensure_dataset(run_dir / "locomo10.json", args.dataset_url)
    corpus_dir = run_dir / "corpus"
    render_corpus(data, corpus_dir)
    questions = select_questions(data, args.questions_limit)

    result = {}
    for label, gated in (("ungated", False), ("gated", True)):
        result[label] = run_mode(args, label, gated, corpus_dir, questions)

    out_json = run_dir / "head_to_head_results.json"
    out_json.write_text(json.dumps(result, indent=2))
    render_report(result, run_dir / "head_to_head_report.md")
    print(json.dumps({k: v["summary"] for k, v in result.items()}, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
