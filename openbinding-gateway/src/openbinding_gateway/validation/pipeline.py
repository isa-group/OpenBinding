from typing import Dict, Any, List
from ..models.api import ValidationViolation
from ..registry.engine import EngineRegistry
from .general_schema import GeneralSchemaValidator
from .specialization_schema import SpecializationSchemaValidator
from .semantic_general import GeneralSemanticValidator
from .normalization import apply_objective_defaults

class ValidationPipeline:
    def __init__(self):
        self.general_validator = GeneralSchemaValidator()
        self.specialization_validator = SpecializationSchemaValidator()
        self.semantic_validator = GeneralSemanticValidator()
        
    def validate_general_schema(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        # Stage 1: General Structural Validation
        return self.general_validator.validate(instance)
        
    def validate_full(self, engine_id: str, instance: Dict[str, Any]) -> List[ValidationViolation]:
        violations = []
        
        # Stage 0: Engine Lookup
        try:
            plugin = EngineRegistry.get_plugin(engine_id)
        except ValueError:
            return [ValidationViolation(
                message=f"Engine '{engine_id}' not found",
                code="engine_not_found"
            )]

        # Apply defaults that are expressed in JSON Schema but not materialized by jsonschema.
        apply_objective_defaults(instance)
            
        # Stage 2: Specialization Structural Validation
        v2 = self.specialization_validator.validate(engine_id, instance)
        if v2:
            return v2
            
        # Stage 3: General Semantic Validation
        v3 = self.semantic_validator.validate(instance)
        if v3:
            # We can return here or continue. Usually semantic issues block further checks.
            return v3
            
        # Stage 4: Engine Semantic Validation
        v4 = plugin.validate_semantics(instance)
        violations.extend(v4)
        
        return violations

    def validate(self, engine_id: str, instance: Dict[str, Any]) -> List[ValidationViolation]:
        # Backward compatibility / Full validation
        v1 = self.validate_general_schema(instance)
        if v1:
            return v1
        return self.validate_full(engine_id, instance)
