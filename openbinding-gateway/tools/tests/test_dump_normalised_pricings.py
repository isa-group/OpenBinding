"""dump_normalised_pricings: --check is clean on the recorded set, detects drift, and --out writes only there."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import dump_normalised_pricings as tool

TOOL = Path(tool.__file__).resolve()


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *arguments], capture_output=True, text=True, env=dict(os.environ), timeout=600
    )


def test_check_is_clean_on_the_recorded_set() -> None:
    done = _run("--check")
    assert done.returncode == 0, done.stdout + done.stderr


def test_out_writes_the_same_goldens_and_nothing_else(tmp_path: Path) -> None:
    before = {p: p.stat().st_mtime_ns for p in tool.DEFAULT_OUT.glob("*.json")}
    done = _run("--out", str(tmp_path))
    assert done.returncode == 0, done.stdout + done.stderr
    written = sorted(p.name for p in tmp_path.iterdir())
    assert written == sorted(p.name for p in tool.DEFAULT_OUT.glob("*.json"))
    for name in written:
        assert (tmp_path / name).read_bytes() == (tool.DEFAULT_OUT / name).read_bytes()
    assert {p: p.stat().st_mtime_ns for p in tool.DEFAULT_OUT.glob("*.json")} == before


def test_check_detects_drift(tmp_path: Path, monkeypatch) -> None:
    copy = tmp_path / "normalised"
    shutil.copytree(tool.DEFAULT_OUT, copy)
    victim = sorted(copy.glob("*.json"))[0]
    victim.write_text(victim.read_text().replace('"currency"', '"kurrency"', 1))
    monkeypatch.setattr(tool, "DEFAULT_OUT", copy)
    assert tool.main(["--check"]) == 1
