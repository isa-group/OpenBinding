import json
import jsonschema # type: ignore
from typing import Dict, Any, List
from ..models.api import ValidationViolation
from ..registry.engine import EngineRegistry

class SpecializationSchemaValidator:
    def validate(self, engine_id: str, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        try:
            plugin = EngineRegistry.get_plugin(engine_id)
            schema_path = plugin.get_specialization_schema_path()
            
            with open(schema_path, 'r') as f:
                schema = json.load(f)
                
            validator = jsonschema.Draft202012Validator(schema)
            
            for error in validator.iter_errors(instance):
                path_str = ".".join([str(p) for p in error.path]) if error.path else "root"
                violations.append(ValidationViolation(
                    message=error.message,
                    path=path_str,
                    code="specialization_schema_invalid",
                    constraint_id=None
                ))
                
        except Exception as e:
            violations.append(ValidationViolation(
                message=f"Failed to perform specialization validation: {str(e)}",
                code="specialization_validation_error"
            ))
            
        return violations
