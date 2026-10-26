"""Tests for tools/ci_shard.py, the deterministic splitter of the gateway unit tests."""

import json
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
SCRIPT = REPO / "tools" / "ci_shard.py"
ROOT = "openbinding-gateway/tests"


def run(*args, cwd=REPO):
    assert SCRIPT.is_file(), f"missing {SCRIPT}"
    return subprocess.run(
        [sys.executable, str(SCRIPT), *args], capture_output=True, text=True, cwd=cwd
    )


def shard(i, n, *extra):
    result = run("--shard", f"{i}/{n}", *extra)
    assert result.returncode == 0, result.stderr
    return result.stdout.split()


def make_tree(base, sizes):
    for rel, size in sizes.items():
        path = base / rel
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("#" * size)


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_shards_partition_every_test_file_of_the_gateway():
    expected = sorted(p.relative_to(REPO).as_posix() for p in (REPO / ROOT).rglob("test_*.py"))
    assert expected
    for n in (2, 3):
        parts = [shard(i, n) for i in range(1, n + 1)]
        flat = [f for part in parts for f in part]
        assert len(flat) == len(set(flat))
        assert sorted(flat) == expected
        assert all(part == sorted(part) for part in parts)


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_output_is_stable_between_runs():
    assert run("--shard", "1/3").stdout == run("--shard", "1/3").stdout
    assert run("--shard", "2/3").stdout == run("--shard", "2/3").stdout


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_heavier_shard_exceeds_lighter_by_at_most_the_largest_file():
    files = {p: p.stat().st_size for p in (REPO / ROOT).rglob("test_*.py")}
    for n in (2, 3):
        totals = [sum(files[REPO / f] for f in shard(i, n)) for i in range(1, n + 1)]
        assert max(totals) - min(totals) <= max(files.values())


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_invalid_arguments_exit_2():
    for bad in ("0/2", "3/2", "1/0", "-1/2", "x/2", "2"):
        result = run("--shard", bad)
        assert result.returncode == 2, bad
        assert result.stderr.strip()


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_weights_change_the_assignment_on_a_small_tree(tmp_path):
    tree = tmp_path / "t"
    make_tree(tree, {"test_a.py": 100, "sub/test_b.py": 50, "test_c.py": 40, "test_d.py": 10,
                     "helper.py": 999})
    root = str(tree)
    by_size = [shard(i, 2, "--root", root) for i in (1, 2)]
    # greedy longest-first: a -> 1, b -> 2, c -> 2, d -> 2 (90 < 100)
    assert by_size[0] == [f"{root}/test_a.py"]
    assert by_size[1] == sorted(f"{root}/{r}" for r in ("sub/test_b.py", "test_c.py", "test_d.py"))

    weights = tmp_path / "w.json"
    weights.write_text(json.dumps({f"{root}/test_d.py": 500.0}))
    heavy = [shard(i, 2, "--root", root, "--weights", str(weights)) for i in (1, 2)]
    assert heavy[0] == [f"{root}/test_d.py"]
    assert sorted(heavy[1]) == sorted(f"{root}/{r}" for r in ("test_a.py", "sub/test_b.py", "test_c.py"))


# [utest->req~ci-speed-gateway-unit-shards~1]
def test_empty_shards_only_when_fewer_files_than_shards(tmp_path):
    make_tree(tmp_path, {"test_a.py": 1, "test_b.py": 1})
    parts = [shard(i, 3, "--root", str(tmp_path)) for i in (1, 2, 3)]
    assert sorted(len(p) for p in parts) == [0, 1, 1]
