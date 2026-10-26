#!/usr/bin/env python3
"""The one required CI check: fail when a needed job failed, or was skipped although its area has changes or no area gates it.

Reads the environment variable NEEDS, the JSON of `toJSON(needs)`: {job: {result, outputs}}.
[impl->req~ci-speed-required-aggregate~1]
"""

from __future__ import annotations

import json
import os
import sys

# Job name -> the area output of the `changes` job that decides whether it runs. Any other job is always on.
JOB_AREA = {
    "bim-toolchain": "bim",
    "engines": "engines",
    "test": "gateway",
    "gateway-unit": "gateway",
    "frontend-e2e": "e2e",
}


def problems(needs: object) -> list[str]:
    """One line per reason the aggregate must fail; empty when it passes."""
    if not isinstance(needs, dict) or not needs:
        return ["NEEDS is not a non-empty JSON object"]
    if not all(isinstance(job, dict) for job in needs.values()):
        return ["NEEDS holds a job that is not an object"]
    found: list[str] = []
    changes = needs.get("changes")
    if changes is None or changes.get("result") != "success":
        found.append(f"job changes did not succeed (result: {changes.get('result') if changes else 'missing'})")
    outputs = changes.get("outputs") if changes else None
    areas = outputs if isinstance(outputs, dict) else {}
    for name, job in sorted(needs.items()):
        result = job.get("result")
        area = JOB_AREA.get(name)
        if name == "changes":
            continue
        if result not in ("success", "skipped"):
            found.append(f"job {name} {result}")
        elif result == "skipped" and area is None:
            found.append(f"job {name} was skipped but no area gates it")
        elif result == "skipped" and areas.get(area) != "false":
            found.append(f"job {name} was skipped but area {area} is {areas.get(area, 'missing')!r}, not 'false'")
    return found


def main() -> int:
    try:
        needs = json.loads(os.environ.get("NEEDS", ""))
    except json.JSONDecodeError as error:
        print(f"ci-required: NEEDS is missing or not JSON ({error})", file=sys.stderr)
        return 1
    found = problems(needs)
    if found:
        print("ci-required: " + "; ".join(found), file=sys.stderr)
        return 1
    print(f"ci-required: {len(needs)} jobs passed or were skipped for unchanged areas")
    return 0


if __name__ == "__main__":
    sys.exit(main())
