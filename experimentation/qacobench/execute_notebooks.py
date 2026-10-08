#!/usr/bin/env python3
"""Execute the four result-reading notebooks against the shared CLI outputs."""

from __future__ import annotations

import argparse
from pathlib import Path

import nbformat
from nbclient import NotebookClient

ROOT = Path(__file__).resolve().parents[2]
SOURCE = ROOT / "experimentation/qacobench/notebooks"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--out-dir", type=Path, default=ROOT / ".artifacts/qacobench/notebooks")
    args = parser.parse_args()
    args.out_dir.mkdir(parents=True, exist_ok=True)
    for path in sorted(SOURCE.glob("*.ipynb")):
        notebook = nbformat.read(path, as_version=4)
        NotebookClient(notebook, timeout=600, kernel_name="python3", resources={"metadata": {"path": str(ROOT)}}).execute()
        nbformat.write(notebook, args.out_dir / path.name)
        print(path.name, flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
