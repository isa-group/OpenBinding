import os
import json
from pathlib import Path
import jsonschema # type: ignore
from typing import Dict, Any, List, Optional
from ..models.api import ValidationViolation


def _resolve_schema_path(env_var: str, filename: str) -> Path:
    env_path = os.getenv(env_var)
    schema_candidates: List[Path] = []
    if env_path:
        schema_candidates.append(Path(env_path))

    # Support both layouts:
    # - gateway repo has its own schemas/: <openbinding-gateway>/schemas/general/<filename>
    # - monorepo has schemas/ at the workspace root: <OpenBinding>/schemas/general/<filename>
    this_file = Path(__file__).resolve()
    schema_candidates.extend(
        [
            this_file.parents[3] / "schemas" / "general" / filename,
            this_file.parents[4] / "schemas" / "general" / filename,
            Path(f"/app/schemas/general/{filename}"),
        ]
    )

    schema_path: Optional[Path] = next((p for p in schema_candidates if p.exists()), None)
    if schema_path is None:
        raise FileNotFoundError(
            f"Schema '{filename}' not found. Tried: " + ", ".join(str(p) for p in schema_candidates)
        )
    return schema_path


class GeneralSchemaValidator:
    def __init__(self):
        with open(_resolve_schema_path("GENERAL_SCHEMA_PATH", "schema.json"), "r") as f:
            self.schema = json.load(f)

    def validate(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        validator = jsonschema.Draft202012Validator(self.schema)

        for error in validator.iter_errors(instance):
            path_str = ".".join([str(p) for p in error.path]) if error.path else "root"
            violations.append(ValidationViolation(
                message=error.message,
                path=path_str,
                code="general_schema_invalid",
                constraint_id=None
            ))

        return violations
