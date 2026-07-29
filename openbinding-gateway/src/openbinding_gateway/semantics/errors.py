"""Errors the semantics raise."""

from __future__ import annotations


class PlacementError(ValueError):
    """Raised when the placement extensions of an instance cannot be interpreted."""


class DesugarError(ValueError):
    """Raised when an authoring shorthand has no single expansion."""
