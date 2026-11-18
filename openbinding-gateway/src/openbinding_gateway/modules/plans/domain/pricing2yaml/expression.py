"""A safe evaluator of Pricing2Yaml price expressions (``"#map[String(#seats)] * 12"``).

Grammar ported from pricing-renderer ``src/core/expression.ts`` (v0.2.0; MIT, Copyright (c) 2026
Francisco Javier Cavero): a tokenizer and a precedence-climbing parser, never ``eval``. It accepts
numbers, strings, ``#variables``, member and index access, ``+ - * / %``, comparisons, ``&& || !``,
the ternary, ``Math.floor/ceil/round/trunc/abs/min/max``, ``.concat`` on strings and, as the one extra
function, ``String(x)`` (SPHERE's data uses ``#map[String(#var)]``; pricing-renderer accepts it through
``options.expression.functions``). Arithmetic runs in ``Decimal`` and is converted at the end;
``Math.round`` is JavaScript's ``floor(x + 0.5)`` and ``String`` writes numbers as JavaScript does.

Limits: 1000 characters, 500 tokens, 500 nodes, depth 40; a string value of at most 4 KiB and an array of
at most 1000 items (checked at every ``+`` and ``.concat`` and on the variables before evaluating). Errors are
values (``ExpressionError``), never exceptions to callers, and a result that is not a finite non-negative
number is an error.
"""

from __future__ import annotations

import math
import re
from collections.abc import Mapping
from dataclasses import dataclass
from decimal import Decimal, DivisionByZero, InvalidOperation, localcontext
from typing import Any

from ..content_hash import js_number

MAX_SOURCE_LENGTH = 1_000
MAX_TOKENS = 500
MAX_NODES = 500
MAX_DEPTH = 40
MAX_STRING = 4 * 1024
MAX_ARRAY = 1_000
MAX_ARGUMENTS = 20
FORBIDDEN_PROPERTIES = frozenset({"constructor", "prototype", "__proto__", "__class__", "__dict__"})
MATH_METHODS = frozenset({"floor", "ceil", "round", "trunc", "abs", "min", "max"})
PRECEDENCE = {
    "||": 1, "&&": 2, "===": 3, "!==": 3, "==": 3, "!=": 3,
    "<": 4, "<=": 4, ">": 4, ">=": 4, "+": 5, "-": 5, "*": 6, "/": 6, "%": 6,
}
OPERATORS = ("===", "!==", "<=", ">=", "&&", "||", "==", "!=", "+", "-", "*", "/", "%", "<", ">", "!")
_NUMBER = re.compile(r"(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?")
_NAME = re.compile(r"[A-Za-z_$][\w$]*")
_ESCAPES = {"n": "\n", "r": "\r", "t": "\t", "\\": "\\", "'": "'", '"': '"'}


@dataclass(frozen=True)
class ExpressionError:
    """Why an expression has no value: ``kind`` is stable, ``message`` for people, ``at`` a character offset."""

    kind: str
    message: str
    at: int = 0


class _Fail(Exception):
    def __init__(self, kind: str, message: str, at: int = 0) -> None:
        super().__init__(message)
        self.error = ExpressionError(kind, message, at)


class _Undefined:
    def __repr__(self) -> str:  # pragma: no cover - debugging aid
        return "undefined"


UNDEFINED = _Undefined()


# --- tokens and syntax tree --------------------------------------------------------------------------------------


@dataclass(frozen=True)
class _Token:
    kind: str  # number, string, identifier, variable, operator, punctuation, eof
    value: str
    at: int


def _tokenize(source: str) -> list[_Token]:
    if len(source) > MAX_SOURCE_LENGTH:
        raise _Fail("too_long", f"the expression is longer than {MAX_SOURCE_LENGTH} characters", MAX_SOURCE_LENGTH)
    tokens: list[_Token] = []
    i = 0
    while i < len(source):
        char = source[i]
        if char.isspace():
            i += 1
            continue
        start = i
        if char.isdigit() or (char == "." and i + 1 < len(source) and source[i + 1].isdigit()):
            match = _NUMBER.match(source, i)
            if not match:  # pragma: no cover - the first character guarantees a match
                raise _Fail("syntax", "invalid number", i)
            tokens.append(_Token("number", match.group(0), start))
            i = match.end()
        elif char in "'\"":
            i += 1
            text: list[str] = []
            while True:
                if i >= len(source):
                    raise _Fail("syntax", "unterminated string", start)
                current = source[i]
                if current == char:
                    i += 1
                    break
                if current == "\\":
                    escaped = source[i + 1] if i + 1 < len(source) else ""
                    if escaped not in _ESCAPES:
                        raise _Fail("syntax", "unsupported string escape", i)
                    text.append(_ESCAPES[escaped])
                    i += 2
                else:
                    text.append(current)
                    i += 1
            tokens.append(_Token("string", "".join(text), start))
        elif char == "#":
            match = _NAME.match(source, i + 1)
            if not match:
                raise _Fail("syntax", "expected a variable name after #", start)
            tokens.append(_Token("variable", match.group(0), start))
            i = match.end()
        elif _NAME.match(source, i):
            match = _NAME.match(source, i)
            assert match is not None
            tokens.append(_Token("identifier", match.group(0), start))
            i = match.end()
        else:
            operator = next((op for op in OPERATORS if source.startswith(op, i)), None)
            if operator is not None:
                tokens.append(_Token("operator", operator, start))
                i += len(operator)
            elif char in "()[]{},.?:":
                tokens.append(_Token("punctuation", char, start))
                i += 1
            else:
                raise _Fail("syntax", f'unsupported token "{char}"', start)
        if len(tokens) > MAX_TOKENS:
            raise _Fail("too_complex", f"the expression has more than {MAX_TOKENS} tokens", i)
    tokens.append(_Token("eof", "", len(source)))
    return tokens


# Nodes are tuples: (type, ...). Types: lit, var, ident, array, object, unary, binary, cond, member, call.


class _Parser:
    def __init__(self, tokens: list[_Token]) -> None:
        self.tokens = tokens
        self.i = 0

    def current(self) -> _Token:
        return self.tokens[self.i]

    def match(self, kind: str, value: str | None = None) -> bool:
        token = self.current()
        return token.kind == kind and (value is None or token.value == value)

    def take(self) -> _Token:
        token = self.current()
        self.i += 1
        return token

    def expect(self, kind: str, value: str | None = None) -> _Token:
        if not self.match(kind, value):
            raise _Fail("syntax", f"expected {value or kind}", self.current().at)
        return self.take()

    def parse(self) -> tuple:
        node = self.conditional()
        self.expect("eof")
        _check_complexity(node)
        return node

    def conditional(self) -> tuple:
        test = self.binary(1)
        if not self.match("punctuation", "?"):
            return test
        self.take()
        consequent = self.conditional()
        self.expect("punctuation", ":")
        alternate = self.conditional()
        return ("cond", test, consequent, alternate)

    def binary(self, minimum: int) -> tuple:
        left = self.unary()
        while self.match("operator"):
            operator = self.current().value
            precedence = PRECEDENCE.get(operator)
            if precedence is None or precedence < minimum:
                break
            self.take()
            right = self.binary(precedence + 1)
            left = ("binary", operator, left, right)
        return left

    def unary(self) -> tuple:
        if self.match("operator") and self.current().value in {"!", "+", "-"}:
            operator = self.take().value
            return ("unary", operator, self.unary())
        return self.postfix(self.primary())

    def primary(self) -> tuple:
        token = self.current()
        if token.kind == "number":
            self.take()
            return ("lit", Decimal(token.value))
        if token.kind == "string":
            self.take()
            return ("lit", token.value)
        if token.kind == "variable":
            self.take()
            return ("var", token.value, token.at)
        if token.kind == "identifier":
            self.take()
            if token.value in {"true", "false"}:
                return ("lit", token.value == "true")
            if token.value == "null":
                return ("lit", None)
            return ("ident", token.value, token.at)
        if self.match("punctuation", "["):
            self.take()
            elements: list[tuple] = []
            if not self.match("punctuation", "]"):
                while True:
                    elements.append(self.conditional())
                    if not self.match("punctuation", ","):
                        break
                    self.take()
                    if self.match("punctuation", "]"):
                        break
            self.expect("punctuation", "]")
            return ("array", tuple(elements))
        if self.match("punctuation", "{"):
            self.take()
            properties: list[tuple[str, tuple]] = []
            if not self.match("punctuation", "}"):
                while True:
                    key = self.current()
                    if key.kind not in {"identifier", "string"}:
                        raise _Fail("syntax", "expected an object property name", key.at)
                    self.take()
                    if key.value in FORBIDDEN_PROPERTIES:
                        raise _Fail("not_allowed", f'property "{key.value}" is not allowed', key.at)
                    self.expect("punctuation", ":")
                    properties.append((key.value, self.conditional()))
                    if not self.match("punctuation", ","):
                        break
                    self.take()
                    if self.match("punctuation", "}"):
                        break
            self.expect("punctuation", "}")
            return ("object", tuple(properties))
        if self.match("punctuation", "("):
            self.take()
            inner = self.conditional()
            self.expect("punctuation", ")")
            return inner
        raise _Fail("syntax", "expected an expression", token.at)

    def postfix(self, node: tuple) -> tuple:
        while True:
            if self.match("punctuation", "."):
                self.take()
                name = self.expect("identifier")
                node = ("member", node, ("lit", name.value), False, name.at)
            elif self.match("punctuation", "["):
                at = self.take().at
                prop = self.conditional()
                self.expect("punctuation", "]")
                node = ("member", node, prop, True, at)
            elif self.match("punctuation", "("):
                at = self.take().at
                arguments: list[tuple] = []
                if not self.match("punctuation", ")"):
                    while len(arguments) <= MAX_ARGUMENTS:
                        arguments.append(self.conditional())
                        if not self.match("punctuation", ","):
                            break
                        self.take()
                self.expect("punctuation", ")")
                node = ("call", node, tuple(arguments), at)
            else:
                return node


def _children(node: tuple) -> list[tuple]:
    kind = node[0]
    if kind == "unary":
        return [node[2]]
    if kind == "array":
        return list(node[1])
    if kind == "object":
        return [value for _, value in node[1]]
    if kind == "binary":
        return [node[2], node[3]]
    if kind == "cond":
        return [node[1], node[2], node[3]]
    if kind == "member":
        return [node[1], node[2]]
    if kind == "call":
        return [node[1], *node[2]]
    return []


def _check_complexity(root: tuple) -> None:
    count = 0
    stack = [(root, 1)]
    while stack:
        node, depth = stack.pop()
        count += 1
        if count > MAX_NODES:
            raise _Fail("too_complex", f"the expression has more than {MAX_NODES} nodes")
        if depth > MAX_DEPTH:
            raise _Fail("too_complex", f"the expression is nested deeper than {MAX_DEPTH} levels")
        stack.extend((child, depth + 1) for child in _children(node))


def parse(source: str) -> tuple | ExpressionError:
    """The syntax tree of ``source``, or why it cannot be read."""
    try:
        return _Parser(_tokenize(source)).parse()
    except _Fail as fail:
        return fail.error
    except RecursionError:
        return ExpressionError("too_complex", f"the expression is nested deeper than {MAX_DEPTH} levels")


def dependencies(source: str) -> tuple[str, ...]:
    """The ``#variables`` an expression reads (empty when it cannot be parsed)."""
    tree = parse(source)
    if isinstance(tree, ExpressionError):
        return tuple(dict.fromkeys(re.findall(r"#([A-Za-z_$][\w$]*)", source)))
    names: dict[str, None] = {}
    stack = [tree]
    while stack:
        node = stack.pop()
        if node[0] == "var":
            names[node[1]] = None
        stack.extend(_children(node))
    return tuple(sorted(names))


# --- values ------------------------------------------------------------------------------------------------------


def _js_key(key: Any) -> str:
    if isinstance(key, str):
        return key
    if isinstance(key, bool):
        return "true" if key else "false"
    if isinstance(key, (int, float, Decimal)):
        return js_number(float(key)) if not isinstance(key, int) else js_number(key)
    if key is None:
        return "null"
    return str(key)


def _import(value: Any, at: int = 0) -> Any:
    """A YAML value as the evaluator holds it: numbers as ``Decimal``, sizes checked."""
    if isinstance(value, bool) or value is None or isinstance(value, Decimal):
        return value
    if isinstance(value, int):
        return Decimal(value)
    if isinstance(value, float):
        if math.isnan(value):
            return Decimal("NaN")
        if math.isinf(value):
            return Decimal("Infinity") if value > 0 else Decimal("-Infinity")
        return Decimal(repr(value))
    if isinstance(value, str):
        _check_string(value, at)
        return value
    if isinstance(value, (list, tuple)):
        _check_array(value, at)
        return [_import(item, at) for item in value]
    if isinstance(value, Mapping):
        return {_js_key(k): _import(v, at) for k, v in value.items()}
    return str(value)


def _check_string(value: str, at: int) -> None:
    if len(value.encode("utf-8")) > MAX_STRING:
        raise _Fail("too_large", f"a text value is longer than {MAX_STRING} bytes", at)


def _check_array(value: list | tuple, at: int) -> None:
    if len(value) > MAX_ARRAY:
        raise _Fail("too_large", f"a list has more than {MAX_ARRAY} items", at)


def _truthy(value: Any) -> bool:
    if value is None or value is UNDEFINED or value is False:
        return False
    if isinstance(value, Decimal):
        return not (value.is_nan() or value == 0)
    if isinstance(value, str):
        return value != ""
    return True


def _number(value: Any) -> Decimal:
    if isinstance(value, bool):
        return Decimal(1 if value else 0)
    if value is None:
        return Decimal(0)
    if isinstance(value, Decimal):
        return value
    if isinstance(value, str):
        text = value.strip()
        if text == "":
            return Decimal(0)
        try:
            return Decimal(text) if re.fullmatch(r"[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?", text) else Decimal("NaN")
        except InvalidOperation:
            return Decimal("NaN")
    if isinstance(value, list):
        if not value:
            return Decimal(0)
        if len(value) == 1:
            return _number(value[0] if not isinstance(value[0], list) else _string(value[0]))
        return Decimal("NaN")
    return Decimal("NaN")


def _string(value: Any) -> str:
    """``String(value)`` in JavaScript."""
    if value is None:
        return "null"
    if value is UNDEFINED:
        return "undefined"
    if isinstance(value, bool):
        return "true" if value else "false"
    if isinstance(value, Decimal):
        if value.is_nan():
            return "NaN"
        if value.is_infinite():
            return "Infinity" if value > 0 else "-Infinity"
        return js_number(float(value))
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return ",".join("" if item is None or item is UNDEFINED else _string(item) for item in value)
    if isinstance(value, dict):
        return "[object Object]"
    return str(value)


def _strict_equal(left: Any, right: Any) -> bool:
    if isinstance(left, Decimal) and isinstance(right, Decimal):
        if left.is_nan() or right.is_nan():
            return False
        return left == right
    if type(left) is not type(right):
        return False
    if isinstance(left, (list, dict)):
        return left is right
    return left == right


def _compare(operator: str, left: Any, right: Any) -> bool:
    if isinstance(left, str) and isinstance(right, str):
        a, b = left.encode("utf-16-be"), right.encode("utf-16-be")
    else:
        a, b = _number(left), _number(right)  # type: ignore[assignment]
        if a.is_nan() or b.is_nan():  # type: ignore[union-attr]
            return False
    return {"<": a < b, "<=": a <= b, ">": a > b, ">=": a >= b}[operator]


def _member(obj: Any, prop: Any, at: int) -> Any:
    key = _string(prop)
    if key in FORBIDDEN_PROPERTIES or key.startswith("__"):
        raise _Fail("not_allowed", f'property "{key}" is not allowed', at)
    if key == "length" and isinstance(obj, (str, list)):
        return Decimal(len(obj))
    if isinstance(obj, (list, str)):
        if not re.fullmatch(r"\d+", key):
            raise _Fail("not_allowed", f'property "{key}" is not allowed on a {"list" if isinstance(obj, list) else "text"}', at)
        index = int(key)
        return obj[index] if index < len(obj) else UNDEFINED
    if isinstance(obj, dict):
        return obj.get(key, UNDEFINED)
    if obj is None or obj is UNDEFINED:
        raise _Fail("not_number", f'cannot read "{key}" of {_string(obj)}', at)
    return UNDEFINED


def _math(method: str, arguments: list[Any], at: int) -> Decimal:
    numbers = [_number(a) for a in arguments]
    if method in {"min", "max"}:
        if any(n.is_nan() for n in numbers):
            return Decimal("NaN")
        if not numbers:
            return Decimal("Infinity") if method == "min" else Decimal("-Infinity")
        return min(numbers) if method == "min" else max(numbers)
    value = numbers[0] if numbers else Decimal("NaN")
    if value.is_nan() or value.is_infinite():
        return value
    if method == "floor":
        return Decimal(math.floor(value))
    if method == "ceil":
        return Decimal(math.ceil(value))
    if method == "round":
        return Decimal(math.floor(value + Decimal("0.5")))
    if method == "trunc":
        return Decimal(int(value))
    if method == "abs":
        return abs(value)
    raise _Fail("not_allowed", f"Math.{method} is not allowed", at)  # pragma: no cover


class _Evaluator:
    def __init__(self, variables: Mapping[str, Any]) -> None:
        self.variables = variables

    def run(self, node: tuple, depth: int = 0) -> Any:
        if depth > MAX_DEPTH:
            raise _Fail("too_complex", "the expression is nested too deeply")
        kind = node[0]
        if kind == "lit":
            return node[1]
        if kind == "var":
            if node[1] not in self.variables:
                raise _Fail("undefined_variable", f'variable "#{node[1]}" is not defined', node[2])
            return self.variables[node[1]]
        if kind == "ident":
            raise _Fail("not_allowed", f'"{node[1]}" can only be used as an allowed function', node[2])
        if kind == "array":
            items = [self.run(element, depth + 1) for element in node[1]]
            _check_array(items, 0)
            return items
        if kind == "object":
            return {key: self.run(value, depth + 1) for key, value in node[1]}
        if kind == "unary":
            value = self.run(node[2], depth + 1)
            if node[1] == "!":
                return not _truthy(value)
            number = _number(value)
            return number if node[1] == "+" else -number
        if kind == "binary":
            return self.binary(node, depth)
        if kind == "cond":
            chosen = node[2] if _truthy(self.run(node[1], depth + 1)) else node[3]
            return self.run(chosen, depth + 1)
        if kind == "member":
            return _member(self.run(node[1], depth + 1), self.run(node[2], depth + 1), node[4])
        if kind == "call":
            return self.call(node, depth)
        raise _Fail("syntax", f"unknown node {kind}")  # pragma: no cover

    def binary(self, node: tuple, depth: int) -> Any:
        _, operator, left_node, right_node = node
        if operator == "&&":
            left = self.run(left_node, depth + 1)
            return self.run(right_node, depth + 1) if _truthy(left) else left
        if operator == "||":
            left = self.run(left_node, depth + 1)
            return left if _truthy(left) else self.run(right_node, depth + 1)
        left = self.run(left_node, depth + 1)
        right = self.run(right_node, depth + 1)
        if operator == "+":
            if isinstance(left, (str, list, dict)) or isinstance(right, (str, list, dict)):
                text = _string(left) + _string(right)
                _check_string(text, 0)
                return text
            return _number(left) + _number(right)
        if operator in {"-", "*", "/", "%"}:
            a, b = _number(left), _number(right)
            if operator == "-":
                return a - b
            if operator == "*":
                return a * b
            if operator == "/":
                if b == 0:
                    if a == 0 or a.is_nan():
                        return Decimal("NaN")
                    return Decimal("Infinity") if (a > 0) == (not b.is_signed()) else Decimal("-Infinity")
                return a / b
            if b == 0 or a.is_infinite():
                return Decimal("NaN")
            return a % b  # Decimal's remainder keeps the dividend's sign, as JavaScript's does
        if operator in {"<", "<=", ">", ">="}:
            return _compare(operator, left, right)
        if operator in {"===", "=="}:
            return _strict_equal(left, right)
        if operator in {"!==", "!="}:
            return not _strict_equal(left, right)
        raise _Fail("not_allowed", f'operator "{operator}" is not allowed')  # pragma: no cover

    def call(self, node: tuple, depth: int) -> Any:
        _, callee, argument_nodes, at = node
        if len(argument_nodes) > MAX_ARGUMENTS:
            raise _Fail("too_complex", "a call has too many arguments", at)
        arguments = [self.run(argument, depth + 1) for argument in argument_nodes]
        if callee[0] == "ident":
            if callee[1] == "String":
                text = _string(arguments[0]) if arguments else ""
                _check_string(text, at)
                return text
            raise _Fail("not_allowed", f'function "{callee[1]}" is not allowed', callee[2])
        if callee[0] == "member" and callee[1][0] == "ident" and callee[1][1] == "Math" and callee[2][0] == "lit":
            method = str(callee[2][1])
            if method not in MATH_METHODS:
                raise _Fail("not_allowed", f"Math.{method} is not allowed", at)
            return _math(method, arguments, at)
        if callee[0] == "member" and callee[2][0] == "lit" and callee[2][1] == "concat":
            receiver = self.run(callee[1], depth + 1)
            if not isinstance(receiver, str):
                raise _Fail("not_allowed", "concat is only allowed on texts", at)
            text = receiver + "".join(_string(argument) for argument in arguments)
            _check_string(text, at)
            return text
        raise _Fail("not_allowed", "this function call is not allowed", at)


@dataclass(frozen=True)
class Evaluation:
    """The value of a price expression (a finite non-negative number) or the error that prevents it."""

    value: float | None
    error: ExpressionError | None = None


def evaluate(source: str, variables: Mapping[str, Any]) -> Evaluation:
    """Evaluate a price expression over ``variables`` (the pricing's ``variables`` defaults)."""
    tree = parse(source)
    if isinstance(tree, ExpressionError):
        return Evaluation(None, tree)
    try:
        with localcontext() as context:
            context.prec = 34
            context.traps[DivisionByZero] = False
            context.traps[InvalidOperation] = False
            imported = {_js_key(k): _import(v) for k, v in variables.items()}
            result = _Evaluator(imported).run(tree)
    except _Fail as fail:
        return Evaluation(None, fail.error)
    except RecursionError:
        return Evaluation(None, ExpressionError("too_complex", "the expression is nested too deeply"))
    if not isinstance(result, Decimal) or result.is_nan() or result.is_infinite() or result < 0:
        return Evaluation(None, ExpressionError("not_number", "the expression must give a finite, non-negative number"))
    return Evaluation(float(result))
