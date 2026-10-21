#!/usr/bin/env python3
"""Run the secondary analyses of the QACOBench campaign end to end (RQ1-RQ4 tables, figures and LaTeX).

Inputs (read-only): .artifacts/qacobench/results.jsonl, datasets/07_qfbs/manifest.jsonl,
datasets/03_hsc_llm/ (package annotations) and datasets/sources/hsc/*.json.
Outputs: .artifacts/qacobench/secondary/ (CSV, figures/, latex/ including the paper's number macros).
Environment overrides: QACOBENCH_ROOT, QACOBENCH_RESULTS, QACOBENCH_DATASETS, QACOBENCH_SECONDARY_OUT.
"""
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
STEPS = ("01_extract.py", "02_analyze.py", "03_hsc_quality.py", "04_figures.py", "05_latex_tables.py",
         "08_corpus_characterization.py", "09_paper_numbers.py")
for step in STEPS:
    print(f"==> {step}", flush=True)
    subprocess.run([sys.executable, "-I", str(HERE / step)], check=True)
print("done")
