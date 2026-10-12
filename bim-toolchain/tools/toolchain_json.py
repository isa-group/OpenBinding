"""Write (or check) ``toolchain.json``: what a release of the BIM toolchain is, in one deterministic document.

    python tools/toolchain_json.py --output dist/toolchain.json
    python tools/toolchain_json.py --check dist/toolchain.json    # exit 1 if the file is not what this environment produces

The document records the versions of the three distributions, the ``compilerDigest`` and the identity of the
builtin Profiles and Dialects, the ``protocolDigest``, the digest of every JSON Schema, of the engine contract
and of the vendored XSDs, and the versions of Python, ``lxml`` (and libxml2), ``jsonschema`` and ``pyyaml`` the
digests were computed with.  There is no timestamp, path or host name: the same installation always gives the same
bytes.  It reads the *installed* distributions; only when ``bim_core`` is not importable does it fall back to the
``src`` directories of this repository.
"""

from __future__ import annotations

import argparse
import importlib.util
import json
import platform
import sys
from importlib import metadata
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
SCHEMA = "bim-toolchain/toolchain/1"

if importlib.util.find_spec("bim_core") is None:
    for _source in ("bim-core", "bim-service", "bim-client"):
        _path = ROOT / "packages" / _source / "src"
        if _path.is_dir() and str(_path) not in sys.path:
            sys.path.insert(0, str(_path))


def _file_digests(node: Any, suffix: str | None = None) -> dict[str, str]:
    from bim_core import digest_bytes

    return {
        child.name: digest_bytes(child.read_bytes())
        for child in sorted(node.iterdir(), key=lambda item: item.name)
        if child.is_file() and (suffix is None or child.name.endswith(suffix))
    }


def _distribution_version(name: str) -> str:
    return metadata.version(name)


def build() -> dict[str, Any]:
    """The document, from the installed ``bim_core``, ``bim_service`` and ``bim_client``."""
    import lxml.etree
    import yaml

    import bim_client
    import bim_core
    import bim_service
    from bim_core.assets import bpmn_vendor_root, engine_contract_bytes, schema_root

    identity = bim_core.toolchain_identity()
    return {
        "schema": SCHEMA,
        "packages": {
            "bim-client": bim_client.__version__,
            "bim-core": bim_core.__version__,
            "bim-service": bim_service.__version__,
        },
        "apiVersion": identity["apiVersion"],
        "compilerDigest": identity["compilerDigest"],
        "protocolDigest": bim_core.protocol_digest(),
        "engineContractDigest": bim_core.digest_bytes(engine_contract_bytes()),
        "profiles": identity["profiles"],
        "dialects": identity["dialects"],
        "schemas": _file_digests(schema_root(), ".schema.json"),
        "vendor": {"omg/bpmn/2.0.2": _file_digests(bpmn_vendor_root())},
        "runtime": {
            "python": platform.python_version(),
            "implementation": platform.python_implementation(),
            "lxml": ".".join(str(part) for part in lxml.etree.LXML_VERSION),
            "libxml2": ".".join(str(part) for part in lxml.etree.LIBXML_VERSION),
            "jsonschema": _distribution_version("jsonschema"),
            "pyyaml": yaml.__version__,
        },
    }


def render(document: dict[str, Any]) -> bytes:
    """The one byte representation: sorted keys, two-space indent, LF, no NaN."""
    return (json.dumps(document, sort_keys=True, indent=2, ensure_ascii=False, allow_nan=False) + "\n").encode("utf-8")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--output", type=Path, help="write the document here (default: standard output)")
    group.add_argument("--check", type=Path, help="compare this file with what the installation produces")
    arguments = parser.parse_args(argv)
    found = render(build())
    if arguments.check is not None:
        if not arguments.check.is_file():
            print(f"{arguments.check} does not exist")
            return 1
        if arguments.check.read_bytes() != found:
            print(f"{arguments.check} is not what this installation produces")
            return 1
        print(f"{arguments.check.name} matches")
        return 0
    if arguments.output is None:
        sys.stdout.write(found.decode("utf-8"))
        return 0
    arguments.output.parent.mkdir(parents=True, exist_ok=True)
    arguments.output.write_bytes(found)
    print(f"wrote {arguments.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
