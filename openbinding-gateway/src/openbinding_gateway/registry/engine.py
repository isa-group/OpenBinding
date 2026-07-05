import os
from typing import Dict, List, Any, Type
from ..validation.engine_plugins.base import EngineValidationPlugin
from ..validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from ..validation.engine_plugins.random_search import RandomSearchEnginePlugin
from ..validation.engine_plugins.many_heuristic import ManyHeuristicEnginePlugin
from ..validation.engine_plugins.evolutionary_heuristics import EvolutionaryHeuristicsEnginePlugin

class EngineRegistry:
    # Keeps track of all solver engines and where to find them.
    _plugins: Dict[str, EngineValidationPlugin] = {}
    _engine_urls: Dict[str, str] = {
        "minizinc-csp": os.getenv("ENGINE_MINIZINC_URL", "http://engine-minizinc:3000"),
        "random-search": os.getenv("ENGINE_RANDOM_SEARCH_URL", "http://engine-random-search:8080"),
        "many-heuristic": os.getenv("ENGINE_MANY_HEURISTIC_URL", "http://engine-many-heuristic:8080"),
        "evolutionary-heuristics": os.getenv(
            "ENGINE_EVOLUTIONARY_HEURISTICS_URL",
            "http://engine-evolutionary-heuristics:8080",
        ),
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
EngineRegistry.register("random-search", RandomSearchEnginePlugin())
EngineRegistry.register("many-heuristic", ManyHeuristicEnginePlugin())
EngineRegistry.register("evolutionary-heuristics", EvolutionaryHeuristicsEnginePlugin())
