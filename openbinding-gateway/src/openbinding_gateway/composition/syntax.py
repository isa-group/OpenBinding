"""The YAML a composition may be written in: JSON's data model, in YAML's syntax.

A composition is a JSON-shaped document. The schema that judges it is a JSON Schema, every
package it compiles into is JSON, and every response that carries one over HTTP is JSON. YAML
can say more than JSON can hold, and each of those extras is a way for a document to mean
something no reader of the schema expects, or to cost something no reader of the text would
guess. So the loader here is ``yaml.SafeLoader`` narrowed to what JSON holds:

* **An alias** re-reads a node wherever it is named, so a few hundred bytes of nested aliases
  expand into millions of nodes. Measured on the reader this replaced: a 521-byte refused
  document took 7.6 seconds, nearly all of it in the span locator, which walked the
  expansion once per use -- on routes anyone may call. A composition has nothing to share
  that a reference by id does not already say, so an alias is refused, located where it is
  used. A merge key (``<<``) goes with it: it exists to merge an alias.
* **A duplicate key** is silently last-wins in PyYAML: the first value is gone without a word.
* **A key that is not a string.** YAML 1.1 reads ``on:`` as ``True`` and ``1:`` as an
  integer, and JSON has no such keys.
* **A number that is not finite.** ``.inf`` and ``.nan`` pass the schema, which types a number
  and not its finiteness, and reach the package as ``Infinity`` -- which strict JSON readers
  refuse, the container's among them.
* **A timestamp.** A date in the free-form ``studio`` block became a ``datetime`` that no JSON
  response can carry. A plain date stays a string, as JSON would have it; ``!!timestamp`` and
  the other tags JSON has no value for (``!!binary``, ``!!set``, ``!!omap``, ``!!pairs``) are
  refused.
* **Nesting without end.** The composer and the readers recurse, so a deep enough document is
  a ``RecursionError``: measured, parse broke at 163 nested workflow steps, about 330 levels
  counted the way the bound counts them. The deepest composition in the corpus is 17 levels
  counted that way (16 counting containers only), and the bound is 64.
* **A number JSON cannot carry exactly, or that costs more to read than it is worth.** An
  integer past +-(2^53 - 1) loses digits in every JavaScript reader and is refused by the
  container's canonical form, so it is refused here, located. A number written in more than
  64 characters is refused before it is converted, because YAML 1.1's base-60 integers
  (``1:30`` is 90) convert in time quadratic in their length -- a long enough one costs hours
  -- and no number a composition holds needs more: the corpus's longest is 18 characters, and
  a double writes in at most 24.

Scalars otherwise resolve as YAML 1.1 resolves them, PyYAML's ``SafeLoader`` rules unchanged:
``yes`` is ``true``, ``010`` is 8, ``1:30`` is 90. Switching to YAML 1.2 would re-read sealed
sources differently, and the writer quotes every string those rules would misread. The one
rule dropped is YAML 1.1's ``=`` value key, which only a merge would give meaning to: a
plain ``=`` is a string.

libyaml reads three corners of YAML 1.1 differently from PyYAML's own scanner, and they are
the reading of record: a flow key with no value (``{draft:}``) and a ``%YAML 1.0`` directive
are refused, and a tab between tokens is accepted. Measured against the corpus, the suite and
the specification, nothing written uses any of them; a version sealed with one is no longer
read.

Every refusal here is a ``yaml.MarkedYAMLError`` carrying the position the reader reached, so
it becomes ``c2y_syntax`` located exactly like a missing colon -- including the errors
PyYAML's own converters raise as plain Python exceptions, which are caught at the node that
raised them. None of it moves the corpus: the writer has never produced any of these, and
the 82 packages of the gate round-trip through this loader unchanged.

**The events come from libyaml when it is installed**, and everything above is applied by the
Python composer and constructor that consume them. PyYAML's pure-Python scanner is the cost:
measured on the corpus's largest composition (333 KB), reading took 4.7 seconds through it
and 0.7 through libyaml with the same composer and constructor, giving the same document;
and on 20,000 values in a flow list it took 2.4 CPU-seconds flat and 16.3 nested sixty deep,
where libyaml took 0.3 and 1.0. libyaml's own composer
is never used -- it recurses in C, where a deep enough document crashes the process rather
than raising -- so the depth bound and the alias refusal stay in Python, in front of it.

The writer is narrowed the same way: :func:`dump` never writes an anchor, because PyYAML
writes one for any object that appears twice in a document -- two candidates handed the same
mapping of property values would come back as an alias the reader refuses. And it writes a
string holding U+0085 double-quoted, where the character is escaped: written raw, as PyYAML
otherwise does, the reader folds it into a space, and a document would not read back as the
one written. A sweep of every character below U+3000 found that one alone.
"""

from __future__ import annotations

import io
import math
from typing import Any

import yaml
from yaml.composer import Composer, ComposerError
from yaml.constructor import ConstructorError, SafeConstructor
from yaml.resolver import Resolver

from .diagnostics import SYNTAX, CompositionError, Diagnostic, Span

try:  # libyaml's event parser, when PyYAML was built with it
    from yaml._yaml import CParser
except ImportError:  # pragma: no cover - the gateway image ships it
    CParser = None

#: How deeply a document may nest, counting every mapping, sequence and scalar on the way
#: down. Nearly four times the deepest composition in the corpus (17 counted this way), and
#: far below the depth at which the readers run out of stack (about 330).
MAX_DEPTH = 64

#: The largest integer JSON carries exactly, and the container's canonical form accepts.
MAX_SAFE_INTEGER = 2**53 - 1

#: The longest a number may be written. The corpus's longest is 18 characters
#: (``0.9984999999999999``) and a double writes in at most 24; base-60 integers convert in
#: quadratic time, so the bound comes before the conversion.
MAX_NUMBER_CHARS = 64

_TIMESTAMP = "tag:yaml.org,2002:timestamp"
_MERGE = "tag:yaml.org,2002:merge"
_VALUE = "tag:yaml.org,2002:value"
#: Tags ``yaml.SafeLoader`` constructs into a value JSON cannot hold.
_NOT_JSON = ("binary", "set", "omap", "pairs", "timestamp")
#: The characters PyYAML writes raw in a quoted scalar and reads back as a line break.
_FOLDED = "\x85"


class _Narrowed:
    """What the reader refuses, whichever parser feeds it events.

    A mixin, so the same composer and constructor rules apply to libyaml's events and to
    PyYAML's own: it comes first in each loader's order, and every override defers to the
    next class with ``super()``.
    """

    _depth = 0

    def compose_node(self, parent: Any, index: Any) -> Any:
        if self.check_event(yaml.AliasEvent):
            raise ComposerError(
                None, None,
                "found an alias: Composition2Yaml has no anchors or aliases, so write the "
                "value out where it is used",
                self.peek_event().start_mark,
            )
        self._depth += 1
        try:
            if self._depth > MAX_DEPTH:
                raise ComposerError(
                    None, None,
                    f"the document nests deeper than {MAX_DEPTH} levels",
                    self.peek_event().start_mark,
                )
            return super().compose_node(parent, index)
        finally:
            self._depth -= 1

    def construct_object(self, node: Any, deep: bool = False) -> Any:
        try:
            return super().construct_object(node, deep=deep)
        except yaml.YAMLError:
            raise
        except (ValueError, IndexError, KeyError, TypeError, OverflowError, ArithmeticError) as error:
            # PyYAML's own converters raise these for a scalar they cannot read -- an empty
            # ``!!int``, a ``!!bool`` outside its table. Located at the node, like any other
            # refusal, rather than escaping as an exception with no position.
            raise ConstructorError(
                None, None,
                f"found {node.value!r}, which is not a readable {node.tag.rsplit(':', 1)[-1]}"
                if isinstance(node.value, str)
                else f"found a value that is not readable ({type(error).__name__})",
                node.start_mark,
            ) from error

    def construct_mapping(self, node: Any, deep: bool = False) -> dict[str, Any]:
        if not isinstance(node, yaml.MappingNode):
            raise ConstructorError(
                None, None, f"expected a mapping, but found {node.id}", node.start_mark,
            )
        mapping: dict[str, Any] = {}
        for key_node, value_node in node.value:
            if key_node.tag == _MERGE:
                raise ConstructorError(
                    "while reading a mapping", node.start_mark,
                    "found a merge key (<<), which Composition2Yaml does not have",
                    key_node.start_mark,
                )
            key = self.construct_object(key_node, deep=deep)
            if not isinstance(key, str):
                raise ConstructorError(
                    "while reading a mapping", node.start_mark,
                    f"found the key {key_node.value!r}, which YAML reads as a "
                    f"{type(key).__name__} and JSON cannot hold: quote it",
                    key_node.start_mark,
                )
            if key in mapping:
                raise ConstructorError(
                    "while reading a mapping", node.start_mark,
                    f"found the key {key!r} twice, and YAML would keep only the last",
                    key_node.start_mark,
                )
            mapping[key] = self.construct_object(value_node, deep=deep)
        return mapping

    def construct_yaml_int(self, node: Any) -> int:
        self._short(node)
        value = super().construct_yaml_int(node)
        if abs(value) > MAX_SAFE_INTEGER:
            raise ConstructorError(
                None, None,
                f"found {node.value!r}, an integer past +-(2^53 - 1): JSON readers lose its "
                "digits and the container refuses it",
                node.start_mark,
            )
        return value

    def construct_yaml_float(self, node: Any) -> float:
        self._short(node)
        value = super().construct_yaml_float(node)
        if not math.isfinite(value):
            raise ConstructorError(
                None, None,
                f"found {node.value!r}, which is not a finite number: JSON cannot hold it "
                "and the container refuses it",
                node.start_mark,
            )
        return value

    def _short(self, node: Any) -> None:
        if len(node.value) > MAX_NUMBER_CHARS:
            raise ConstructorError(
                None, None,
                f"found a number written in {len(node.value)} characters, past the "
                f"{MAX_NUMBER_CHARS} a composition reads: quote it if it is text",
                node.start_mark,
            )

    def refuse_tag(self, node: Any) -> Any:
        raise ConstructorError(
            None, None,
            f"found a !!{node.tag.rsplit(':', 1)[-1]} value, which JSON cannot hold",
            node.start_mark,
        )


# A plain date stays the string it was written as, and so does a plain ``=``. The resolvers
# are copied rather than edited, because ``yaml.SafeLoader``'s table is shared with every
# other user of PyYAML.
_Narrowed.yaml_implicit_resolvers = {
    first: [(tag, pattern) for tag, pattern in resolvers if tag not in (_TIMESTAMP, _VALUE)]
    for first, resolvers in Resolver.yaml_implicit_resolvers.items()
}
_Narrowed.yaml_constructors = dict(SafeConstructor.yaml_constructors)
_Narrowed.yaml_constructors["tag:yaml.org,2002:int"] = _Narrowed.construct_yaml_int
_Narrowed.yaml_constructors["tag:yaml.org,2002:float"] = _Narrowed.construct_yaml_float
for _tag in _NOT_JSON:
    _Narrowed.yaml_constructors[f"tag:yaml.org,2002:{_tag}"] = _Narrowed.refuse_tag


class PureLoader(_Narrowed, yaml.SafeLoader):
    """The narrowed loader on PyYAML's pure-Python scanner and parser."""

    #: A reader error's position counts characters of the text.
    positions_in_bytes = False


if CParser is not None:

    class FastLoader(_Narrowed, Composer, SafeConstructor, Resolver, CParser):
        """The narrowed loader on libyaml's events, composed and constructed in Python."""

        #: libyaml reads the text as UTF-8, so a reader error's position counts bytes.
        positions_in_bytes = True

        def __init__(self, stream: Any) -> None:
            CParser.__init__(self, stream)
            Composer.__init__(self)
            SafeConstructor.__init__(self)
            Resolver.__init__(self)

    Loader: type = FastLoader
else:  # pragma: no cover - the gateway image ships libyaml
    Loader = PureLoader


class Dumper(yaml.SafeDumper):
    """``yaml.SafeDumper`` that writes every value out and every string so it reads back."""

    def ignore_aliases(self, data: Any) -> bool:
        return True

    def represent_str(self, data: str) -> Any:
        if any(character in data for character in _FOLDED):
            return self.represent_scalar("tag:yaml.org,2002:str", data, style='"')
        return super().represent_str(data)


Dumper.add_representer(str, Dumper.represent_str)


class Lines:
    """The text's lines, to keep a position inside them.

    libyaml reports the end of a text that does not end in a newline as the start of the
    line after it -- a line the editor's buffer does not have. A position past the last line
    is the end of the last line, which is where PyYAML's own reader puts it.
    """

    def __init__(self, text: str) -> None:
        self._lengths = [len(line) for line in text.split("\n")]

    def point(self, line: int, column: int) -> tuple[int, int]:
        """A zero-based mark as a one-based line and column, inside the text."""
        if line >= len(self._lengths):
            line, column = len(self._lengths) - 1, self._lengths[-1]
        return line + 1, column + 1

    def span(self, start: Any, end: Any) -> Span:
        line, column = self.point(start.line, start.column)
        end_line, end_column = self.point(end.line, end.column)
        return Span(line=line, column=column, end_line=end_line, end_column=end_column)


def syntax_diagnostic(error: yaml.MarkedYAMLError, text: str | None = None) -> Diagnostic:
    """A YAML error as a ``c2y_syntax`` diagnostic at the position the reader reached."""
    mark = error.problem_mark or error.context_mark
    span = None
    if mark is not None:
        line, column = (
            Lines(text).point(mark.line, mark.column) if text is not None
            else (mark.line + 1, mark.column + 1)
        )
        span = Span(line=line, column=column, end_line=line, end_column=column + 1)
    return Diagnostic(code=SYNTAX, message=str(error.problem or error), path="", span=span)


def load(text: str) -> Any:
    """``text`` read with :data:`Loader`; a refusal is a located ``c2y_syntax`` diagnostic."""
    try:
        return yaml.load(text, Loader=Loader)  # noqa: S506 - a SafeLoader, narrowed further
    except yaml.MarkedYAMLError as error:
        raise CompositionError((syntax_diagnostic(error, text),)) from error
    except UnicodeEncodeError as error:
        # libyaml reads UTF-8, and a lone surrogate has no UTF-8 form: the text is refused
        # where that character is, as PyYAML's own reader refuses it.
        raise CompositionError((Diagnostic(
            code=SYNTAX, message="found a character that is not valid Unicode text", path="",
            span=_at(text, error.start, in_bytes=False),
        ),)) from error
    except yaml.reader.ReaderError as error:
        # A character YAML does not allow -- a control character, say. It carries an offset
        # rather than a mark, so the position is counted here.
        character = error.character
        what = f"#x{character:04x}" if isinstance(character, int) else repr(character)
        raise CompositionError((Diagnostic(
            code=SYNTAX, message=f"found the character {what}: {error.reason}", path="",
            span=_at(text, error.position, in_bytes=Loader.positions_in_bytes),
        ),)) from error
    except yaml.YAMLError as error:
        raise CompositionError(
            (Diagnostic(code=SYNTAX, message=str(error), path=""),),
        ) from error
    except RecursionError as error:  # pragma: no cover - the depth bound refuses first
        raise CompositionError((Diagnostic(
            code=SYNTAX, message=f"the document nests deeper than {MAX_DEPTH} levels", path="",
        ),)) from error


def _at(text: str, position: int, *, in_bytes: bool) -> Span:
    """The one-based line and column of an offset into the text, in characters or bytes."""
    if in_bytes:
        position = len(text.encode("utf-8")[:position].decode("utf-8", errors="ignore"))
    line = text.count("\n", 0, position) + 1
    column = position - (text.rfind("\n", 0, position) + 1) + 1
    return Span(line=line, column=column, end_line=line, end_column=column + 1)


def compose(text: str) -> Any:
    """``text`` as a node tree, by the same rules, for the span locator.

    A refusal propagates as a ``yaml.YAMLError``; a text libyaml cannot even encode does too,
    so the locator has one exception to catch.
    """
    try:
        return yaml.compose(text, Loader=Loader)  # noqa: S506 - composes nodes, constructs nothing
    except UnicodeEncodeError as error:
        raise yaml.YAMLError(str(error)) from error


class TooLong(Exception):
    """The text being written passed the length it was allowed."""

    def __init__(self, limit: int) -> None:
        super().__init__(f"the text is longer than {limit} characters")
        self.limit = limit


class _Bounded(io.StringIO):
    """A text buffer that refuses to grow past a length, so the writer stops when it does."""

    def __init__(self, limit: int) -> None:
        super().__init__()
        self._room = limit

    def write(self, text: str) -> int:
        self._room -= len(text)
        if self._room < 0:
            raise TooLong(self.tell() + len(text) + self._room)
        return super().write(text)


def dump(document: Any, limit: int | None = None) -> str:
    """A document as YAML text, block style, in the document's own key order.

    With ``limit``, the writing stops -- raising :class:`TooLong` -- as soon as the text
    passes it. Block YAML indents every line by its depth and folds long strings into lines
    indented the same way, so a document can write many times its own size: bounding the
    writing itself, rather than estimating it first, is the bound that holds.
    """
    if limit is None:
        return yaml.dump(
            document, Dumper=Dumper, sort_keys=False, allow_unicode=True, default_flow_style=False,
        )
    stream = _Bounded(limit)
    yaml.dump(
        document, stream, Dumper=Dumper, sort_keys=False, allow_unicode=True,
        default_flow_style=False,
    )
    return stream.getvalue()
