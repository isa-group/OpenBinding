import os
import json
import jsonschema # type: ignore
from typing import Dict, Any, List, Optional
from ..models.api import ValidationViolation

class GeneralSchemaValidator:
    def __init__(self):
        # Locate general schema
        # We assume it's at schemas/general/schema.json relative to project root or configured path
        # In this environment, we put it in <root>/schemas/general/schema.json
        # The gateway runs in /app, so ../schemas/general/schema.json typically
        # Or use absolute path env var
        
        # Try env var first
        env_path = os.getenv("GENERAL_SCHEMA_PATH")
        if env_path and os.path.exists(env_path):
            self.schema_path = env_path
        else:
             # Fallback: assume we are in src/openbinding_gateway/validation
             # and schema is in <project_root>/schemas/general/schema.json
             # "src" is 3 levels deep from root? No, openbinding-gateway is project root for python package usually?
             # Let's try relative to this file
             current_dir = os.path.dirname(os.path.abspath(__file__))
             # Up: validation -> openbinding_gateway -> src -> openbinding-gateway (root) -> (workspace) -> schemas
             # Wait, structure is:
             # Workspace/OpenBinding/openbinding-gateway/src/openbinding_gateway/validation/general_schema.py
             # General schema: Workspace/OpenBinding/schemas/general/schema.json
             # So we need to go up: validation(1) -> openbinding_gateway(2) -> src(3) -> openbinding-gateway(4) -> OpenBinding(5)
             
             possible_path = os.path.abspath(os.path.join(current_dir, "../../../../../schemas/general/schema.json"))
             
             if os.path.exists(possible_path):
                 self.schema_path = possible_path
             else:
                 # Try typical Docker location
                 self.schema_path = "/app/schemas/general/schema.json"

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
                code="general_schema_invalid",
                constraint_id=None
            ))
            
        return violations
