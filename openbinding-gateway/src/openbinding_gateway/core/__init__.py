"""Cross-cutting concerns: configuration, and what else the whole gateway shares."""

from .settings import Settings, get_settings

__all__ = ["Settings", "get_settings"]
