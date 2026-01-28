from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
from ...models.api import ValidationViolation

class EngineValidationPlugin(ABC):
    @abstractmethod
    def get_capabilities(self) -> Dict[str, Any]:
        """Return engine capabilities including supported QoS, operators, etc."""
        pass

    @abstractmethod
    def get_specialization_schema_path(self) -> str:
        """Return absolute path to the specialization schema file."""
        pass

    @abstractmethod
    def validate_semantics(self, instance: Dict[str, Any]) -> List[ValidationViolation]:
        """Perform Stage 4 engine-specific semantic validation."""
        pass

    def transform_request(self, instance: Dict[str, Any], options: Dict[str, Any] = {}) -> Tuple[Dict[str, Any], List[str]]:
        """Transform general instance to engine-specific request payload. Returns (payload, warnings)."""
        # Default behavior: pass instance and options structure
        return {
            "instance": instance,
            "options": options
        }, []

    def transform_response(self, engine_response: Dict[str, Any], original_request: Dict[str, Any]) -> Dict[str, Any]:
        """Transform engine response to general solution format. Default: identity."""
        return engine_response
