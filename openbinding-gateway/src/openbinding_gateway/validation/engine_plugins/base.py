from abc import ABC, abstractmethod
from typing import List, Dict, Any, Optional, Tuple
import httpx
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

    @abstractmethod
    async def check_engine_health(self, base_url: str, client: httpx.AsyncClient) -> bool:
        """Return True if the engine is reachable and healthy.

        Each engine must implement its own logic because health endpoints/semantics
        may differ across engines.
        """
        raise NotImplementedError

    def get_default_options(self) -> Dict[str, Any]:
        """Return gateway-level default options for this engine.

        These defaults are intended to populate the request `options` object when
        the client does not specify any values.
        """
        return {}

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
