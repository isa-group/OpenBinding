"""Static checks of nginx/production/nginx.conf: the gateway is resolved at request time, /api/ is stripped by a map."""

from __future__ import annotations

import re

from _repo import REPO_ROOT

NGINX_CONF = REPO_ROOT / "nginx" / "production" / "nginx.conf"
SERVER_NAME = "openbinding.score.us.es"


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


def test_tls_server_has_a_docker_resolver_with_a_short_cache_and_no_ipv6():
    resolvers = directives(tls_server(), "resolver")
    assert len(resolvers) == 1
    assert resolvers[0] == ["resolver", "127.0.0.11", "valid=10s", "ipv6=off", ";"]


def test_tls_server_keeps_the_gateway_address_in_a_variable():
    server = tls_server()
    assert ["set", "$gateway_upstream", "http://gateway:8000", ";"] in server
    assert len(directives(server, "set")) == 1


def test_every_proxy_pass_uses_the_gateway_variable_and_none_is_literal():
    server = tls_server()
    passes = [stmt for stmt in server if stmt[0] == "proxy_pass"]
    assert len(passes) >= 3
    assert all("$gateway_upstream" in stmt[1] for stmt in passes), passes
    assert location(server, "^~", "/api/").count(["proxy_pass", "$gateway_upstream$gateway_api_uri", ";"]) == 1
    others = [stmt for stmt in passes if stmt[1] != "$gateway_upstream$gateway_api_uri"]
    assert len(others) == len(passes) - 1
    assert all(stmt == ["proxy_pass", "$gateway_upstream", ";"] for stmt in others), others
    for prefix in ("/static/", "/avatars/"):
        assert ["proxy_pass", "$gateway_upstream", ";"] in location(server, "^~", prefix)
    whole = conf_statements()
    assert all(stmt[1].startswith("$") for stmt in whole if stmt[0] == "proxy_pass"), "a literal proxy_pass"


def test_no_rewrite_and_no_literal_gateway_address_besides_the_set_line():
    stmts = conf_statements()
    assert not directives(stmts, "rewrite")
    literal = [stmt for stmt in stmts if any("gateway:8000" in word for word in stmt)]
    assert literal == [["set", "$gateway_upstream", "http://gateway:8000", ";"]]


def api_regex() -> str:
    maps = [stmt for stmt in conf_statements() if stmt[:3] == ["map", "$request_uri", "$gateway_api_uri"]]
    assert len(maps) == 1
    body = block(conf_statements(), ["map", "$request_uri", "$gateway_api_uri"])
    assert ["default", '""', ";"] in body
    patterns = [stmt for stmt in body if stmt[0].startswith("~")]
    assert patterns == [["~^/api(/.*)$", "$1", ";"]]
    return patterns[0][0].removeprefix("~")


def test_the_map_yields_empty_by_default_and_the_tail_after_api():
    assert api_regex() == "^/api(/.*)$"


def test_api_location_rejects_an_empty_tail_and_bare_api_redirects():
    server = tls_server()
    api = location(server, "^~", "/api/")
    assert api.index(["if", "($gateway_api_uri", "=", '""', ")", "{"]) < api.index(["return", "400", ";"])
    assert location(server, "=", "/api") == [["return", "308", "/api/", ";"]]


def tail(uri: str) -> str | None:
    match = re.search(api_regex(), uri)
    return match[1] if match else None


def test_the_map_regex_strips_api_from_the_raw_uri():
    assert tail("/api/") == "/"
    assert tail("/api/x?y=1") == "/x?y=1"
    assert tail("/api/v1/a%2Fb?x=1&y=%20") == "/v1/a%2Fb?x=1&y=%20"


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
    assert request_time_resolution_problems(commented) == ["no resolver"]
