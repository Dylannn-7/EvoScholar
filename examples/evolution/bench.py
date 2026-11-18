"""Small standalone benchmark for demonstrating the evolution workflow."""
import argparse
import json
import math
from pathlib import Path


def load_json(path):
    return json.loads(path.read_text(encoding="utf-8"))


def prepare(case, workdir):
    workdir.mkdir(parents=True, exist_ok=False)
    samples = json.dumps(case["samples"])
    task = (
        f"# {case['title']}\n\n"
        f"采样值（摄氏度）：{samples}\n\n"
        "计算以上采样值的个数和算术平均值。将结果写入工作目录的 answer.json。"
        "文件内容是一个 JSON 对象，且只有 count（整数）和 mean（数值，以摄氏度计）两个键。\n"
    )
    (workdir / "task.md").write_text(task, encoding="utf-8")
    (workdir / ".demo-case").write_text(case["id"], encoding="utf-8")


def grade(case, workdir):
    try:
        answer = load_json(workdir / "answer.json")
    except (OSError, ValueError):
        return ["answer.json 缺失或无法解析"]
    if not isinstance(answer, dict) or answer.keys() != {"count", "mean"}:
        return ["answer.json 必须恰好包含 count 和 mean"]

    samples = case["samples"]
    count, mean = answer["count"], answer["mean"]
    errors = []
    if type(count) is not int or count != len(samples):
        errors.append("answer.json 的 count 应为正确的整数")
    if type(mean) not in (int, float) or not math.isclose(mean, sum(samples) / len(samples)):
        errors.append("answer.json 的 mean 应为正确的数值")
    return errors


def main():
    cases = {case["id"]: case for case in load_json(Path(__file__).with_name("manifest.json"))["cases"]}
    parser = argparse.ArgumentParser(description=__doc__)
    commands = parser.add_subparsers(dest="command", required=True)
    create = commands.add_parser("prepare")
    create.add_argument("id", choices=cases)
    create.add_argument("workdir", type=Path)
    check = commands.add_parser("grade")
    check.add_argument("workdir", type=Path)
    args = parser.parse_args()

    if args.command == "prepare":
        prepare(cases[args.id], args.workdir)
        return 0

    case_id = (args.workdir / ".demo-case").read_text(encoding="utf-8").strip()
    errors = grade(cases[case_id], args.workdir)
    print(json.dumps({
        "id": case_id, "phase": 1, "machine_status": "fail" if errors else "pass",
        "failures": errors, "manual_review": [],
    }))
    return int(bool(errors))


if __name__ == "__main__":
    raise SystemExit(main())
