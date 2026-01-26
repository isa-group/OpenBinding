import os
from typing import Dict, List, Any, Type
from ..validation.engine_plugins.base import EngineValidationPlugin
from ..validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from ..validation.engine_plugins.many_obj import ManyObjEnginePlugin

class EngineRegistry:
    _plugins: Dict[str, EngineValidationPlugin] = {}
    _engine_urls: Dict[str, str] = {
        "minizinc-csp": os.getenv("ENGINE_MINIZINC_URL", "http://engine-minizinc:3000"),
        "many-obj": os.getenv("ENGINE_MANY_OBJ_URL", "http://engine-many-obj:8080")
    }

    @classmethod
    def register(cls, engine_id: str, plugin: EngineValidationPlugin):
        cls._plugins[engine_id] = plugin

    @classmethod
    def get_plugin(cls, engine_id: str) -> EngineValidationPlugin:
        if engine_id not in cls._plugins:
            raise ValueError(f"Engine '{engine_id}' not found")
        return cls._plugins[engine_id]

    @classmethod
    def get_url(cls, engine_id: str) -> str:
        if engine_id not in cls._engine_urls:
             raise ValueError(f"Engine '{engine_id}' not configured")
        return cls._engine_urls[engine_id]
        
    @classmethod
    def list_engines(cls) -> List[Dict[str, Any]]:
        return [
            {
                "id": k, 
                "capabilities": v.get_capabilities()
            }
            for k, v in cls._plugins.items()
        ]

# Initialization
EngineRegistry.register("minizinc-csp", MiniZincCSPEnginePlugin())
EngineRegistry.register("many-obj", ManyObjEnginePlugin())
