"""Stage 2: does this instance fit the engine that was asked for?

The general schema says what an instance is. An engine's manifest says which of
those instances it is willing to solve - no LOOP nodes, MONO objectives only,
and so on. This checks the second, and it is why a caller gets told "this engine
does not take many-objective instances" instead of watching a solver fail.

The schema is asked of the engine rather than read off the disk, because the two
kinds of engine keep it in different places: an in-tree engine has a manifest
file, a registered one has a manifest row. Both answer the same question.
"""

import jsonschema  # type: ignore
from typing import Dict, Any, List
from ..models.api import ValidationViolation
from ..registry.engine import EngineRegistry


class ManifestSchemaValidator:
    def validate(self, engine_id: str, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []

        try:
            plugin = EngineRegistry.get_plugin(engine_id)
            schema = plugin.get_instance_schema()

            validator = jsonschema.Draft202012Validator(schema)

            for error in validator.iter_errors(instance):
                path_str = ".".join([str(p) for p in error.path]) if error.path else "root"
                violations.append(ValidationViolation(
                    message=error.message,
                    path=path_str,
                    code="manifest_schema_invalid",
                    constraint_id=None
                ))

        except Exception as e:
            violations.append(ValidationViolation(
                message=f"Failed to validate against the engine manifest: {str(e)}",
                code="manifest_validation_error"
            ))

        return violations
