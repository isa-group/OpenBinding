"""Which engines exist, and how to reach each one.

Two kinds live here behind one lookup. The four that ship with the gateway are
registered at import and reached at a URL from the environment. The ones users
register are held in a cache refreshed from the database, because the registry
is consulted from synchronous code and the rows are not.

``get_plugin`` answers for both, which is what lets the validation pipeline, the
schema routes and the router stay ignorant of the difference.
"""

from typing import Any, Dict, List, Optional

from ..core.settings import get_settings
from ..federation.transport import BuiltinTransport, EngineTransport
from .discovery import discover
from ..validation.engine_plugins.base import EngineValidationPlugin
from ..validation.engine_plugins.evolutionary_heuristics import EvolutionaryHeuristicsEnginePlugin
from ..validation.engine_plugins.many_heuristic import ManyHeuristicEnginePlugin
from ..validation.engine_plugins.minizinc_csp import MiniZincCSPEnginePlugin
from ..validation.engine_plugins.random_search import RandomSearchEnginePlugin


class EngineRegistry:
    # Keeps track of all solver engines and where to find them.
    _plugins: Dict[str, EngineValidationPlugin] = {}
    #: Read on first use rather than at import. Reading configuration while
    #: this module is being imported forced every caller to import it after
    #: `load_dotenv()` had run, which is why the gateway's imports used to sit
    #: below a function call. Nothing depends on that ordering now.
    _engine_urls: Optional[Dict[str, str]] = None
    #: Registered engines, by qualified id. Replaced wholesale by
    #: ``refresh_federated`` rather than mutated, so a lookup never sees a
    #: half-applied refresh.
    _federated: Dict[str, Any] = {}

    @classmethod
    def register(cls, engine_id: str, plugin: EngineValidationPlugin):
        cls._plugins[engine_id] = plugin

    # -- Registered engines ------------------------------------------------

    @classmethod
    def refresh_federated(cls, entries) -> None:
        """Replace the cache with a freshly loaded snapshot."""
        cls._federated = {entry.engine_id: entry for entry in entries}

    @classmethod
    def federated_entry(cls, engine_id: str):
        return cls._federated.get(engine_id)

    @classmethod
    def is_federated(cls, engine_id: str) -> bool:
        return engine_id in cls._federated and engine_id not in cls._plugins

    # -- Lookup ------------------------------------------------------------

    @classmethod
    def get_plugin(cls, engine_id: str) -> EngineValidationPlugin:
        """The plugin for an engine, built-in or registered.

        Built-ins win a name clash, which by construction cannot happen: a
        registered engine's id always contains the owner separator and a
        built-in id never can.
        """
        if engine_id in cls._plugins:
            return cls._plugins[engine_id]
        entry = cls._federated.get(engine_id)
        if entry is not None:
            return entry.plugin
        raise ValueError(f"Engine '{engine_id}' not found")

    @classmethod
    def engine_urls(cls) -> Dict[str, str]:
        if cls._engine_urls is None:
            cls._engine_urls = get_settings().engine_urls
        return cls._engine_urls

    @classmethod
    def get_url(cls, engine_id: str) -> str:
        urls = cls.engine_urls()
        if engine_id in urls:
            return urls[engine_id]
        entry = cls._federated.get(engine_id)
        if entry is not None:
            return entry.transport.base_url()
        raise ValueError(f"Engine '{engine_id}' not configured")

    @classmethod
    def get_transport(cls, engine_id: str) -> EngineTransport:
        """How to make requests to this engine.

        The router asks for this instead of building ``{url}/solve`` itself,
        which is the whole of what federating an engine costs the router.
        """
        entry = cls._federated.get(engine_id)
        if entry is not None and engine_id not in cls._plugins:
            return entry.transport
        return BuiltinTransport(cls.get_url(engine_id))

    # -- Listing -----------------------------------------------------------

    @classmethod
    def visible_engine_ids(cls, user=None) -> List[str]:
        """Built-in engines, plus the registered ones this user may see."""
        visible = list(cls._plugins)
        visible.extend(
            engine_id
            for engine_id, entry in cls._federated.items()
            if entry.is_visible_to(user)
        )
        return visible

    @classmethod
    def list_engines(cls, user=None) -> List[Dict[str, Any]]:
        """What ``GET /v1/engines`` publishes.

        A registered engine somebody may not see is absent rather than listed
        as forbidden, for the same reason a foreign job 404s: its existence is
        its owner's business.
        """
        engines: List[Dict[str, Any]] = [
            {"id": engine_id, "capabilities": plugin.get_capabilities(), "federated": False}
            for engine_id, plugin in cls._plugins.items()
        ]

        for engine_id, entry in cls._federated.items():
            if not entry.is_visible_to(user):
                continue
            engines.append(
                {
                    "id": engine_id,
                    "capabilities": entry.plugin.get_capabilities(),
                    "federated": True,
                    "owner": entry.owner_username,
                    "visibility": entry.visibility.value,
                    "status": entry.status.value,
                    "verified_at": (
                        entry.verified_at.isoformat()
                        if hasattr(entry.verified_at, "isoformat")
                        else entry.verified_at
                    ),
                }
            )

        return engines


# Initialization. The handwritten plugins go first: each exists because its
# engine needs something a manifest cannot express - a request shape of its
# own, or a semantic check beyond a JSON Schema.
EngineRegistry.register("minizinc-csp", MiniZincCSPEnginePlugin())
EngineRegistry.register("random-search", RandomSearchEnginePlugin())
EngineRegistry.register("many-heuristic", ManyHeuristicEnginePlugin())
EngineRegistry.register("evolutionary-heuristics", EvolutionaryHeuristicsEnginePlugin())

# Then every other manifest on disk becomes an engine on its own. An engine
# that implements the contract in schemas/engine-contract.openapi.yaml needs no
# Python here at all - only its manifest and an ENGINE_<ID>_URL.
discover(EngineRegistry)
