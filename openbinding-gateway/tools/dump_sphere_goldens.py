#!/usr/bin/env python3
"""Write the goldens of the SPHERE package generator over the recorded SPHERE set.

For each case of ``tests/golden/sphere/cases.json`` it runs ``generate`` over the recorded snapshots
(``tests/fixtures/sphere``; synthetic versions as the file's ``derived`` says) and writes, next to it:

- ``<case>.files.json``: the generated package as a JSON file map (``{"<path>": <JSON document>}``), never a
  package directory: a directory holding an ``instance.json`` would join the fixed BIM corpus;
- ``<case>.origins.json``, ``<case>.diagnostics.json``, ``<case>.requirements.json``;
- ``<case>.package.digest`` and ``<case>.facts.json``: the package digest and the facts of its compilation by
  the installed toolchain.

A refused case writes only its diagnostics.

    python tools/dump_sphere_goldens.py              # rewrite tests/golden/sphere/
    python tools/dump_sphere_goldens.py --out DIR    # write to DIR instead (and nowhere else)
    python tools/dump_sphere_goldens.py --check      # fail if the checked-in goldens differ
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))

from openbinding_gateway.modules.plans.application import parse_sync  # noqa: E402
from openbinding_gateway.modules.problems.application.sphere import (  # noqa: E402
    Generated,
    SnapshotMeta,
    SourcePricing,
    dump,
    generate,
)
from openbinding_gateway.modules.problems.domain.sphere.recipe import Recipe, parse_recipe  # noqa: E402

TESTS = ROOT / "tests"
SFX = TESTS / "fixtures" / "sphere"
DEFAULT_OUT = TESTS / "golden" / "sphere"
CASES = DEFAULT_OUT / "cases.json"
REPO = Path(os.environ.get("OPENBINDING_REPO_ROOT", ROOT.parent))
#: The TomatoMeter base problem, a JSON file map (also the frontend fixtures' J2 base).
RUNNER_BASE_BUNDLE = "examples/tomatometer/tomatometer-email.base.json"
#: What a run writes for a case; a refused case writes only the diagnostics.
SUFFIXES = (".files.json", ".origins.json", ".diagnostics.json", ".requirements.json", ".package.digest", ".facts.json")


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def text(document: Any) -> bytes:
    return (json.dumps(document, indent=2, sort_keys=True, ensure_ascii=False) + "\n").encode("utf-8")


@dataclass
class Case:
    name: str
    recipe: Recipe | None
    problems: list[dict[str, Any]]
    sources: dict[Any, SourcePricing]
    base: dict[str, bytes] | None
    previous: Recipe | None
    problem: str


def recorded_meta(pricing_id: str, version_id: str, label: str | None = None) -> SnapshotMeta:
    """What a snapshot of a recorded version knows: the owner and slug from the permalink and the organization,
    the label and permanent link from the manifest."""
    owner = slug = permanent = latest = None
    version_label = label or ""
    manifest_path = SFX / pricing_id / "manifest.json"
    if manifest_path.is_file():
        manifest = _json(manifest_path)
        permanent = manifest.get("permanentUrl")
        latest = manifest.get("latestVersionId")
        for entry in manifest.get("versions", []):
            if entry.get("versionId") == version_id and label is None:
                version_label = str(entry.get("version"))
    permalink = SFX / "permalinks" / f"{pricing_id}.json"
    if permalink.is_file():
        location = _json(permalink)["location"].split("?")[0].strip("/").split("/")
        organization, slug = location[1], location[2]
        organization_file = SFX / "orgs" / f"{organization}.json"
        if organization_file.is_file():
            owner = _json(organization_file).get("name")
    return SnapshotMeta(
        pricing_id=pricing_id, version_id=version_id, owner=owner, slug=slug, title="",
        version_label=version_label, permanent_url=permanent, latest_version_id=latest,
    )


def read_source(path: Path, meta: SnapshotMeta) -> SourcePricing:
    parsed = parse_sync(path.read_bytes())
    refusal = (parsed.refusal.code, parsed.refusal.message) if parsed.refusal is not None else None
    return SourcePricing(meta, parsed.normalised, refusal)


def recorded_sources(recipe: Recipe, derived: dict[str, Any] | None = None) -> dict[Any, SourcePricing]:
    derived = derived if derived is not None else _json(CASES).get("derived", {})
    out = {}
    for ref in recipe.distinct_sources():
        key = f"{ref.pricing}@{ref.version}"
        if key in derived:
            path = TESTS / derived[key]["file"]
            meta = recorded_meta(ref.pricing, ref.version, derived[key]["label"])
        else:
            path = SFX / ref.pricing / f"{ref.version}.yml"
            meta = recorded_meta(ref.pricing, ref.version)
        if path.is_file():
            out[ref.key] = read_source(path, meta)
    return out


def bundle_files(path: Path) -> dict[str, bytes]:
    """A JSON file map as package files (each document in canonical form)."""
    return {name: dump(document) for name, document in _json(path).items()}


def directory_files(path: Path) -> dict[str, bytes]:
    return {p.relative_to(path).as_posix(): p.read_bytes() for p in sorted(path.rglob("*")) if p.is_file()}


def _resolve(document: Any, pointer: str) -> tuple[Any, str]:
    parts = [p.replace("~1", "/").replace("~0", "~") for p in pointer.split("/")[1:]]
    for part in parts[:-1]:
        document = document[int(part)] if isinstance(document, list) else document[part]
    return document, parts[-1]


def _edit(files: dict[str, bytes], spec: dict[str, Any]) -> dict[str, bytes]:
    files = dict(files)
    for path, pointer, value in spec.get("baseSet", []):
        document = json.loads(files[path])
        parent, last = _resolve(document, pointer)
        parent[last] = value
        files[path] = dump(document)
    for path, pointer in spec.get("baseRemove", []):
        document = json.loads(files[path])
        parent, last = _resolve(document, pointer)
        del parent[last]
        files[path] = dump(document)
    return files


class Runner:
    def __init__(self, cases: dict[str, Any] | None = None) -> None:
        self.document = cases if cases is not None else _json(CASES)
        self.by_name = {case["name"]: case for case in self.document["cases"]}
        self._generated: dict[str, Generated] = {}
        self._loaded: dict[str, Case] = {}

    def recipe_document(self, case: dict[str, Any]) -> Any:
        recipe = case["recipe"]
        if isinstance(recipe, dict) and set(recipe) == {"file"}:
            return _json(REPO / recipe["file"])
        return recipe

    def load(self, name: str) -> Case:
        if name in self._loaded:
            return self._loaded[name]
        case = self.by_name[name]
        recipe, problems = parse_recipe(self.recipe_document(case))
        base = previous = None
        spec = case.get("base")
        if spec is not None:
            if "bundle" in spec:
                base = bundle_files(REPO / spec["bundle"])
            elif "dir" in spec:
                base = directory_files(REPO / spec["dir"])
            else:
                base = dict(self.generated(spec["case"]).files)
                previous = self.load(spec["case"]).recipe
            base = _edit(base, spec)
        sources = recorded_sources(recipe, self.document.get("derived", {})) if recipe is not None else {}
        loaded = Case(name, recipe, [p.as_dict() for p in problems], sources, base, previous, case.get("problem", name))
        self._loaded[name] = loaded
        return loaded

    def generated(self, name: str) -> Generated:
        if name not in self._generated:
            case = self.load(name)
            assert case.recipe is not None, f"{name} is refused by the recipe parser"
            self._generated[name] = generate(case.recipe, case.sources, case.base, case.previous, name=case.problem)
        return self._generated[name]

    def outputs(self, name: str, *, toolchain: bool = True) -> dict[str, bytes]:
        """Every golden file of a case, by file name (without the digest and facts when not ``toolchain``)."""
        case = self.load(name)
        if case.recipe is None:
            return {f"{name}.diagnostics.json": text(case.problems)}
        result = self.generated(name)
        out = {f"{name}.diagnostics.json": text([d.as_dict() for d in result.diagnostics])}
        if not result.files:
            return out
        out[f"{name}.files.json"] = text({path: json.loads(content) for path, content in sorted(result.files.items())})
        out[f"{name}.origins.json"] = text(result.origins)
        out[f"{name}.requirements.json"] = text(result.requirements)
        if not toolchain:
            return out
        digest, facts = asyncio.run(compiled(result))
        out[f"{name}.package.digest"] = (digest + "\n").encode()
        out[f"{name}.facts.json"] = text(facts)
        return out

    def all_outputs(self) -> dict[str, bytes]:
        out: dict[str, bytes] = {}
        for case in self.document["cases"]:
            out.update(self.outputs(case["name"]))
        return out


async def compiled(result: Generated) -> tuple[str, dict[str, Any]]:
    """The package digest and the facts of the generated package's compilation."""
    from openbinding_gateway.modules.problems.application import analysis_summary, compile_package
    from openbinding_gateway.modules.problems.application.facts import compilation_facts

    compilation = await compile_package(result.archive())
    facts = compilation_facts(
        compilation.ir, compilation.source_map, analysis_summary(compilation.ir, compilation.analysis),
        ir_digest=compilation.ir_digest,
    )
    return compilation.package_digest, facts


def written(directory: Path) -> dict[str, bytes]:
    return {
        p.name: p.read_bytes() for p in sorted(directory.iterdir())
        if p.is_file() and any(p.name.endswith(suffix) for suffix in SUFFIXES)
    }


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--out", type=Path, help="write the goldens here instead of tests/golden/sphere")
    group.add_argument("--check", action="store_true", help="fail if the checked-in goldens differ")
    args = parser.parse_args(argv)
    outputs = Runner().all_outputs()
    if args.check:
        current = written(DEFAULT_OUT)
        drift = sorted(name for name in set(outputs) | set(current) if outputs.get(name) != current.get(name))
        if drift:
            print("SPHERE generator goldens differ: " + ", ".join(drift), file=sys.stderr)
            print("Regenerate them with: python tools/dump_sphere_goldens.py", file=sys.stderr)
            return 1
        print(f"{len(outputs)} SPHERE generator goldens match.")
        return 0
    target = args.out or DEFAULT_OUT
    target.mkdir(parents=True, exist_ok=True)
    for stale in written(target):
        if stale not in outputs:
            (target / stale).unlink()
    for name, content in outputs.items():
        (target / name).write_bytes(content)
    print(f"Wrote {len(outputs)} SPHERE generator goldens to {target}.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
