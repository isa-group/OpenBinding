#!/usr/bin/env python3
"""Scaffold an engine, so that adding one is a command rather than a checklist.

Writes a manifest that is valid on the first try - the vocabularies are checked
here, before the file exists, rather than at the next gateway start - and,
only if asked, a plugin stub. An engine implementing the contract in
``schemas/engine-contract.openapi.yaml`` needs no plugin at all: the manifest
and an ``ENGINE_<ID>_URL`` are the whole registration.

    python tools/new_engine.py my-engine \\
        --display-name "My Engine" \\
        --type HEURISTIC \\
        --nodes TASK SEQ XOR \\
        --objectives MONO \\
        --constraints attribute_bound dependency \\
        --option "iterations_count:integer:1000" \\
        --option "seed:integer"

For a federated engine, ``--federated https://acme.example/openapi.json``
produces the transport block too, with the mappings left at their defaults for
you to point at your own field names. Nothing is registered by this script;
a federated manifest is submitted to ``POST /v1/engines``.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from typing import Any, Dict, List, Optional

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src"))

from openbinding_gateway.models import capabilities as vocab  # noqa: E402
from openbinding_gateway.models.manifest import EngineManifest  # noqa: E402
from openbinding_gateway.registry.discovery import url_env_var  # noqa: E402

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
MANIFESTS_DIR = os.path.join(REPO_ROOT, "schemas", "manifests")
PLUGINS_DIR = os.path.join(
    REPO_ROOT, "openbinding-gateway", "src", "openbinding_gateway", "validation", "engine_plugins"
)

JSON_TYPES = {"string", "integer", "number", "boolean", "object", "array"}


def parse_option(spec: str) -> tuple[str, Dict[str, Any]]:
    """``name:type[:default]`` into a JSON Schema property.

    Three fields because that is what an option is: what it is called, what
    shape it takes, and what the gateway sends when the caller says nothing.
    Omitting the default means the option is accepted but never volunteered.
    """
    parts = spec.split(":")
    if len(parts) not in (2, 3):
        raise argparse.ArgumentTypeError(
            f"--option wants name:type or name:type:default, got {spec!r}"
        )

    name, json_type = parts[0], parts[1]
    if json_type not in JSON_TYPES:
        raise argparse.ArgumentTypeError(
            f"{json_type!r} is not a JSON Schema type. Use one of: {', '.join(sorted(JSON_TYPES))}."
        )

    entry: Dict[str, Any] = {"type": json_type}
    if len(parts) == 3:
        raw = parts[2]
        if raw == "null":
            # Present and unset, which is not the same as absent: several
            # engines filter their options on "is not None".
            entry["type"] = [json_type, "null"]
            entry["default"] = None
        elif json_type == "integer":
            entry["default"] = int(raw)
        elif json_type == "number":
            entry["default"] = float(raw)
        elif json_type == "boolean":
            entry["default"] = raw.lower() in ("1", "true", "yes")
        else:
            entry["default"] = raw
    return name, entry


def build_manifest(args: argparse.Namespace) -> Dict[str, Any]:
    properties: Dict[str, Any] = {}
    for spec in args.option or []:
        name, entry = parse_option(spec)
        properties[name] = entry

    manifest: Dict[str, Any] = {
        "manifest_version": "1",
        "engine_id": args.engine_id,
        "display_name": args.display_name or args.engine_id,
        "description": args.description
        or f"{args.display_name or args.engine_id}. Say here when to reach for it.",
        "type": args.type,
        "capabilities": {
            "qos_features_supported": ["*"],
            "composition_nodes_supported": args.nodes,
            "objective_types_supported": args.objectives,
            "constraints_supported": args.constraints,
            "schema_version": "v1",
        },
        "options_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "title": f"{args.engine_id} options",
            "type": "object",
            # An unrecognised option draws a warning rather than a refusal, so
            # the schema says the same rather than promising a strictness
            # nobody enforces.
            "additionalProperties": True,
            "properties": properties,
        },
        # Deliberately permissive to begin with: an engine that accepts
        # everything the general schema accepts is a true starting point, and
        # narrowing it is the next piece of work rather than a blocker.
        "instance_schema": {
            "$schema": "https://json-schema.org/draft/2020-12/schema",
            "$id": f"https://openbinding.score.us.es/api/v1/schemas/{args.engine_id}",
            "title": f"{args.display_name or args.engine_id} Instance Schema",
            "description": (
                "Restricted profile of the general QoS schema. Narrow this to the "
                "instances the engine will actually solve."
            ),
            "type": "object",
        },
    }

    if args.federated:
        manifest["transport"] = {
            "openapi": {"url": args.federated},
            "operations": {"solve": {"operationId": "REPLACE_WITH_YOUR_OPERATION_ID"}},
            "request_mapping": {"instance": "/instance", "options": "/options"},
            "response_mapping": {"solutions": "/solutions", "binding": "/binding"},
        }

    return manifest


PLUGIN_TEMPLATE = '''"""The {display_name} engine.

A plugin is only needed for what a manifest cannot express: a request or
response shape that differs from the contract in
``schemas/engine-contract.openapi.yaml``, or a semantic check beyond a JSON
Schema. Capabilities, defaults, the options schema and the instance schema all
come from ``schemas/manifests/{engine_id}.manifest.json``.

Delete whichever of these methods you do not need - each one's default is
already correct for an engine that speaks the contract.
"""

from typing import Any, Dict, List, Tuple

from .base import EngineValidationPlugin, capability_violations
from ...models.api import ValidationViolation


class {class_name}(EngineValidationPlugin):
    engine_id = "{engine_id}"

    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        # capability_violations covers node kinds, objective type and
        # constraint families from the manifest. Add what a schema cannot say.
        return capability_violations(instance, self.get_capabilities())

    def transform_request(
        self, instance: Dict[str, Any], options: Dict[str, Any] = {{}}
    ) -> Tuple[Dict[str, Any], List[str]]:
        return {{"instance": instance, "options": options}}, self.unsupported_option_warnings(options)

    def transform_response(
        self, engine_response: Dict[str, Any], original_request: Dict[str, Any]
    ) -> Dict[str, Any]:
        # `binding` is the only field a solution must carry; the reference
        # evaluator derives everything else. Do not compute metrics here.
        return engine_response
'''


def class_name_for(engine_id: str) -> str:
    return "".join(part.capitalize() for part in engine_id.split("-")) + "EnginePlugin"


def module_name_for(engine_id: str) -> str:
    return engine_id.replace("-", "_")


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(
        description="Scaffold an engine manifest, and optionally a plugin stub.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=__doc__,
    )
    parser.add_argument("engine_id", help="Lower-case letters, digits and hyphens.")
    parser.add_argument("--display-name", help="What a person reads in the catalogue.")
    parser.add_argument("--description", help="One or two sentences.")
    parser.add_argument(
        "--type",
        choices=["EXACT", "HEURISTIC"],
        default="HEURISTIC",
        help="EXACT only if the search is exhaustive: it turns an empty answer into INFEASIBLE.",
    )
    parser.add_argument(
        "--nodes",
        nargs="+",
        default=["TASK", "SEQ", "AND", "XOR", "LOOP"],
        help=f"Composition nodes supported. Known: {', '.join(sorted(vocab.COMPOSITION_NODES))}.",
    )
    parser.add_argument(
        "--objectives",
        nargs="+",
        default=["MONO"],
        help=f"Objective types supported. Known: {', '.join(sorted(vocab.OBJECTIVE_TYPES))}.",
    )
    parser.add_argument(
        "--constraints",
        nargs="*",
        default=sorted(vocab.CONSTRAINT_FAMILIES),
        help=f"Constraint families enforced. Known: {', '.join(sorted(vocab.CONSTRAINT_FAMILIES))}.",
    )
    parser.add_argument(
        "--option",
        action="append",
        metavar="NAME:TYPE[:DEFAULT]",
        help="An option the engine accepts. Repeatable. Use :null for present-but-unset.",
    )
    parser.add_argument(
        "--federated",
        metavar="OPENAPI_URL",
        help="Produce a federated manifest with a transport block pointing at this document.",
    )
    parser.add_argument("--plugin", action="store_true", help="Also write a Python plugin stub.")
    parser.add_argument(
        "--force", action="store_true", help="Overwrite files that already exist."
    )
    parser.add_argument(
        "--print", dest="print_only", action="store_true", help="Print, do not write."
    )

    args = parser.parse_args(argv)

    manifest = build_manifest(args)

    # Validated before anything is written, so a mistyped capability is a
    # message here rather than an engine missing from the catalogue later.
    try:
        EngineManifest.model_validate(manifest)
    except Exception as error:
        print(f"That manifest would not be accepted:\n\n{error}", file=sys.stderr)
        return 1

    rendered = json.dumps(manifest, indent=2, ensure_ascii=False) + "\n"

    if args.print_only:
        print(rendered, end="")
        return 0

    if args.federated:
        # A federated engine is registered through the API, not by dropping a
        # file into the gateway's own manifest directory.
        target = os.path.join(os.getcwd(), f"{args.engine_id}.manifest.json")
    else:
        os.makedirs(MANIFESTS_DIR, exist_ok=True)
        target = os.path.join(MANIFESTS_DIR, f"{args.engine_id}.manifest.json")

    if os.path.exists(target) and not args.force:
        print(f"{target} already exists. Pass --force to overwrite.", file=sys.stderr)
        return 1

    with open(target, "w", encoding="utf-8") as handle:
        handle.write(rendered)
    print(f"Wrote {target}")

    if args.plugin:
        module = os.path.join(PLUGINS_DIR, f"{module_name_for(args.engine_id)}.py")
        if os.path.exists(module) and not args.force:
            print(f"{module} already exists. Pass --force to overwrite.", file=sys.stderr)
            return 1
        with open(module, "w", encoding="utf-8") as handle:
            handle.write(
                PLUGIN_TEMPLATE.format(
                    display_name=args.display_name or args.engine_id,
                    engine_id=args.engine_id,
                    class_name=class_name_for(args.engine_id),
                )
            )
        print(f"Wrote {module}")

    print()
    if args.federated:
        print("Next: fill in the operationId and the response mapping, then submit it to")
        print("      POST /v1/engines. See docs/ENGINE_MANIFEST.md.")
    else:
        print(f"Next: set {url_env_var(args.engine_id)} to where the engine listens.")
        if args.plugin:
            print(
                f"      Register {class_name_for(args.engine_id)} in registry/engine.py "
                f"if it needs to override anything;"
            )
            print("      otherwise delete the stub - the manifest alone is enough.")
        else:
            print("      Nothing else: the manifest is the registration.")

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
