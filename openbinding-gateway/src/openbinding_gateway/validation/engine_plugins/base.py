from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional
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
