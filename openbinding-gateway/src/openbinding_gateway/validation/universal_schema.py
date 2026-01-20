import os
import json
import jsonschema # type: ignore
from typing import Dict, Any, List, Optional
from ..models.api import ValidationViolation

class UniversalSchemaValidator:
    def __init__(self):
        # Locate universal schema
        # We assume it's at schemas/universal/schema.json relative to project root or configured path
        # In this environment, we put it in <root>/schemas/universal/schema.json
        # The gateway runs in /app, so ../schemas/universal/schema.json typically
        # Or use absolute path env var
        
        self.schema_path = os.getenv("UNIVERSAL_SCHEMA_PATH", "/app/schemas/universal/schema.json")
        if not os.path.exists(self.schema_path):
             # Fallback for local run
             self.schema_path = os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../../../../schemas/universal/schema.json"))

        with open(self.schema_path, 'r') as f:
            self.schema = json.load(f)
            
    def validate(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        validator = jsonschema.Draft202012Validator(self.schema)
        
        for error in validator.iter_errors(instance):
            path_str = ".".join([str(p) for p in error.path]) if error.path else "root"
            violations.append(ValidationViolation(
                message=error.message,
                path=path_str,
                code="universal_schema_invalid",
                constraint_id=None
            ))
            
        return violations
