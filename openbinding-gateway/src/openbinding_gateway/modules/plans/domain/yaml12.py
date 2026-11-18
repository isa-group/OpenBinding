"""The one YAML loader of the pricing code: the YAML 1.2 core schema of js-yaml, with hard limits.

SPHERE parses Pricing2Yaml with js-yaml, whose default schema is YAML 1.2 core (plus timestamps and merge
keys): booleans are only ``true``/``True``/``TRUE``/``false``/``False``/``FALSE`` (no ``yes``/``on``), and
there are no sexagesimal numbers (``1:30`` is a string). PyYAML's ``SafeLoader`` is YAML 1.1, so this module
replaces its resolvers. The functional hash (``content_hash``) and the normaliser read through it, so both
see the document as SPHERE does.

Offering URLs are user input, so the loader refuses hostile documents before they are expanded:
at most ``MAX_BYTES`` of text, ``MAX_ALIASES`` alias uses, depth ``MAX_DEPTH`` and ``MAX_NODES`` nodes counted
on the *expanded* tree (every alias use adds the size of what it points at), so a doubling alias chain is
refused before anything serialises or walks it. Exceeding one is ``PricingInvalid("yaml_limits")``.
"""

from __future__ import annotations

import re
from typing import Any

import yaml
from yaml.nodes import MappingNode, Node, ScalarNode, SequenceNode

from .errors import PricingInvalid

MAX_BYTES = 5 * 1024 * 1024
MAX_ALIASES = 50
MAX_DEPTH = 64
MAX_NODES = 200_000

_BOOL = "tag:yaml.org,2002:bool"
_INT = "tag:yaml.org,2002:int"
_FLOAT = "tag:yaml.org,2002:float"


class _Core12Loader(yaml.SafeLoader):
    """``SafeLoader`` with the YAML 1.2 core resolvers for booleans and numbers, counting alias uses."""

    def __init__(self, stream: str) -> None:
        super().__init__(stream)
        self.alias_uses = 0

    def compose_node(self, parent: Node | None, index: Any) -> Node | None:  # type: ignore[override]
        if self.check_event(yaml.AliasEvent):
            self.alias_uses += 1
            if self.alias_uses > MAX_ALIASES:
                raise PricingInvalid("yaml_limits", f"the document uses more than {MAX_ALIASES} aliases")
        return super().compose_node(parent, index)


_Core12Loader.yaml_implicit_resolvers = {
    key: [r for r in resolvers if r[0] not in (_BOOL, _INT, _FLOAT)]
    for key, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
_Core12Loader.add_implicit_resolver(_BOOL, re.compile(r"^(?:true|True|TRUE|false|False|FALSE)$"), list("tTfF"))
_Core12Loader.add_implicit_resolver(
    _INT,
    re.compile(r"^(?:[-+]?0b[0-1_]+|[-+]?0[0-7_]+|[-+]?(?:0|[1-9][0-9_]*)|[-+]?0x[0-9a-fA-F_]+)$"),
    list("-+0123456789"),
)
_Core12Loader.add_implicit_resolver(
    _FLOAT,
    re.compile(
        r"^(?:[-+]?(?:[0-9][0-9_]*)(?:\.[0-9_]*)?(?:[eE][-+]?[0-9]+)?"
        r"|\.[0-9_]+(?:[eE][-+]?[0-9]+)?|[-+]?\.(?:inf|Inf|INF)|\.(?:nan|NaN|NAN))$"
    ),
    list("-+0123456789."),
)


def _measure(root: Node) -> None:
    """Refuse a tree whose expanded size or depth passes the limits (aliases counted at every use)."""
    sizes: dict[int, tuple[int, int]] = {}
    active: set[int] = set()

    def visit(node: Node) -> tuple[int, int]:
        key = id(node)
        known = sizes.get(key)
        if known is not None:
            return known
        if key in active:
            raise PricingInvalid("yaml_limits", "the document refers to itself")
        active.add(key)
        size, depth = 1, 1
        children: list[Node] = []
        if isinstance(node, SequenceNode):
            children = list(node.value)
        elif isinstance(node, MappingNode):
            for k, v in node.value:
                children.extend((k, v))
        for child in children:
            child_size, child_depth = visit(child)
            size += child_size
            depth = max(depth, child_depth + 1)
            if size > MAX_NODES:
                raise PricingInvalid("yaml_limits", f"the document expands to more than {MAX_NODES} nodes")
            if depth > MAX_DEPTH:
                raise PricingInvalid("yaml_limits", f"the document is nested deeper than {MAX_DEPTH} levels")
        active.discard(key)
        sizes[key] = (size, depth)
        return size, depth

    if not isinstance(root, ScalarNode):
        visit(root)


def load(text: str | bytes) -> Any:
    """Parse one YAML document with js-yaml's YAML 1.2 core reading, within the limits; ``None`` if empty."""
    if isinstance(text, bytes):
        if len(text) > MAX_BYTES:
            raise PricingInvalid("yaml_limits", f"the document is larger than {MAX_BYTES} bytes")
        try:
            text = text.decode("utf-8")
        except UnicodeDecodeError as exc:
            raise PricingInvalid("yaml_invalid", "the document is not UTF-8 text") from exc
    if len(text.encode("utf-8")) > MAX_BYTES:
        raise PricingInvalid("yaml_limits", f"the document is larger than {MAX_BYTES} bytes")
    loader = _Core12Loader(text)
    try:
        try:
            node = loader.get_single_node()
        except RecursionError as exc:
            raise PricingInvalid("yaml_limits", f"the document is nested deeper than {MAX_DEPTH} levels") from exc
        if node is None:
            return None
        _measure(node)
        return loader.construct_document(node)
    except yaml.YAMLError as exc:
        raise PricingInvalid("yaml_invalid", f"the document is not valid YAML: {_first_line(exc)}") from exc
    finally:
        loader.dispose()


def _first_line(error: Exception) -> str:
    return str(error).strip().splitlines()[0][:200] if str(error).strip() else type(error).__name__
