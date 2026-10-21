"""pytest hooks: the failures of a run, repeated compactly at the very end of the output.

The registered checks show the tail of a very long output (every ``xfail`` reason, the measurements of the service
suite), which can hide why a test failed.  A conftest that imports these hooks keeps, for each failed test or collection
error, the end of its report, prints a digest last and writes the reports to ``.pytest_cache/qa-failures.txt`` (ignored
by git).  It changes no test and no outcome.  Importing it from several conftests is harmless: each failure is kept once.
"""

from __future__ import annotations

from pathlib import Path

LIMIT = 4000
TAIL_LINES = 6
BUDGET = 14000
OUTPUT = Path(__file__).resolve().parents[1] / ".pytest_cache" / "qa-failures.txt"
_FAILURES: dict[str, str] = {}
_PRINTED = False


def pytest_runtest_logreport(report) -> None:
    if report.failed:
        _FAILURES.setdefault(f"{report.nodeid} [{report.when}]", report.longreprtext[-LIMIT:])


def pytest_collectreport(report) -> None:
    if report.failed:
        _FAILURES.setdefault(f"{report.nodeid} [collect]", report.longreprtext[-LIMIT:])


def pytest_sessionfinish(session, exitstatus) -> None:
    OUTPUT.parent.mkdir(exist_ok=True)
    OUTPUT.write_text(
        "".join(f"=== {name}\n{text}\n" for name, text in _FAILURES.items()) or "no failures\n", encoding="utf-8"
    )


def pytest_unconfigure(config) -> None:
    global _PRINTED
    if _PRINTED:
        return
    _PRINTED = True
    reporter = config.pluginmanager.get_plugin("terminalreporter")
    stats = getattr(reporter, "stats", {})
    outcomes = ("passed", "failed", "error", "skipped", "xfailed", "xpassed")
    lines = ["--- totals: " + ", ".join(f"{name}={len(stats.get(name, []))}" for name in outcomes) + " ---"]
    if _FAILURES:
        lines.append(f"--- failure digest: {len(_FAILURES)} failed ---")
    for name, text in _FAILURES.items():
        tail = [line for line in text.splitlines() if line.strip()][-TAIL_LINES:]
        lines.append(f"## {name}")
        lines.extend(f"   {line[:300]}" for line in tail)
    print("\n".join(lines)[:BUDGET])
