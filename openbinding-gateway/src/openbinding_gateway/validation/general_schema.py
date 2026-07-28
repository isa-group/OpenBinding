from typing import Any, Dict, List

import jsonschema  # type: ignore

from ..models.api import ValidationViolation
from .schema_bundle import load_general_schema, resolve_schema_path  # noqa: F401


class GeneralSchemaValidator:
    """Stage 1: does the instance match the general schema at all?"""

    def __init__(self):
        self.schema = load_general_schema()

    def validate(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        validator = jsonschema.Draft202012Validator(self.schema)

        for error in validator.iter_errors(instance):
            path_str = ".".join([str(p) for p in error.path]) if error.path else "root"
            violations.append(ValidationViolation(
                message=error.message,
                path=path_str,
                code="general_schema_invalid",
                constraint_id=None,
            ))

        return violations
