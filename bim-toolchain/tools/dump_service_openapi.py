"""Write (or check) the OpenAPI document of bim-service: ``contracts/openapi/bim-service.v1.json``.

The document is generated from the application itself (``bim_service.app.build_app``), so it cannot drift from
the routes; it contains nothing that depends on the configuration or on the digests of the installed toolchain.

    python tools/dump_service_openapi.py            # rewrite the committed file
    python tools/dump_service_openapi.py --check    # CI: exit 1 if the committed file is not what the code generates
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
for _source in ("bim-core", "bim-service"):
    _path = ROOT / "packages" / _source / "src"
    if _path.is_dir() and str(_path) not in sys.path:
        sys.path.insert(0, str(_path))

OPENAPI_PATH = ROOT / "contracts" / "openapi" / "bim-service.v1.json"


def generate() -> dict[str, Any]:
    """The OpenAPI document of the application, built with no tokens and the default settings."""
    from bim_service.app import build_app
    from bim_service.auth import Authenticator
    from bim_service.settings import BimServiceSettings

    return build_app(BimServiceSettings(), Authenticator(anonymous=True)).openapi()


def render(document: dict[str, Any]) -> bytes:
    """The one byte representation of the document: sorted keys, two-space indent, LF."""
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def difference(found: bytes, committed: bytes) -> str | None:
    """A short description of the first difference, or ``None`` if the bytes are the same."""
    if found == committed:
        return None
    new, old = found.decode("utf-8").splitlines(), committed.decode("utf-8").splitlines()
    for number, (left, right) in enumerate(zip(new, old, strict=False), start=1):
        if left != right:
            return f"first difference at line {number}: generated {left.strip()!r}, committed {right.strip()!r}"
    return f"generated {len(new)} lines, committed {len(old)}"


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument("--check", action="store_true", help="fail if the committed document is out of date")
    parser.add_argument("--path", type=Path, default=OPENAPI_PATH, help="the document (default: the committed one)")
    arguments = parser.parse_args(argv)
    found = render(generate())
    if arguments.check:
        if not arguments.path.is_file():
            print(f"{arguments.path} does not exist: run tools/dump_service_openapi.py")
            return 1
        changed = difference(found, arguments.path.read_bytes())
        if changed:
            print(f"{arguments.path} is out of date ({changed}): run tools/dump_service_openapi.py")
            return 1
        print(f"{arguments.path.name} is up to date")
        return 0
    arguments.path.parent.mkdir(parents=True, exist_ok=True)
    arguments.path.write_bytes(found)
    print(f"wrote {arguments.path}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
