"""Smoke test of the *installed* distributions. Run it with the interpreter of a clean virtual environment:

    .verify-venv/bin/python -I tools/smoke_installed.py packages/bim-core/tests/fixtures/example-package

``-I`` (isolated mode) ignores ``PYTHONPATH`` and every ``PYTHON*`` variable and does not put the script's
directory on ``sys.path``, so what is imported is what ``pip`` installed, never the source tree.  The script
refuses to run if ``bim_core`` is imported from a ``src`` layout directory.

It imports the three distributions, lists the package data through ``importlib.resources``, compiles the example
package, evaluates a binding, re-evaluates and validates an engine result, starts the service in process
(``TestClient``) and compiles the same package through it.  Exit status 0 and one JSON line on success; the line
carries the digests that CI compares between the installed wheel and the source tree.
"""

from __future__ import annotations

import argparse
import base64
import json
from importlib.resources import files
from importlib.resources.abc import Traversable
from pathlib import Path

BINDING = "binding.json"
EXPECTED_SCHEMAS = 12
EXPECTED_VENDOR = ("BPMN20.xsd", "BPMNDI.xsd", "DC.xsd", "DI.xsd", "README.md", "Semantic.xsd")


def check(condition: bool, message: str) -> None:
    if not condition:
        raise SystemExit(f"smoke test failed: {message}")


def listing(node: Traversable) -> list[str]:
    return sorted(child.name for child in node.iterdir())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    parser.add_argument(
        "example_dir", type=Path, help="the example: the package's JSON files plus binding.json (a binding, not a package entry)"
    )
    parser.add_argument("--allow-source-tree", action="store_true", help="do not refuse a src-layout import")
    arguments = parser.parse_args(argv)

    import bim_client
    import bim_core
    import bim_service

    location = Path(bim_core.__file__).resolve()
    if not arguments.allow_source_tree:
        check("site-packages" in location.parts, f"bim_core was not imported from an installation: {location}")

    # Package data, through importlib.resources only.
    root = files("bim_core")
    resources = root.joinpath("resources")
    schemas = [name for name in listing(resources.joinpath("schemas", "bim", "v1")) if name.endswith(".schema.json")]
    check(len(schemas) == EXPECTED_SCHEMAS, f"expected {EXPECTED_SCHEMAS} schemas, found {len(schemas)}")
    check(resources.joinpath("schemas", "engine-contract.openapi.yaml").is_file(), "engine contract is missing")
    vendor = listing(resources.joinpath("vendor", "omg", "bpmn", "2.0.2"))
    check(tuple(vendor) == EXPECTED_VENDOR, f"vendored OMG files differ: {vendor}")
    check(root.joinpath("py.typed").is_file(), "bim_core/py.typed is missing")
    for module in (bim_service, bim_client):
        check(files(module.__name__).joinpath("py.typed").is_file(), f"{module.__name__}/py.typed is missing")

    # Compile, evaluate, re-evaluate, validate.
    entries = {path.name: path.read_bytes() for path in sorted(arguments.example_dir.glob("*.json")) if path.name != BINDING}
    package = bim_core.load_package(bim_core.InstancePackage(entries).to_zip())
    problem = bim_core.compile_instance(package)
    binding = json.loads((arguments.example_dir / BINDING).read_text(encoding="utf-8"))
    evaluation = bim_core.evaluate(problem, binding)
    check({"features", "violations", "objectives"} <= set(evaluation), f"unexpected evaluation members: {sorted(evaluation)}")
    bare = {"termination": "FEASIBLE", "solutions": [{"decision": {"kind": "binding", "binding": binding}}]}
    honest = bim_core.reevaluate_result(problem, bare)
    result = {"termination": "FEASIBLE", "solutions": honest["solutions"], "provenance": {"engine": "smoke"}}
    bim_core.validate_result(result, finite=True)

    # The service, in process.
    from starlette.testclient import TestClient

    from bim_service.app import build_app
    from bim_service.auth import Authenticator
    from bim_service.settings import BimServiceSettings

    client = TestClient(build_app(BimServiceSettings(), Authenticator(anonymous=True)), base_url="http://bim.test")
    health = client.get("/healthz")
    check(health.status_code == 200, f"/healthz answered {health.status_code}")
    capabilities = client.get("/bim/v1/capabilities")
    check(capabilities.status_code == 200, f"/bim/v1/capabilities answered {capabilities.status_code}")
    validated = client.post("/bim/v1/validate-result", json={"result": result})
    check(validated.status_code == 200 and validated.json()["valid"] is True, f"validate-result: {validated.text[:200]}")
    body = {"package": base64.b64encode(package.to_zip()).decode("ascii"), "registeredResources": []}
    compiled = client.post("/bim/v1/compile", json=body)
    check(compiled.status_code == 200, f"/bim/v1/compile answered {compiled.status_code}: {compiled.text[:200]}")
    service_digest = compiled.json()["toolchain"]["compilerDigest"]
    check(service_digest == bim_core.compiler_bundle_digest(), "the service reports another compilerDigest")

    # The client port over the in-process implementation, with the same package.
    client_compiled = bim_client.InProcessBim().compile(package.to_zip())
    check(client_compiled["toolchain"]["compilerDigest"] == service_digest, "InProcessBim reports another compilerDigest")
    check(client_compiled["irDigest"] == compiled.json()["irDigest"], "InProcessBim and the service compile to different IRs")

    identity = bim_core.toolchain_identity()
    report = {
        "ok": True,
        "bimCore": bim_core.__version__,
        "bimService": bim_service.__version__,
        "bimClient": bim_client.__version__,
        "compilerDigest": identity["compilerDigest"],
        "serviceCompilerDigest": service_digest,
        "protocolDigest": bim_core.protocol_digest(),
        "irDigest": problem.digest,
        "schemas": len(schemas),
        "installedFrom": str(location.parent),
    }
    print(json.dumps(report, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
