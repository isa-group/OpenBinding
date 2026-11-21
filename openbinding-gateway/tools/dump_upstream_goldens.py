#!/usr/bin/env python3
"""Write the goldens of the upstream classifier (F6) over the recorded SPHERE set, offline.

For each case of ``tests/golden/upstream/cases.json`` it builds the classifier's inputs from recorded, derived or
scripted pricings and writes ``<case>.json`` (``{"event": false}`` when nothing happened, else the category, the
reasons, ``notify`` and the stored diff) next to it. Inputs name pricings by ``<pricingId>@<versionId>``, by
scenario (``fixtures/sphere/scenarios.json``) or by a file, optionally edited by dotted path (the recorder's
``YamlText``); origins come from a generator golden (``tests/golden/sphere``) or are computed from the old version
with the generator's own functions (``candidate_values``), as a seal would have stored them.

    python tools/dump_upstream_goldens.py              # rewrite tests/golden/upstream/
    python tools/dump_upstream_goldens.py --out DIR    # write to DIR instead (and nowhere else)
    python tools/dump_upstream_goldens.py --check      # fail if the checked-in goldens differ
"""

from __future__ import annotations

import argparse
import copy
import json
import sys
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "src"))
sys.path.insert(0, str(ROOT / "tools"))

import dump_sphere_goldens as sphere_goldens  # noqa: E402
import record_sphere_fixtures as recorder  # noqa: E402
from openbinding_gateway.modules.compositions.application import upstream_classify as uc  # noqa: E402
from openbinding_gateway.modules.plans.application import (  # noqa: E402
    PricingInvalid,
    Selection,
    functional_hash,
    pricing2yaml,
)
from openbinding_gateway.modules.problems.application import candidate_values  # noqa: E402
from openbinding_gateway.modules.problems.domain.sphere.recipe import parse_recipe  # noqa: E402

TESTS = ROOT / "tests"
SFX = TESTS / "fixtures" / "sphere"
DEFAULT_OUT = TESTS / "golden" / "upstream"
CASES = DEFAULT_OUT / "cases.json"
SPHERE = "https://sphere.score.us.es"


def _json(path: Path) -> Any:
    return json.loads(path.read_text(encoding="utf-8"))


def text(document: Any) -> bytes:
    return (json.dumps(document, indent=2, ensure_ascii=False) + "\n").encode("utf-8")


def _scenarios() -> dict[str, dict[str, Any]]:
    return {entry["scenario"]: entry for entry in _json(SFX / "scenarios.json")}


def pricing_bytes(spec: dict[str, Any]) -> tuple[bytes, dict[str, Any]]:
    """The YAML a side names and what is known of it (version id, label, createdAt)."""
    if "scenario" in spec:
        entry = _scenarios()[spec["scenario"]]
        data = (SFX / entry["file"]).read_bytes()
        meta = {"pricingId": entry["pricingId"], "versionId": entry["versionId"], "label": entry["label"],
                "createdAt": entry["createdAt"]}
    elif "file" in spec:
        data = (TESTS / spec["file"]).read_bytes()
        meta = {"pricingId": spec.get("pricingId"), "versionId": spec.get("versionId"), "label": spec.get("label"),
                "createdAt": spec.get("createdAt")}
    else:
        pricing_id, version_id = spec["ref"].split("@")
        data = (SFX / pricing_id / f"{version_id}.yml").read_bytes()
        manifest = _json(SFX / pricing_id / "manifest.json")
        entry = next(v for v in manifest["versions"] if v["versionId"] == version_id)
        meta = {"pricingId": pricing_id, "versionId": version_id, "label": entry["version"],
                "createdAt": entry["createdAt"]}
    if spec.get("edits"):
        document = recorder.YamlText(data.decode("utf-8"))
        for operation, path, value in spec["edits"]:
            document.apply(operation, path, value)
        data = document.text().encode("utf-8")
    for key in ("versionId", "label", "createdAt"):
        if key in spec:
            meta[key] = spec[key]
    return data, meta


def side(spec: dict[str, Any] | None) -> uc.Side | None:
    if spec is None:
        return None
    data, meta = pricing_bytes(spec)
    try:
        normalised = pricing2yaml.normalise_text(data)
        refusal = None
    except PricingInvalid as exc:
        normalised, refusal = None, exc.code
    url = f"{SPHERE}/p/{meta['pricingId']}?version={meta['versionId']}" if meta.get("pricingId") else None
    try:
        content_hash = functional_hash(data)
    except PricingInvalid:
        content_hash = None
    return uc.Side(meta.get("versionId"), meta.get("label"), meta.get("createdAt"), None, url, normalised, refusal,
                   content_hash)


class Recipes:
    """Pinned recipes: a generator golden case's, optionally edited, by ``{"case", "task", "pricing", "edit"}``."""

    def __init__(self) -> None:
        self.runner = sphere_goldens.Runner()

    def entry(self, spec: dict[str, Any] | None) -> uc.RecipeEntry | None:
        if spec is None:
            return None
        if "case" in spec:
            document = copy.deepcopy(self.runner.recipe_document(self.runner.by_name[spec["case"]]))
        else:
            document = copy.deepcopy(spec["recipe"])
        for path, value in (spec.get("edit") or {}).items():
            node = document
            *parents, last = path.split(".")
            for key in parents:
                node = node[int(key)] if isinstance(node, list) else node.setdefault(key, {})
            node[last] = value
        recipe, problems = parse_recipe(document)
        if recipe is None:
            raise ValueError(f"the recipe of {spec} does not parse: {problems}")
        task = next(t for t in recipe.tasks if t.task == spec["task"])
        source = next(s for s in task.sources if s.sphere is not None and s.sphere.pricing == spec["pricing"])
        meta = sphere_goldens.recorded_meta(source.sphere.pricing, source.sphere.version)
        return uc.RecipeEntry(recipe, task, source, meta)


def origins(spec: Any, entry: uc.EntryInput, old: uc.Side | None, features: set[str]) -> tuple[uc.Origin, ...]:
    if not spec:
        return ()
    if spec == "computed":
        assert entry.recipe is not None and old is not None and old.pricing is not None
        judged = candidate_values(
            entry.recipe.source, entry.recipe.meta, entry.recipe.task, entry.recipe.recipe, old.pricing,
            entry.selection.plan, list(entry.selection.add_ons), billing=entry.selection.billing,
            seats=entry.selection.seats, feature_targets=features,
        )
        assert judged.eligible, judged.reason
        return tuple(
            uc.Origin(target, "feature" if target in features else "property", kind, value, detail)
            for target, (value, kind, detail) in sorted(judged.values.items())
        )
    stored = _json(sphere_goldens.DEFAULT_OUT / f"{spec['golden']}.origins.json")
    rows = [row for row in stored if row["candidateKey"] == spec["candidate"]]
    assert rows, spec
    edits = spec.get("edit") or {}
    return tuple(
        uc.Origin(row["target"], row["targetKind"], row["sourceKind"], edits.get(row["target"], row["value"]),
                  row["detail"])
        for row in rows
    )


def context(spec: dict[str, Any]) -> uc.BindingContext:
    rules = {
        name: uc.FeatureRule(item.get("aggregation"), item.get("scope"), item.get("unit"))
        for name, item in (spec.get("features") or {}).items()
    }
    return uc.BindingContext(spec.get("valuesStatus", "verified"), spec.get("values") or {}, rules)


def margin_input(spec: dict[str, Any]) -> uc.MarginInput:
    return uc.MarginInput(spec["values"], spec.get("valuesStatus", "verified"), spec.get("outcome", "verified"),
                          spec.get("users"), spec.get("environment"), spec.get("adoption"), spec.get("evaluation"),
                          spec.get("version"))


def run(case: dict[str, Any], recipes: Recipes) -> dict[str, Any]:
    old = side(case["old"])
    new = side(case.get("new"))
    facts = uc.Facts(case["pricing"], gone=bool(case.get("gone")), withdrawn=bool(case.get("withdrawn")))
    if case["kind"] == "offering":
        found = uc.classify_offering(
            old, new, facts, [margin_input(item) for item in case.get("environments", [])],
            margin_input(case["latest"]) if case.get("latest") else None,
        )
    else:
        if case.get("sameId") and new is not None and old.content_hash == new.content_hash:
            return {"event": False, "why": "same version id and functional hash (a rename)"}
        ctx = context(case.get("context") or {})
        entries = []
        for item in case["entries"]:
            selection = Selection.of(item["selection"]["plan"], item["selection"].get("addOns", []),
                                     item["selection"].get("billing"), item["selection"].get("seats"))
            entry = uc.EntryInput(item["task"], item["candidate"], selection, (), recipes.entry(item.get("recipe")))
            features = set(ctx.features)
            entry = uc.EntryInput(entry.task, entry.candidate, selection,
                                  origins(item.get("origins"), entry, old, features), entry.recipe)
            entries.append(entry)
        found = uc.classify_binding(old, new, facts, entries, ctx)
    if found is None:
        return {"event": False, "why": "equal functional hash"}
    return {
        "event": True, "category": found.category.value, "reasons": list(found.reasons), "notify": found.notify,
        "classifier": uc.CLASSIFIER_VERSION, "diff": found.diff,
    }


def outputs(document: dict[str, Any] | None = None) -> dict[str, bytes]:
    document = document if document is not None else _json(CASES)
    recipes = Recipes()
    return {f"{case['name']}.json": text(run(case, recipes)) for case in document["cases"]}


def written(directory: Path) -> dict[str, bytes]:
    return {p.name: p.read_bytes() for p in sorted(directory.glob("*.json")) if p.name != "cases.json"}


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--out", type=Path, help="write the goldens here instead of tests/golden/upstream")
    group.add_argument("--check", action="store_true", help="fail if the checked-in goldens differ")
    args = parser.parse_args(argv)
    wanted = outputs()
    if args.check:
        current = written(DEFAULT_OUT)
        drift = sorted(name for name in set(wanted) | set(current) if wanted.get(name) != current.get(name))
        if drift:
            print("upstream classifier goldens differ: " + ", ".join(drift), file=sys.stderr)
            print("Regenerate them with: python tools/dump_upstream_goldens.py", file=sys.stderr)
            return 1
        print(f"{len(wanted)} upstream classifier goldens match.")
        return 0
    target = args.out or DEFAULT_OUT
    target.mkdir(parents=True, exist_ok=True)
    if target == DEFAULT_OUT:
        for stale in written(target):
            if stale not in wanted:
                (target / stale).unlink()
    for name, content in wanted.items():
        (target / name).write_bytes(content)
    print(f"wrote {len(wanted)} goldens to {target}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
