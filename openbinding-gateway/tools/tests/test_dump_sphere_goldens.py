"""dump_sphere_goldens: --check is clean, a drifted case is reported, and no package directory is ever written."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
from pathlib import Path

import dump_sphere_goldens as tool

TOOL = Path(tool.__file__).resolve()


def _run(*arguments: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TOOL), *arguments], capture_output=True, text=True, env=dict(os.environ), timeout=900
    )


def test_check_is_clean() -> None:
    done = _run("--check")
    assert done.returncode == 0, done.stdout + done.stderr


def test_out_writes_file_maps_and_never_an_instance_json(tmp_path: Path) -> None:
    done = _run("--out", str(tmp_path))
    assert done.returncode == 0, done.stdout + done.stderr
    assert not list(tmp_path.rglob("instance.json"))
    assert not [p for p in tmp_path.iterdir() if p.is_dir()]
    names = sorted(p.name for p in tmp_path.iterdir())
    assert names == sorted(tool.written(tool.DEFAULT_OUT))
    for name in names:
        assert (tmp_path / name).read_bytes() == (tool.DEFAULT_OUT / name).read_bytes(), name


def test_check_detects_a_drifted_case(tmp_path: Path, monkeypatch) -> None:
    copy = tmp_path / "sphere"
    shutil.copytree(tool.DEFAULT_OUT, copy)
    target = copy / "born-storage.origins.json"
    target.write_text(target.read_text().replace('"priced"', '"manual"', 1))
    monkeypatch.setattr(tool, "DEFAULT_OUT", copy)
    monkeypatch.setattr(tool, "CASES", copy / "cases.json")
    assert tool.main(["--check"]) == 1
