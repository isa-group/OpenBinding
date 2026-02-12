from __future__ import annotations

import copy
from typing import Any, Dict, List, Tuple

import jsonschema  # type: ignore
from referencing import Registry, Resource  # type: ignore


class SchemaModel:
    def __init__(self, schema: Dict[str, Any]):
        self.schema = schema
        schema_id = schema.get("$id") or "schema://openbinding/general"
        resource = Resource.from_contents(schema)
        self.registry = Registry().with_resource(schema_id, resource)

    def apply_defaults(self, instance: Dict[str, Any]) -> List[Tuple[str, Any]]:
        original = copy.deepcopy(instance)

        validator_cls = self._defaulting_validator()
        validator = validator_cls(self.schema, registry=self.registry)
        list(validator.iter_errors(instance))

        return self._diff_defaults(original, instance)

    def _defaulting_validator(self):
        validate_properties = jsonschema.Draft202012Validator.VALIDATORS["properties"]
        validate_one_of = jsonschema.Draft202012Validator.VALIDATORS["oneOf"]
        validate_any_of = jsonschema.Draft202012Validator.VALIDATORS["anyOf"]

        def set_defaults(validator, properties, instance, schema):
            if not isinstance(instance, dict):
                return
            for prop, subschema in properties.items():
                if "default" in subschema and prop not in instance:
                    instance[prop] = copy.deepcopy(subschema["default"])
            for error in validate_properties(validator, properties, instance, schema):
                yield error

        def select_schema(validator, schemas, instance):
            if not schemas:
                return None
            best_schema = None
            best_errors = None
            for candidate in schemas:
                errors = list(validator.evolve(schema=candidate).iter_errors(instance))
                if not errors:
                    return candidate
                if best_errors is None or len(errors) < len(best_errors):
                    best_errors = errors
                    best_schema = candidate
            return best_schema

        def default_one_of(validator, one_of_schemas, instance, schema):
            if isinstance(instance, dict):
                selected = select_schema(validator, one_of_schemas, instance)
                if selected is not None:
                    for error in validator.descend(instance, selected, path=(), schema_path=()):
                        yield error
                    return
            for error in validate_one_of(validator, one_of_schemas, instance, schema):
                yield error

        def default_any_of(validator, any_of_schemas, instance, schema):
            if isinstance(instance, dict):
                selected = select_schema(validator, any_of_schemas, instance)
                if selected is not None:
                    for error in validator.descend(instance, selected, path=(), schema_path=()):
                        yield error
                    return
            for error in validate_any_of(validator, any_of_schemas, instance, schema):
                yield error

        return jsonschema.validators.extend(
            jsonschema.Draft202012Validator,
            {"properties": set_defaults, "oneOf": default_one_of, "anyOf": default_any_of},
        )

    def _diff_defaults(self, original: Any, updated: Any, path: str = "") -> List[Tuple[str, Any]]:
        changes: List[Tuple[str, Any]] = []

        if isinstance(updated, dict):
            original_map = original if isinstance(original, dict) else {}
            for key, value in updated.items():
                next_path = f"{path}.{key}" if path else str(key)
                if key not in original_map:
                    changes.append((next_path, value))
                else:
                    changes.extend(self._diff_defaults(original_map.get(key), value, next_path))
            return changes

        if isinstance(updated, list):
            original_list = original if isinstance(original, list) else []
            for idx, value in enumerate(updated):
                next_path = f"{path}[{idx}]" if path else f"[{idx}]"
                if idx >= len(original_list):
                    changes.append((next_path, value))
                else:
                    changes.extend(self._diff_defaults(original_list[idx], value, next_path))
            return changes

        return changes
