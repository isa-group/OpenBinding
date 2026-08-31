"""Safe, bounded CEL/JSON-expression lowering for BIM v1.

The implementation deliberately supports a small CEL-compatible expression
language instead of Python semantics.  CEL and JSON authoring forms lower to
the same location-free Expression IR; source spans are carried next to the IR
so they never change its canonical digest.
"""

from __future__ import annotations

import ast
import math
import operator
import re
from dataclasses import dataclass
from typing import Any, Mapping


class ExpressionError(ValueError):
    """An expression is malformed, unsafe, untyped, or outside the profile."""

    def __init__(self, message: str, *, span: dict[str, int] | None = None):
        super().__init__(message)
        self.span = dict(span) if span is not None else None

    def locate(self, span: dict[str, int] | None) -> None:
        """Attach the most specific source range without replacing one below it."""
        if self.span is None and span is not None:
            self.span = dict(span)


MAX_EXPRESSION_LENGTH = 4096
MAX_EXPRESSION_NODES = 256
MAX_EXPRESSION_DEPTH = 32
MAX_CALL_ARGUMENTS = 16

_DEFAULT_ROOT_TYPES: dict[str, str] = {
    "binding": "object",
    "candidate": "object",
    "capabilities": "object",
    "extensions": "object",
    "metrics": "object",
    "properties": "object",
    "values": "list<number>",
    "weights": "list<number>",
    "count": "number",
}

_OPERATORS = {
    "eq": operator.eq,
    "ne": operator.ne,
    "lt": operator.lt,
    "lte": operator.le,
    "gt": operator.gt,
    "gte": operator.ge,
    "add": operator.add,
    "sub": operator.sub,
    "mul": operator.mul,
    "div": operator.truediv,
    "pow": operator.pow,
}


@dataclass(frozen=True)
class Expression:
    ast: dict[str, Any]
    result_type: str
    span: dict[str, int] | None = None

    def evaluate(self, context: Mapping[str, Any]) -> Any:
        return _evaluate(self.ast, context)


def _path_value(context: Mapping[str, Any], segments: list[str] | tuple[str, ...]) -> Any:
    value: Any = context
    for segment in segments:
        if not isinstance(value, Mapping) or segment not in value:
            raise ExpressionError(f"unknown expression path: {list(segments)!r}")
        value = value[segment]
    return value


def _numeric(value: Any, label: str) -> float | int:
    if not isinstance(value, (int, float)) or isinstance(value, bool):
        raise ExpressionError(f"{label} must be numeric")
    if isinstance(value, float) and not math.isfinite(value):
        raise ExpressionError(f"{label} must be finite")
    return value


def _compare(op: str, left: Any, right: Any) -> bool:
    left_numeric = isinstance(left, (int, float)) and not isinstance(left, bool)
    right_numeric = isinstance(right, (int, float)) and not isinstance(right, bool)
    same_type = type(left) is type(right)
    if op in {"eq", "ne"}:
        compatible = (left_numeric and right_numeric) or same_type
        if not compatible:
            raise ExpressionError(
                f"{op} operands have incompatible runtime types: {type(left).__name__}, {type(right).__name__}"
            )
    elif not ((left_numeric and right_numeric) or (isinstance(left, str) and isinstance(right, str))):
        raise ExpressionError(
            f"{op} requires two numbers or two strings, got {type(left).__name__}, {type(right).__name__}"
        )
    try:
        return bool(_OPERATORS[op](left, right))
    except (KeyError, TypeError, OverflowError) as exc:
        raise ExpressionError(f"invalid comparison {op}") from exc


def _flatten_numeric_args(args: list[Any], name: str) -> list[float | int]:
    if len(args) == 1 and isinstance(args[0], (list, tuple)):
        args = list(args[0])
    return [_numeric(value, f"{name} argument") for value in args]


def _evaluate(node: dict[str, Any], context: Mapping[str, Any]) -> Any:
    kind = node.get("kind")
    if kind == "literal":
        return node.get("value")
    if kind == "path":
        return _path_value(context, node["segments"])
    if kind == "not":
        value = _evaluate(node["value"], context)
        if not isinstance(value, bool):
            raise ExpressionError("not operand must be boolean")
        return not value
    if kind == "negate":
        return -_numeric(_evaluate(node["value"], context), "negate operand")
    if kind in {"and", "or"}:
        left = _evaluate(node["left"], context)
        if not isinstance(left, bool):
            raise ExpressionError(f"{kind} operand must be boolean")
        if kind == "and" and not left:
            return False
        if kind == "or" and left:
            return True
        right = _evaluate(node["right"], context)
        if not isinstance(right, bool):
            raise ExpressionError(f"{kind} operand must be boolean")
        return right
    if kind == "compare":
        left = _evaluate(node["left"], context)
        right = _evaluate(node["right"], context)
        return _compare(str(node.get("op")), left, right)
    if kind == "arithmetic":
        left = _numeric(_evaluate(node["left"], context), "left arithmetic operand")
        right = _numeric(_evaluate(node["right"], context), "right arithmetic operand")
        try:
            result = _OPERATORS[node["op"]](left, right)
        except (KeyError, TypeError, ZeroDivisionError, OverflowError) as exc:
            raise ExpressionError(f"invalid arithmetic {node.get('op')}") from exc
        return _numeric(result, "arithmetic result")
    if kind == "call":
        name = node.get("name")
        if name == "has":
            argument = node.get("args", [{}])[0]
            if argument.get("kind") != "path":
                raise ExpressionError("has requires a path")
            try:
                _path_value(context, argument["segments"])
                return True
            except ExpressionError:
                return False
        args = [_evaluate(arg, context) for arg in node.get("args", [])]
        if name in {"weightedSum", "weightedProduct"}:
            if len(args) != 2 or not isinstance(args[0], (list, tuple)) or not isinstance(args[1], (list, tuple)):
                raise ExpressionError(f"{name} requires values and weights lists")
            values = _flatten_numeric_args([args[0]], name)
            weights = _flatten_numeric_args([args[1]], name)
            if len(values) != len(weights):
                raise ExpressionError(f"{name} values and weights must have equal length")
            if name == "weightedSum":
                return _numeric(sum(value * weight for value, weight in zip(values, weights, strict=True)), "weightedSum result")
            result: float | int = 1
            for value, weight in zip(values, weights, strict=True):
                if weight == 0:
                    continue
                if value < 0 and not float(weight).is_integer():
                    raise ExpressionError("weightedProduct cannot use a negative value with a fractional weight")
                result *= value ** weight
            return _numeric(result, "weightedProduct result")
        values = _flatten_numeric_args(args, str(name))
        if not values:
            raise ExpressionError(f"{name} requires at least one argument")
        if name == "min":
            return min(values)
        if name == "max":
            return max(values)
        if name == "sum":
            return _numeric(sum(values), "sum result")
        if name == "product":
            result: float | int = 1
            for value in values:
                result *= value
            return _numeric(result, "product result")
        raise ExpressionError(f"function is not approved: {name}")
    raise ExpressionError(f"unknown expression node: {kind}")


def _literal_type(value: Any) -> str:
    if isinstance(value, bool):
        return "bool"
    if isinstance(value, (int, float)) and not isinstance(value, bool):
        if isinstance(value, float) and not math.isfinite(value):
            raise ExpressionError("expression literals must be finite")
        return "number"
    if isinstance(value, str):
        return "string"
    if value is None:
        return "null"
    raise ExpressionError("expression literal must be a JSON scalar")


def _compatible(actual: str, expected: str) -> bool:
    return actual == expected or actual == "unknown" or expected == "unknown"


def _require_type(
    actual: str,
    expected: str,
    label: str,
    *,
    span: dict[str, int] | None = None,
) -> None:
    if not _compatible(actual, expected):
        raise ExpressionError(f"{label} must be {expected}, got {actual}", span=span)


def _validate_compare_types(
    op: str,
    left: str,
    right: str,
    *,
    mismatch_span: dict[str, int] | None = None,
) -> None:
    if "unknown" in {left, right}:
        return
    if op in {"eq", "ne"}:
        if left != right:
            raise ExpressionError(
                f"comparison operands have incompatible types: {left}, {right}",
                span=mismatch_span,
            )
        return
    if left != right or left not in {"number", "string"}:
        raise ExpressionError(
            f"ordered comparison requires two numbers or two strings, got {left}, {right}",
            span=mismatch_span,
        )


def _path_segments(value: Any) -> tuple[str, ...]:
    if isinstance(value, str):
        if not re.fullmatch(r"[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*", value):
            raise ExpressionError("string paths only allow unambiguous identifier segments")
        return tuple(value.split("."))
    if (
        isinstance(value, list)
        and value
        and all(isinstance(segment, str) and segment and "\x00" not in segment for segment in value)
    ):
        return tuple(value)
    raise ExpressionError("path must be a dotted identifier or a non-empty string-segment array")


def _normalized_path_types(path_types: Mapping[Any, str]) -> dict[tuple[str, ...], str]:
    result: dict[tuple[str, ...], str] = {}
    for path, value in path_types.items():
        if isinstance(path, tuple) and all(isinstance(segment, str) for segment in path):
            result[path] = value
        elif isinstance(path, str):
            result[tuple(path.split("."))] = value
    return result


def _path_type(segments: tuple[str, ...], root_types: Mapping[str, str], path_types: Mapping[Any, str]) -> str:
    root = segments[0]
    if root not in root_types:
        raise ExpressionError(f"expression root is not allowed: {root}")
    declared = _normalized_path_types(path_types)
    if segments in declared:
        return declared[segments]
    for index in range(len(segments), 0, -1):
        wildcard = (*segments[:index], "*")
        if wildcard in declared:
            return declared[wildcard]
    if len(segments) == 1:
        return "object" if root_types[root] == "closed-object" else root_types[root]
    if root_types[root] == "closed-object":
        raise ExpressionError(f"expression path is not declared: {list(segments)!r}")
    if root_types[root] == "object":
        # Object roots are whitelisted, but callers should supply exact or
        # wildcard path types whenever the expression result must be typed.
        return "unknown"
    raise ExpressionError(f"path cannot dereference {root}: {list(segments)!r}")


def _python_path_segments(node: ast.AST) -> tuple[str, ...] | None:
    if isinstance(node, ast.Name):
        return (node.id,)
    if isinstance(node, ast.Attribute):
        parent = _python_path_segments(node.value)
        return (*parent, node.attr) if parent is not None else None
    if isinstance(node, ast.Subscript):
        parent = _python_path_segments(node.value)
        segment = node.slice.value if isinstance(node.slice, ast.Constant) else None
        if parent is None or not isinstance(segment, str) or not segment or "\x00" in segment:
            return None
        return (*parent, segment)
    return None


@dataclass(frozen=True)
class _CelTranslation:
    """Python-compatible text plus a character-accurate map back to CEL."""

    text: str
    source_ranges: tuple[tuple[int, int], ...]

    def _line_start(self, line_number: int) -> int:
        if line_number <= 1:
            return 0
        start = 0
        for _ in range(1, line_number):
            newline = self.text.find("\n", start)
            if newline < 0:
                return len(self.text)
            start = newline + 1
        return start

    def _ast_index(self, line_number: int | None, byte_column: int | None) -> int:
        start = self._line_start(line_number or 1)
        end = self.text.find("\n", start)
        if end < 0:
            end = len(self.text)
        line = self.text[start:end]
        encoded = line.encode("utf-8")
        boundary = max(0, min(byte_column or 0, len(encoded)))
        while boundary:
            try:
                prefix = encoded[:boundary].decode("utf-8")
                break
            except UnicodeDecodeError:
                boundary -= 1
        else:
            prefix = ""
        return start + len(prefix)

    def _syntax_index(self, line_number: int | None, column: int | None) -> int:
        start = self._line_start(line_number or 1)
        end = self.text.find("\n", start)
        if end < 0:
            end = len(self.text)
        return max(start, min(start + max(0, (column or 1) - 1), end))

    def source_span(self, start: int, end: int) -> dict[str, int]:
        start = max(0, min(start, len(self.source_ranges)))
        end = max(start, min(end, len(self.source_ranges)))
        selected = self.source_ranges[start:end]
        if not selected:
            # Syntax errors at EOF have no character of their own.  Point at
            # the closest authored token instead of returning an empty range.
            cursor = min(start, len(self.source_ranges)) - 1
            if cursor < 0 and start < len(self.source_ranges):
                cursor = start
            selected = self.source_ranges[cursor : cursor + 1] if cursor >= 0 else ((0, 0),)
        return {
            "start": min(item[0] for item in selected),
            "end": max(item[1] for item in selected),
        }

    def node_span(self, node: ast.AST) -> dict[str, int] | None:
        if not hasattr(node, "lineno"):
            return None
        start = self._ast_index(getattr(node, "lineno", 1), getattr(node, "col_offset", 0))
        end = self._ast_index(
            getattr(node, "end_lineno", getattr(node, "lineno", 1)),
            getattr(node, "end_col_offset", getattr(node, "col_offset", 0)),
        )
        return self.source_span(start, end)

    def syntax_span(self, error: SyntaxError) -> dict[str, int]:
        start = (
            len(self.text)
            if error.offset is None or error.offset <= 0
            else self._syntax_index(error.lineno, error.offset)
        )
        if error.end_lineno is not None and error.end_offset is not None:
            end = self._syntax_index(error.end_lineno, error.end_offset)
        else:
            end = start + 1
        if end <= start:
            end = start + 1
        return self.source_span(start, end)


class _Builder:
    def __init__(
        self,
        root_types: Mapping[str, str],
        path_types: Mapping[Any, str],
        translation: _CelTranslation | None = None,
    ):
        self.root_types = root_types
        self.path_types = path_types
        self.translation = translation
        self.nodes = 0

    def span(self, node: ast.AST) -> dict[str, int] | None:
        return self.translation.node_span(node) if self.translation is not None else None

    def bump(self, depth: int) -> None:
        if depth > MAX_EXPRESSION_DEPTH:
            raise ExpressionError("expression exceeds the maximum nesting depth")
        self.nodes += 1
        if self.nodes > MAX_EXPRESSION_NODES:
            raise ExpressionError("expression contains too many nodes")

    def path(self, path: Any, depth: int) -> tuple[dict[str, Any], str]:
        self.bump(depth)
        segments = _path_segments(path)
        return {"kind": "path", "segments": list(segments)}, _path_type(segments, self.root_types, self.path_types)

    def json(self, value: Any, depth: int = 0) -> tuple[dict[str, Any], str]:
        self.bump(depth)
        if isinstance(value, (bool, int, float, str)) or value is None:
            return {"kind": "literal", "value": value}, _literal_type(value)
        if not isinstance(value, dict):
            raise ExpressionError("expression AST node must be an object or scalar")
        if "path" in value:
            if set(value) != {"path"}:
                raise ExpressionError("path node contains unknown fields")
            # The current node was already counted.
            segments = _path_segments(value["path"])
            return {"kind": "path", "segments": list(segments)}, _path_type(segments, self.root_types, self.path_types)
        if "literal" in value:
            if set(value) != {"literal"}:
                raise ExpressionError("literal node contains unknown fields")
            literal = value["literal"]
            return {"kind": "literal", "value": literal}, _literal_type(literal)
        op = value.get("op")
        if not isinstance(op, str):
            raise ExpressionError("expression object requires op, path, or literal")
        if op in {"and", "or", "eq", "ne", "lt", "lte", "gt", "gte", "add", "sub", "mul", "div", "pow", "scale", "power"}:
            if set(value) != {"op", "left", "right"}:
                raise ExpressionError(f"{op} requires exactly left and right")
            left, left_type = self.json(value["left"], depth + 1)
            right, right_type = self.json(value["right"], depth + 1)
            if op in {"and", "or"}:
                _require_type(left_type, "bool", f"{op} left operand")
                _require_type(right_type, "bool", f"{op} right operand")
                return {"kind": op, "left": left, "right": right}, "bool"
            if op in {"eq", "ne", "lt", "lte", "gt", "gte"}:
                _validate_compare_types(op, left_type, right_type)
                return {"kind": "compare", "op": op, "left": left, "right": right}, "bool"
            normalized = {"scale": "mul", "power": "pow"}.get(op, op)
            _require_type(left_type, "number", f"{op} left operand")
            _require_type(right_type, "number", f"{op} right operand")
            return {"kind": "arithmetic", "op": normalized, "left": left, "right": right}, "number"
        if op in {"not", "negate"}:
            if set(value) != {"op", "value"}:
                raise ExpressionError(f"{op} requires exactly value")
            child, child_type = self.json(value["value"], depth + 1)
            expected = "bool" if op == "not" else "number"
            _require_type(child_type, expected, f"{op} operand")
            return {"kind": op, "value": child}, expected
        if op in {"has", "min", "max", "sum", "product", "weightedSum", "weightedProduct"}:
            if set(value) != {"op", "args"}:
                raise ExpressionError(f"{op} requires exactly args")
            args = value["args"]
            if not isinstance(args, list) or not args or len(args) > MAX_CALL_ARGUMENTS:
                raise ExpressionError(f"{op} needs one to {MAX_CALL_ARGUMENTS} arguments")
            compiled = [self.json(arg, depth + 1) for arg in args]
            if op == "has":
                if len(compiled) != 1 or compiled[0][0].get("kind") != "path":
                    raise ExpressionError("has requires exactly one path")
                result_type = "bool"
            elif op in {"weightedSum", "weightedProduct"}:
                if len(compiled) != 2:
                    raise ExpressionError(f"{op} requires values and weights")
                _require_type(compiled[0][1], "list<number>", f"{op} values")
                _require_type(compiled[1][1], "list<number>", f"{op} weights")
                result_type = "number"
            else:
                for _node, arg_type in compiled:
                    if arg_type not in {"number", "list<number>", "unknown"}:
                        raise ExpressionError(f"{op} arguments must be numeric")
                result_type = "number"
            return {"kind": "call", "name": op, "args": [node for node, _type in compiled]}, result_type
        raise ExpressionError(f"expression operator is not approved: {op!r}")

    def python(self, node: ast.AST, depth: int = 0) -> tuple[dict[str, Any], str]:
        try:
            return self._python(node, depth)
        except ExpressionError as exc:
            exc.locate(self.span(node))
            raise

    def _python(self, node: ast.AST, depth: int) -> tuple[dict[str, Any], str]:
        self.bump(depth)
        if isinstance(node, ast.Constant):
            return {"kind": "literal", "value": node.value}, _literal_type(node.value)
        if isinstance(node, (ast.Name, ast.Attribute, ast.Subscript)):
            segments = _python_path_segments(node)
            if segments is None:
                raise ExpressionError("attribute/subscript access must be a typed path with constant string segments")
            return {"kind": "path", "segments": list(segments)}, _path_type(segments, self.root_types, self.path_types)
        if isinstance(node, ast.BoolOp) and isinstance(node.op, (ast.And, ast.Or)) and len(node.values) >= 2:
            kind = "and" if isinstance(node.op, ast.And) else "or"
            left, left_type = self.python(node.values[0], depth + 1)
            _require_type(left_type, "bool", f"{kind} operand", span=self.span(node.values[0]))
            for value in node.values[1:]:
                right, right_type = self.python(value, depth + 1)
                _require_type(right_type, "bool", f"{kind} operand", span=self.span(value))
                left = {"kind": kind, "left": left, "right": right}
            return left, "bool"
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.Not, ast.USub)):
            child, child_type = self.python(node.operand, depth + 1)
            kind, expected = ("not", "bool") if isinstance(node.op, ast.Not) else ("negate", "number")
            _require_type(child_type, expected, f"{kind} operand", span=self.span(node.operand))
            return {"kind": kind, "value": child}, expected
        if isinstance(node, ast.Compare) and len(node.ops) == 1 and len(node.comparators) == 1:
            op = {ast.Eq: "eq", ast.NotEq: "ne", ast.Lt: "lt", ast.LtE: "lte", ast.Gt: "gt", ast.GtE: "gte"}.get(type(node.ops[0]))
            if op is None:
                raise ExpressionError("comparison operator is not approved")
            left, left_type = self.python(node.left, depth + 1)
            right, right_type = self.python(node.comparators[0], depth + 1)
            _validate_compare_types(
                op,
                left_type,
                right_type,
                mismatch_span=self.span(node.comparators[0]),
            )
            return {"kind": "compare", "op": op, "left": left, "right": right}, "bool"
        if isinstance(node, ast.BinOp) and isinstance(node.op, (ast.Add, ast.Sub, ast.Mult, ast.Div, ast.Pow)):
            op = {ast.Add: "add", ast.Sub: "sub", ast.Mult: "mul", ast.Div: "div", ast.Pow: "pow"}[type(node.op)]
            left, left_type = self.python(node.left, depth + 1)
            right, right_type = self.python(node.right, depth + 1)
            _require_type(left_type, "number", f"{op} left operand", span=self.span(node.left))
            _require_type(right_type, "number", f"{op} right operand", span=self.span(node.right))
            return {"kind": "arithmetic", "op": op, "left": left, "right": right}, "number"
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and node.func.id in {"has", "min", "max", "sum", "product", "weightedSum", "weightedProduct"} and not node.keywords:
            compiled = [self.python(arg, depth + 1) for arg in node.args]
            name = node.func.id
            if not compiled or len(compiled) > MAX_CALL_ARGUMENTS:
                raise ExpressionError(f"{name} needs one to {MAX_CALL_ARGUMENTS} arguments")
            if name == "has":
                if len(compiled) != 1 or compiled[0][0].get("kind") != "path":
                    raise ExpressionError("has requires exactly one path")
                result_type = "bool"
            elif name in {"weightedSum", "weightedProduct"}:
                if len(compiled) != 2:
                    raise ExpressionError(f"{name} requires values and weights")
                _require_type(compiled[0][1], "list<number>", f"{name} values", span=self.span(node.args[0]))
                _require_type(compiled[1][1], "list<number>", f"{name} weights", span=self.span(node.args[1]))
                result_type = "number"
            else:
                for index, (_child, child_type) in enumerate(compiled):
                    if child_type not in {"number", "list<number>", "unknown"}:
                        raise ExpressionError(
                            f"{name} arguments must be numeric",
                            span=self.span(node.args[index]),
                        )
                result_type = "number"
            return {"kind": "call", "name": name, "args": [child for child, _type in compiled]}, result_type
        raise ExpressionError("CEL expression contains an unsupported construct")


def _cel_to_python(source: str, *, source_offset: int = 0) -> _CelTranslation:
    """Translate CEL spellings and retain exact authored ranges per character."""
    output: list[str] = []
    source_ranges: list[tuple[int, int]] = []
    index = 0
    quote: str | None = None
    quote_start: int | None = None
    escaped = False

    def append(text: str, start: int, end: int) -> None:
        output.extend(text)
        source_ranges.extend((source_offset + start, source_offset + end) for _ in text)

    while index < len(source):
        char = source[index]
        if quote is not None:
            append(char, index, index + 1)
            if escaped:
                escaped = False
            elif char == "\\":
                escaped = True
            elif char == quote:
                quote = None
                quote_start = None
            index += 1
            continue
        if char in {"'", '"'}:
            quote = char
            quote_start = index
            append(char, index, index + 1)
            index += 1
            continue
        if source.startswith("&&", index):
            append(" and ", index, index + 2)
            index += 2
            continue
        if source.startswith("||", index):
            append(" or ", index, index + 2)
            index += 2
            continue
        if char == "!" and not source.startswith("!=", index):
            append("not ", index, index + 1)
            index += 1
            continue
        match = re.match(r"[A-Za-z_][A-Za-z0-9_]*", source[index:])
        if match:
            token = match.group(0)
            append(
                {"true": "True", "false": "False", "null": "None"}.get(token, token),
                index,
                index + len(token),
            )
            index += len(token)
            continue
        append(char, index, index + 1)
        index += 1
    if quote is not None:
        start = source_offset + (quote_start if quote_start is not None else len(source))
        raise ExpressionError(
            "invalid CEL expression: unterminated string",
            span={"start": start, "end": source_offset + len(source)},
        )
    return _CelTranslation("".join(output), tuple(source_ranges))


def compile_expression(
    value: Any,
    *,
    allowed_roots: Mapping[str, str] | set[str] | None = None,
    path_types: Mapping[Any, str] | None = None,
    expected_type: str | None = None,
) -> Expression:
    """Compile restricted CEL or JSON AST into canonical typed Expression IR.

    ``allowed_roots`` is mandatory in spirit but has a safe BIM-profile default
    for standalone callers.  Compiler call sites pass narrower environments.
    """
    if allowed_roots is None:
        root_types = dict(_DEFAULT_ROOT_TYPES)
    elif isinstance(allowed_roots, set):
        root_types = {root: _DEFAULT_ROOT_TYPES.get(root, "object") for root in allowed_roots}
    else:
        root_types = dict(allowed_roots)
    paths = dict(path_types or {})
    span: dict[str, int] | None = None
    if isinstance(value, str):
        source_start = len(value) - len(value.lstrip())
        source_end = len(value.rstrip())
        source = value[source_start:source_end]
        if not source:
            raise ExpressionError(
                "expression cannot be empty",
                span={"start": 0, "end": len(value)},
            )
        if len(source) > MAX_EXPRESSION_LENGTH:
            raise ExpressionError(
                "expression exceeds the maximum length",
                span={"start": source_start, "end": source_end},
            )
        translated = _cel_to_python(source, source_offset=source_start)
        try:
            tree = ast.parse(translated.text, mode="eval")
        except SyntaxError as exc:
            error_span = translated.syntax_span(exc)
            raise ExpressionError(
                f"invalid CEL expression at {error_span['start']}: {exc.msg}",
                span=error_span,
            ) from exc
        builder = _Builder(root_types, paths, translated)
        node, result_type = builder.python(tree.body)
        span = {"start": source_start, "end": source_end}
    else:
        builder = _Builder(root_types, paths)
        node, result_type = builder.json(value)
    if expected_type is not None:
        _require_type(result_type, expected_type, "expression result", span=span)
    return Expression(node, result_type, span)


def canonical_expression(value: Any, **kwargs: Any) -> dict[str, Any]:
    return compile_expression(value, **kwargs).ast
