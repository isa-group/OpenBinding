from typing import Dict, Any, List, Tuple
from ..models.api import ValidationViolation
from ..registry.engine import EngineRegistry
from ..semantics.desugar import desugar_instance
from ..semantics.errors import DesugarError
from .general_schema import GeneralSchemaValidator
from .specialization_schema import SpecializationSchemaValidator
from .semantic_general import GeneralSemanticValidator
from .schema_model import SchemaModel

class ValidationPipeline:
    def __init__(self):
        self.general_validator = GeneralSchemaValidator()
        self.specialization_validator = SpecializationSchemaValidator()
        self.semantic_validator = GeneralSemanticValidator()
        self.schema_model = SchemaModel(self.general_validator.schema)

    def validate_general_schema(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        # Stage 1: General Structural Validation
        return self._tag_stage(self.general_validator.validate(instance), "general_schema")
        
    def validate_full(self, engine_id: str, instance: Dict[str, Any]) -> Tuple[List[ValidationViolation], List[Tuple[str, Any]]]:
        violations: List[ValidationViolation] = []
        default_warnings: List[Tuple[str, Any]] = []
        
        # Stage 0: Engine Lookup
        try:
            plugin = EngineRegistry.get_plugin(engine_id)
        except ValueError:
            return self._tag_stage([ValidationViolation(
                message=f"Engine '{engine_id}' not found",
                code="engine_not_found"
            )], "engine_lookup"), []

        # Stage 1b: Expand the authoring shorthands. Everything after this point -
        # the engine profiles, the semantic checks, the engines themselves - reads
        # one form only, so it is done in place on the instance the caller holds.
        try:
            self.desugar_in_place(instance)
        except DesugarError as exc:
            return self._tag_stage([ValidationViolation(
                message=str(exc),
                code="ambiguous_shorthand"
            )], "desugar"), []

        # Apply defaults expressed in the general schema to keep semantic checks consistent.
        default_warnings = self.schema_model.apply_defaults(instance)

        # Stage 2: Specialization Structural Validation
        v2 = self.specialization_validator.validate(engine_id, instance)
        if v2:
            return self._tag_stage(v2, "specialization_schema"), default_warnings
            
        # Stage 3: General Semantic Validation
        v3 = self.semantic_validator.validate(instance)
        if v3:
            # We can return here or continue. Usually semantic issues block further checks.
            return self._tag_stage(v3, "semantic"), default_warnings
            
        # Stage 4: Engine Semantic Validation
        v4 = plugin.validate_semantics(instance)
        violations.extend(self._tag_stage(v4, "engine_semantic"))
        
        return violations, default_warnings

    @staticmethod
    def desugar_in_place(instance: Dict[str, Any]) -> Dict[str, Any]:
        """Replace ``instance`` with its canonical form, keeping the same object.

        Callers hold on to the dict they passed in and hand it to the engine
        afterwards, so expanding into a copy would leave them with the sugared
        version.
        """
        canonical = desugar_instance(instance)
        if canonical is not instance:
            instance.clear()
            instance.update(canonical)
        return instance

    def validate(self, engine_id: str, instance: Dict[str, Any]) -> Tuple[List[ValidationViolation], List[Tuple[str, Any]]]:
        # Backward compatibility / Full validation
        v1 = self.validate_general_schema(instance)
        if v1:
            return v1, []
        return self.validate_full(engine_id, instance)

    def _tag_stage(self, violations: List[ValidationViolation], stage: str) -> List[ValidationViolation]:
        for violation in violations:
            if getattr(violation, "stage", None) is None:
                violation.stage = stage
        return violations
