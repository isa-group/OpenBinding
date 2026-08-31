from __future__ import annotations

import importlib.util

from _repo import REPO_ROOT


TOOL = REPO_ROOT / "tools" / "check_bim_conciseness.py"
if not TOOL.is_file():
    TOOL = REPO_ROOT / "repository-tools" / "check_bim_conciseness.py"


def _load_tool():
    spec = importlib.util.spec_from_file_location("check_bim_conciseness", TOOL)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    # In Compose the repository tool directory is mounted beside the gateway's
    # own tools directory, while its benchmark packages still live under the
    # configured repository root.
    module.BENCHMARKS = TOOL.with_name("bim_conciseness_benchmarks.json")
    return module


def test_representative_bim_packages_are_at_least_fifty_percent_more_concise() -> None:
    report = _load_tool().run_benchmarks()

    assert report["ok"], report
    assert set(report["cases"]) == {"sequence", "xor", "placement", "soft-multiobjective"}
    for result in report["cases"].values():
        assert result["reduction"] >= 0.5
        assert not result["errors"]
