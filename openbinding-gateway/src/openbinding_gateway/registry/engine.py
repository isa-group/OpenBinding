from typing import Dict, List, Any, Optional
from ..core.settings import get_settings
from ..validation.engine_plugins.base import EngineValidationPlugin
from ..validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from ..validation.engine_plugins.random_search import RandomSearchEnginePlugin
from ..validation.engine_plugins.many_heuristic import ManyHeuristicEnginePlugin
from ..validation.engine_plugins.evolutionary_heuristics import EvolutionaryHeuristicsEnginePlugin

class EngineRegistry:
    # Keeps track of all solver engines and where to find them.
    _plugins: Dict[str, EngineValidationPlugin] = {}
    #: Read on first use rather than at import. Reading configuration while
    #: this module is being imported forced every caller to import it after
    #: `load_dotenv()` had run, which is why the gateway's imports used to sit
    #: below a function call. Nothing depends on that ordering now.
    _engine_urls: Optional[Dict[str, str]] = None

    @classmethod
    def register(cls, engine_id: str, plugin: EngineValidationPlugin):
        cls._plugins[engine_id] = plugin

    @classmethod
    def get_plugin(cls, engine_id: str) -> EngineValidationPlugin:
        if engine_id not in cls._plugins:
            raise ValueError(f"Engine '{engine_id}' not found")
        return cls._plugins[engine_id]

    @classmethod
    def engine_urls(cls) -> Dict[str, str]:
        if cls._engine_urls is None:
            cls._engine_urls = get_settings().engine_urls
        return cls._engine_urls

    @classmethod
    def get_url(cls, engine_id: str) -> str:
        urls = cls.engine_urls()
        if engine_id not in urls:
            raise ValueError(f"Engine '{engine_id}' not configured")
        return urls[engine_id]
        
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
