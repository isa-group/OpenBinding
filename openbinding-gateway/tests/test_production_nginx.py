"""Static checks of nginx/production/nginx.conf: the gateway is resolved at request time, /api/ is stripped by a map."""

from __future__ import annotations

import re
from collections.abc import Callable

import pytest

from _repo import REPO_ROOT

NGINX_CONF = REPO_ROOT / "nginx" / "production" / "nginx.conf"
SERVER_NAME = "openbinding.score.us.es"
SET_LINE = ["set", "$gateway_upstream", "http://gateway:8000", ";"]
RESOLVER = ["resolver", "127.0.0.11", "valid=10s", "ipv6=off", ";"]


def tokenize(text: str) -> list[str]:
    """Tokens of an nginx configuration with comments removed: words, quoted strings, ``{``, ``}`` and ``;``."""
    tokens = []
    for match in re.finditer(r'#[^\n]*|"(?:[^"\\]|\\.)*"|\'(?:[^\'\\]|\\.)*\'|[{};]|[^\s{};"\']+', text):
        token = match[0]
        if not token.startswith("#"):
            tokens.append(token)
    return tokens


def statements(tokens: list[str]) -> list[list[str]]:
    """Directives as token lists; a block header is a statement that ends with ``{``, and ``}`` is its own."""
    result: list[list[str]] = []
    current: list[str] = []
    for token in tokens:
        if token == "}":
            assert not current, f"directive without ';' before '}}': {current}"
            result.append(["}"])
        elif token in (";", "{"):
            result.append([*current, token])
            current = []
        else:
            current.append(token)
    assert not current, f"unterminated directive: {current}"
    return result


def blocks(stmts: list[list[str]], header: list[str]) -> list[list[list[str]]]:
    """The bodies of the blocks whose header starts with ``header`` (nested blocks stay in the body)."""
    found = []
    for start, stmt in enumerate(stmts):
        if stmt[-1:] == ["{"] and stmt[: len(header)] == header:
            depth, body = 1, []
            for inner in stmts[start + 1 :]:
                if inner[-1:] == ["{"]:
                    depth += 1
                elif inner == ["}"]:
                    depth -= 1
                    if depth == 0:
                        break
                body.append(inner)
            found.append(body)
    return found


def block(stmts: list[list[str]], header: list[str]) -> list[list[str]]:
    found = blocks(stmts, header)
    assert found, f"block {header} is missing"
    return found[0]


def top_level(body: list[list[str]]) -> list[list[str]]:
    """The statements of a block body that are not inside a nested block (block headers included)."""
    depth, result = 0, []
    for stmt in body:
        if stmt == ["}"]:
            depth -= 1
        elif depth == 0:
            result.append(stmt)
        if stmt[-1:] == ["{"]:
            depth += 1
    return result


def conf_text() -> str:
    assert NGINX_CONF.is_file(), "nginx/production/nginx.conf"
    return NGINX_CONF.read_text(encoding="utf-8")


def conf_statements(text: str | None = None) -> list[list[str]]:
    return statements(tokenize(conf_text() if text is None else text))


def tls_server(text: str | None = None) -> list[list[str]]:
    servers = [
        server
        for server in blocks(conf_statements(text), ["server"])
        if ["server_name", SERVER_NAME, ";"] in server and ["listen", "443", "ssl", ";"] in server
    ]
    assert len(servers) == 1
    return servers[0]


def location(server: list[list[str]], *header: str) -> list[list[str]]:
    return block(server, ["location", *header])


def directives(stmts: list[list[str]], name: str) -> list[list[str]]:
    return [stmt for stmt in stmts if stmt[0] == name]


def assert_resolver(text: str | None = None) -> None:
    server = top_level(tls_server(text))
    assert directives(server, "resolver") == [RESOLVER]
    assert directives(server, "resolver_timeout") == [["resolver_timeout", "5s", ";"]]


def assert_gateway_variable(text: str | None = None) -> None:
    server = tls_server(text)
    assert SET_LINE in top_level(server), "set $gateway_upstream is not at server level"
    assert len(directives(server, "set")) == 1


def assert_proxy_passes(text: str | None = None) -> None:
    server = tls_server(text)
    passes = [stmt for stmt in server if stmt[0] == "proxy_pass"]
    assert len(passes) >= 3
    assert all("$gateway_upstream" in stmt[1] for stmt in passes), passes
    assert location(server, "^~", "/api/").count(["proxy_pass", "$gateway_upstream$gateway_api_uri", ";"]) == 1
    others = [stmt for stmt in passes if stmt[1] != "$gateway_upstream$gateway_api_uri"]
    assert len(others) == len(passes) - 1
    assert all(stmt == ["proxy_pass", "$gateway_upstream", ";"] for stmt in others), others
    for prefix in ("/static/", "/avatars/"):
        assert ["proxy_pass", "$gateway_upstream", ";"] in location(server, "^~", prefix)
    whole = conf_statements(text)
    assert all(stmt[1].startswith("$") for stmt in whole if stmt[0] == "proxy_pass"), "a literal proxy_pass"


def assert_no_rewrite_and_no_literal_address(text: str | None = None) -> None:
    stmts = conf_statements(text)
    assert not directives(stmts, "rewrite")
    literal = [stmt for stmt in stmts if any("gateway:8000" in word for word in stmt)]
    assert literal == [SET_LINE]


def api_regex(text: str | None = None) -> str:
    stmts = conf_statements(text)
    maps = [stmt for stmt in stmts if stmt[:3] == ["map", "$request_uri", "$gateway_api_uri"]]
    assert len(maps) == 1
    body = block(stmts, ["map", "$request_uri", "$gateway_api_uri"])
    assert ["default", '""', ";"] in body
    patterns = [stmt for stmt in body if stmt[0].startswith("~")]
    assert patterns == [["~^/api(/.*)$", "$1", ";"]]
    return patterns[0][0].removeprefix("~")


def assert_map_regex(text: str | None = None) -> None:
    assert api_regex(text) == "^/api(/.*)$"


def assert_api_location(text: str | None = None) -> None:
    server = tls_server(text)
    api = location(server, "^~", "/api/")
    guard = block(api, ["if", "($gateway_api_uri", "=", '""', ")"])
    assert ["return", "400", ";"] in guard, "return 400 is not inside the if block"
    assert location(server, "=", "/api") == [["return", "308", "/api/", ";"]]


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_tls_server_has_a_docker_resolver_with_a_short_cache_no_ipv6_and_a_timeout():
    assert_resolver()


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_tls_server_keeps_the_gateway_address_in_a_server_level_variable():
    assert_gateway_variable()


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_every_proxy_pass_uses_the_gateway_variable_and_none_is_literal():
    assert_proxy_passes()


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_no_rewrite_and_no_literal_gateway_address_besides_the_set_line():
    assert_no_rewrite_and_no_literal_address()


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_the_map_yields_empty_by_default_and_the_tail_after_api():
    assert_map_regex()


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_api_location_rejects_an_empty_tail_inside_the_if_and_bare_api_redirects():
    assert_api_location()


def tail(uri: str) -> str | None:
    match = re.search(api_regex(), uri)
    return match[1] if match else None


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_the_map_regex_strips_api_from_the_raw_uri():
    assert tail("/api/") == "/"
    assert tail("/api/x?y=1") == "/x?y=1"
    assert tail("/api/v1/a%2Fb?x=1&y=%20") == "/v1/a%2Fb?x=1&y=%20"


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_the_map_regex_does_not_match_uris_that_reach_api_only_after_normalisation():
    for uri in ("//api/x", "/%61pi/x", "/a/../api/x", "/apix", "/API/x"):
        assert tail(uri) is None, uri


def test_api_keeps_the_long_read_timeout_for_synchronous_solves():
    api = location(tls_server(), "^~", "/api/")
    assert ["proxy_read_timeout", "1860", ";"] in api


def request_time_resolution_problems(text: str) -> list[str]:
    """The rules that make nginx follow a new gateway address, applied to one configuration text."""
    problems = []
    stmts = conf_statements(text)
    server = tls_server(text)
    if not any(stmt[:2] == ["resolver", "127.0.0.11"] for stmt in server):
        problems.append("no resolver")
    passes = [stmt for stmt in stmts if stmt[0] == "proxy_pass"]
    if len(passes) < 3 or not all(stmt[1].startswith("$gateway_upstream") for stmt in passes):
        problems.append("a literal proxy_pass")
    if directives(stmts, "rewrite"):
        problems.append("a rewrite")
    return problems


def test_the_rules_hold_for_the_file_and_fail_on_copies_that_break_them():
    text = conf_text()
    assert request_time_resolution_problems(text) == []
    literal = text.replace("proxy_pass          $gateway_upstream;", "proxy_pass          http://gateway:8000;", 1)
    assert literal != text
    assert request_time_resolution_problems(literal) == ["a literal proxy_pass"]
    no_resolver = re.sub(r"^\s*resolver [^\n]*\n", "", text, flags=re.MULTILINE)
    assert no_resolver != text
    assert request_time_resolution_problems(no_resolver) == ["no resolver"]
    rewritten = text.replace("proxy_redirect      off;", "rewrite ^/api/(.*)$ /$1 break;", 1)
    assert rewritten != text
    assert request_time_resolution_problems(rewritten) == ["a rewrite"]
    commented = text.replace("    resolver 127.0.0.11", "    # resolver 127.0.0.11")
    assert commented != text
    assert request_time_resolution_problems(commented) == ["no resolver"]


# [utest->req~lab-deployment-production-proxy-upstream~1]
def test_the_pinning_assertions_fail_on_mutated_copies():
    """Each pinning assertion runs on an in-memory copy that breaks the rule it pins and must raise."""
    text = conf_text()
    api_return = '            return 400;\n        }\n'
    cases: list[tuple[str, str, Callable[[str], None]]] = [
        (
            "map on $uri",
            text.replace("map $request_uri $gateway_api_uri", "map $uri $gateway_api_uri", 1),
            assert_map_regex,
        ),
        ("resolver without valid=", text.replace("127.0.0.11 valid=10s ipv6=off;", "127.0.0.11 ipv6=off;", 1), assert_resolver),
        ("resolver without ipv6=off", text.replace("127.0.0.11 valid=10s ipv6=off;", "127.0.0.11 valid=10s;", 1), assert_resolver),
        ("no resolver_timeout", text.replace("    resolver_timeout 5s;\n", "", 1), assert_resolver),
        ("another resolver_timeout", text.replace("resolver_timeout 5s;", "resolver_timeout 30s;", 1), assert_resolver),
        ("commented resolver", text.replace("    resolver 127.0.0.11", "    # resolver 127.0.0.11", 1), assert_resolver),
        (
            "proxy_pass of /api/ without $gateway_api_uri",
            text.replace("$gateway_upstream$gateway_api_uri;", "$gateway_upstream;", 1),
            assert_proxy_passes,
        ),
        (
            "literal gateway address in proxy_pass",
            text.replace("proxy_pass          $gateway_upstream;", "proxy_pass          http://gateway:8000;", 1),
            assert_proxy_passes,
        ),
        (
            "literal gateway address in proxy_pass (second rule)",
            text.replace("proxy_pass          $gateway_upstream;", "proxy_pass          http://gateway:8000;", 1),
            assert_no_rewrite_and_no_literal_address,
        ),
        (
            "a rewrite",
            text.replace("proxy_redirect      off;", "rewrite ^/api/(.*)$ /$1 break;", 1),
            assert_no_rewrite_and_no_literal_address,
        ),
        ("return 400 after the if block", text.replace(api_return, "        }\n        return 400;\n", 1), assert_api_location),
        (
            "set inside a location",
            text.replace("    set $gateway_upstream http://gateway:8000;\n", "", 1).replace(
                "    location = /api {\n", "    location = /api {\n        set $gateway_upstream http://gateway:8000;\n", 1
            ),
            assert_gateway_variable,
        ),
    ]
    for name, mutated, check in cases:
        assert mutated != text, f"{name}: the replacement changed nothing"
        with pytest.raises(AssertionError):
            check(mutated)
    for check in (
        assert_resolver,
        assert_gateway_variable,
        assert_proxy_passes,
        assert_no_rewrite_and_no_literal_address,
        assert_map_regex,
        assert_api_location,
    ):
        check(text)


def test_the_standalone_service_document_has_no_kubernetes_and_the_readme_points_to_it():
    service = REPO_ROOT / "bim-toolchain" / "docs" / "SERVICE.md"
    assert service.is_file(), "bim-toolchain/docs/SERVICE.md"
    assert "kubernetes" not in service.read_text(encoding="utf-8").lower()
    readme = (REPO_ROOT / "README.md").read_text(encoding="utf-8")
    assert "[`bim-toolchain/docs/SERVICE.md`](bim-toolchain/docs/SERVICE.md)" in readme
