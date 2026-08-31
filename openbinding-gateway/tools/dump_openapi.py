#!/usr/bin/env python3
"""Write the OpenAPI document to docs/openapi.json.

The document is generated from the code, so it cannot go out of date - but that
also means a change to the contract is invisible in review, buried inside a
change to a Pydantic model. Committing a snapshot puts it in the diff, where
somebody can see that an endpoint gained a status code or a field changed type.

    python tools/dump_openapi.py            # rewrite the snapshot
    python tools/dump_openapi.py --check    # fail if it is out of date

`--check` is what CI runs. When it fails, the fix is to run the command without
it and commit the result.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

GATEWAY_ROOT = Path(__file__).resolve().parents[1]
REPO_ROOT = Path(
    os.environ.get("OPENBINDING_REPO_ROOT", Path(__file__).resolve().parents[2])
).resolve()
SNAPSHOT = REPO_ROOT / "docs" / "openapi.json"

sys.path.insert(0, str(GATEWAY_ROOT / "src"))

# The schemas have to be findable, or the instance schema is missing from the
# document and the snapshot would record its absence as if it were the contract.
os.environ.setdefault("GENERAL_SCHEMA_PATH", str(REPO_ROOT / "schemas" / "general" / "schema.json"))
os.environ.setdefault("SCHEMAS_DIR", str(REPO_ROOT / "schemas"))


def document() -> str:
    from openbinding_gateway.main import app

    # sort_keys, because dict ordering is not part of the contract and an
    # incidental reordering would show up as a diff nobody asked for.
    return json.dumps(app.openapi(), indent=2, sort_keys=True, ensure_ascii=False) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--check",
        action="store_true",
        help="Do not write; exit non-zero if the snapshot differs from the code.",
    )
    arguments = parser.parse_args()

    generated = document()

    if not arguments.check:
        SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
        SNAPSHOT.write_text(generated, encoding="utf-8")
        print(f"Wrote {SNAPSHOT.relative_to(REPO_ROOT)}")
        return 0

    if not SNAPSHOT.exists():
        print(f"{SNAPSHOT.relative_to(REPO_ROOT)} does not exist.", file=sys.stderr)
        print("Run: python tools/dump_openapi.py", file=sys.stderr)
        return 1

    if SNAPSHOT.read_text(encoding="utf-8") != generated:
        print(
            f"{SNAPSHOT.relative_to(REPO_ROOT)} is out of date: the API has changed.",
            file=sys.stderr,
        )
        print("Run: python tools/dump_openapi.py, and commit the result.", file=sys.stderr)
        return 1

    print("The OpenAPI snapshot matches the code.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
