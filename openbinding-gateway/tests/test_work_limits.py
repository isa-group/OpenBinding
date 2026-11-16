"""Per-client budgets on the routes open to anybody that do real CPU work."""

from __future__ import annotations

import logging

import pytest
from fastapi.routing import APIRoute
from httpx import ASGITransport, AsyncClient

from _b1_helpers import gate, make_account, make_key  # noqa: F401
from _ratelimit_fakes import DownBackend, FakeRedis
from openbinding_gateway.access.dependencies import get_reader
from openbinding_gateway.access.work_limits import (
    ANONYMOUS_READ_ROUTES,
    WORK_ROUTES,
    WorkRateLimiter,
    get_work_limiter,
    set_work_limiter,
)
from openbinding_gateway.core import ratelimit
from openbinding_gateway.core.ratelimit import RedisBackend, client_bucket
from openbinding_gateway.core.settings import get_settings
from _problem_helpers import upload_problem
from openbinding_gateway.main import app
from openbinding_gateway.modules.problems.adapters import bim_routes

#: The counted route the mechanism tests below go through. An empty package is refused with
#: a 422 only after being counted, and refusing one costs nothing worth waiting for.
PROBE = "/v1/bim/validate"
EMPTY_PACKAGE = {"content": b"", "headers": {"content-type": "application/vnd.bim+zip"}}
COMPILATION = "/v1/organizations/{org}/problems/{problem}/revisions/{revision}/compilation"
#: A Composition2Yaml request each language service counts and then refuses (an empty document).
EMPTY_YAML = {"content": b"", "headers": {"content-type": "application/yaml"}}
EMPTY_JSON = {"content": b"{}", "headers": {"content-type": "application/json"}}
LANGUAGE = "/v1/compositions"
VERSIONS = "/v1/organizations/{org}/compositions/{composition}/versions"
FORK = "/v1/organizations/{org}/compositions/{composition}/fork"
REEVALUATE = "/v1/organizations/{org}/compositions/{composition}/versions/{version}/evaluations"
EVALUATE = "/v1/organizations/{org}/compositions/{composition}/evaluate"
NEIGHBORHOOD = "/v1/organizations/{org}/compositions/{composition}/neighborhood"
DERIVE = "/v1/organizations/{org}/compositions/{composition}/derive"

#: A request for every route that reaches the limiter: ``(method, template) -> (method, concrete path, body)``,
#: the concrete path filled in by the ``member`` fixture's organization and problem.
REQUESTS = {
    ("POST", PROBE): ("POST", PROBE, EMPTY_PACKAGE),
    ("POST", "/v1/organizations/{org}/problems"): ("POST", "/v1/organizations/{org}/problems", EMPTY_PACKAGE),
    ("POST", "/v1/organizations/{org}/problems/{problem}/revisions"): (
        "POST", "/v1/organizations/{org}/problems/{problem}/revisions", EMPTY_PACKAGE,
    ),
    ("GET", COMPILATION): ("GET", "/v1/organizations/{org}/problems/{problem}/revisions/1/compilation", {}),
    ("POST", f"{LANGUAGE}/validate"): ("POST", f"{LANGUAGE}/validate", EMPTY_YAML),
    ("POST", f"{LANGUAGE}/parse"): ("POST", f"{LANGUAGE}/parse", EMPTY_YAML),
    ("POST", f"{LANGUAGE}/serialise"): ("POST", f"{LANGUAGE}/serialise", EMPTY_JSON),
    ("POST", f"{LANGUAGE}/diff"): ("POST", f"{LANGUAGE}/diff", EMPTY_JSON),
    # Counted before the composition is looked up: the first is a 404, the second a 429.
    ("POST", f"{VERSIONS}"): ("POST", "/v1/organizations/{org}/compositions/none/versions", EMPTY_YAML),
    ("POST", f"{VERSIONS}/check"): ("POST", "/v1/organizations/{org}/compositions/none/versions/check", EMPTY_YAML),
    ("POST", FORK): ("POST", "/v1/organizations/{org}/compositions/none/fork", EMPTY_JSON),
    ("POST", REEVALUATE): ("POST", "/v1/organizations/{org}/compositions/none/versions/1/evaluations", {}),
    ("POST", EVALUATE): ("POST", "/v1/organizations/{org}/compositions/none/evaluate", EMPTY_JSON),
    ("GET", NEIGHBORHOOD): ("GET", "/v1/organizations/{org}/compositions/none/neighborhood", {}),
    ("POST", DERIVE): ("POST", "/v1/organizations/{org}/compositions/none/derive", EMPTY_JSON),
}

#: The stateless language services: open to anybody, and answering ``application/problem+json``.
LANGUAGE_ROUTES = {route for route in REQUESTS if route[1].startswith(LANGUAGE)}
BIM_ROUTES = {("POST", PROBE)} | LANGUAGE_ROUTES


@pytest.fixture
def budgets(monkeypatch):
    """Switch the budget on; the suite runs with it off, in this test's own memory (conftest)."""

    def apply(
        *, compile: int = 1000, read: int = 1000, evaluate: int = 1000, multiplier: int = 1, window: int = 3600,
    ) -> None:
        settings = get_settings()
        monkeypatch.setattr(settings, "work_rate_limit_compile_requests", compile)
        monkeypatch.setattr(settings, "work_rate_limit_read_requests", read)
        monkeypatch.setattr(settings, "work_rate_limit_evaluate_requests", evaluate)
        monkeypatch.setattr(settings, "work_rate_limit_signed_in_multiplier", multiplier)
        monkeypatch.setattr(settings, "work_rate_limit_window_s", window)

    return apply


def client_at(address: str) -> AsyncClient:
    return AsyncClient(transport=ASGITransport(app=app, client=(address, 51000)), base_url="http://gateway")


def assert_refused(response, retry_within: int = 3600) -> None:
    assert response.status_code == 429, response.text
    assert 1 <= int(response.headers["Retry-After"]) <= retry_within
    assert response.json()["code"] == "rate_limit_exceeded"
    assert response.json()["title"] == "rate_limit_exceeded"
    assert response.json()["status"] == 429


async def post(client, path: str = PROBE, **extra):
    request = EMPTY_PACKAGE
    headers = {**request.get("headers", {}), **extra.pop("headers", {})}
    return await client.post(path, **{**request, **extra, "headers": headers})


async def lint(client, headers: dict | None = None):
    """One empty document to the editor's lint: counted, then answered 200 ``valid: false``."""
    return await client.post(
        f"{LANGUAGE}/validate", content=b"", headers={**EMPTY_YAML["headers"], **(headers or {})},
    )


@pytest.fixture
async def member(api_client, registration, db_session, gate):  # noqa: F811
    """A signed-in member with a problem of their organization, for the organization's counted routes."""
    _, headers = await make_account(api_client, registration, db_session, gate)
    uploaded = await upload_problem(api_client, headers)
    return headers, {"org": uploaded["org"], "problem": uploaded["problem"]["slug"]}


async def send(client, route, member):
    method, path, body = REQUESTS[route]
    headers, names = member
    if route in BIM_ROUTES:
        headers = {}
    return await client.request(
        method, path.format(**names),
        content=body.get("content"), headers={**body.get("headers", {}), **headers},
    )


# ------------------------------------------------------------------- which routes

def routes() -> set[tuple[str, str]]:
    found = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute):
                found.update((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
    return found


def test_every_counted_route_exists_with_its_method():
    assert set(WORK_ROUTES) <= routes()


def test_a_route_added_under_the_compiling_prefixes_has_to_be_classified():
    """Deny-by-default, as for public reads: a new route fails here until somebody decides."""
    found = {
        (method, path) for method, path in routes()
        if (method == "POST" and path.startswith((
            "/v1/compositions/", "/v1/bim/", "/v1/organizations/{org}/problems",
            "/v1/organizations/{org}/compositions/{composition}/",
        )))
        or path.endswith("/compilation")
        or (path.startswith("/v1/organizations/{org}/compositions/{composition}/") and path.endswith("/neighborhood"))
    }
    assert found == set(WORK_ROUTES)


def test_every_counted_route_is_exercised_below():
    """So an entry added to the table cannot go without proof that its route is limited."""
    assert set(REQUESTS) == set(WORK_ROUTES)


def test_compile_read_and_evaluate_are_the_classes_the_policy_states():
    assert set(WORK_ROUTES.values()) == {"compile", "read", "evaluate"}
    assert {route for route, work_class in WORK_ROUTES.items() if work_class == "read"} == LANGUAGE_ROUTES
    assert {route for route, work_class in WORK_ROUTES.items() if work_class == "evaluate"} == {
        ("POST", VERSIONS), ("POST", f"{VERSIONS}/check"), ("POST", FORK),
        ("POST", REEVALUATE), ("POST", EVALUATE), ("GET", NEIGHBORHOOD), ("POST", DERIVE),
    }


@pytest.mark.parametrize("route", sorted(REQUESTS))
async def test_every_route_is_limited_and_answers_a_coded_problem(api_client, budgets, member, route):
    budgets(compile=1, read=1, evaluate=1)

    first = await send(api_client, route, member)
    second = await send(api_client, route, member)

    assert first.status_code != 429, first.text
    assert_refused(second)
    body = second.json()
    media_type = second.headers["content-type"].split(";")[0]
    if route in BIM_ROUTES:
        assert media_type == "application/problem+json"
        assert body["retry_after_seconds"] == int(second.headers["Retry-After"])
    else:
        assert media_type == "application/json"
        assert body["detail"]["code"] == "rate_limit_exceeded"
        assert body["detail"]["retry_after_seconds"] == int(second.headers["Retry-After"])


# ------------------------------------------------------------------- the budget

async def test_a_malformed_request_is_counted_all_the_same(api_client, budgets):
    budgets(compile=3)

    statuses = [(await post(api_client)).status_code for _ in range(3)]

    assert statuses == [422, 422, 422]
    assert_refused(await post(api_client))


async def test_a_refused_request_does_no_work(api_client, budgets, monkeypatch):
    budgets(compile=1)
    await post(api_client)

    async def boom(*_: object, **__: object):
        raise AssertionError("a request past its budget reached the package reader")

    monkeypatch.setattr(bim_routes, "read_package", boom)

    assert_refused(await post(api_client))


async def test_a_budget_of_zero_switches_the_class_off(api_client, budgets):
    budgets(compile=0)

    statuses = {(await post(api_client)).status_code for _ in range(5)}

    assert statuses == {422}


async def test_the_refusal_says_what_ran_out(api_client, budgets):
    budgets(compile=1, window=90)
    await post(api_client)

    body = (await post(api_client)).json()

    assert body["limit"] == 1
    assert body["window_seconds"] == 90
    assert body["work_class"] == "compile"


async def test_the_read_class_has_its_own_budget(api_client, budgets):
    budgets(compile=1, read=2)

    statuses = [(await lint(api_client)).status_code for _ in range(3)]

    assert statuses == [200, 200, 429]
    assert (await post(api_client)).status_code == 422  # the compile budget is untouched
    refused = await lint(api_client)
    assert refused.json()["work_class"] == "read"
    assert refused.json()["limit"] == 2


async def test_the_evaluate_class_has_its_own_budget(api_client, budgets, member):
    budgets(compile=1, read=1, evaluate=2)
    headers, names = member
    path = f"/v1/organizations/{names['org']}/compositions/none/versions/check"

    statuses = [
        (await api_client.post(path, content=b"", headers={**EMPTY_YAML["headers"], **headers})).status_code
        for _ in range(3)
    ]

    assert statuses == [404, 404, 429]
    assert (await lint(api_client)).status_code == 200  # the read budget is untouched


async def test_a_signed_in_caller_gets_the_larger_read_budget(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(read=1, multiplier=3)
    _, headers = await make_account(api_client, registration, db_session, gate)

    signed_in = [(await lint(api_client, headers)).status_code for _ in range(4)]

    assert signed_in == [200, 200, 200, 429]


# ------------------------------------------------------------------- who is a client

async def test_a_second_address_has_its_own_budget(api_client, budgets):
    budgets(compile=1)
    await post(api_client, PROBE)

    assert_refused(await post(api_client, PROBE))
    async with client_at("203.0.113.9") as other:
        assert (await post(other, PROBE)).status_code == 422


async def test_the_forwarded_header_does_not_choose_the_bucket(api_client, budgets):
    budgets(compile=2)

    statuses = [
        (await post(api_client, PROBE, headers={"X-Forwarded-For": f"198.51.100.{n}"})).status_code
        for n in range(3)
    ]

    assert statuses == [422, 422, 429]


async def test_an_ipv6_client_is_counted_by_its_slash_64(api_client, budgets):
    budgets(compile=1)

    async with client_at("2001:db8:1:2::1") as first, client_at("2001:db8:1:2:ffff::9") as sibling, \
            client_at("2001:db8:1:3::1") as elsewhere:
        assert (await post(first, PROBE)).status_code == 422
        assert_refused(await post(sibling, PROBE))
        assert (await post(elsewhere, PROBE)).status_code == 422


@pytest.mark.parametrize(
    "address,bucket",
    [
        ("203.0.113.9", "203.0.113.9"),
        ("2001:db8:1:2:3:4:5:6", "2001:db8:1:2::/64"),
        ("::ffff:203.0.113.9", "203.0.113.9"),
        ("unknown", "unknown"),
    ],
)
def test_client_bucket(address, bucket):
    assert client_bucket(address) == bucket


async def test_a_signed_in_caller_gets_the_larger_budget(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(compile=2, multiplier=3)
    _, headers = await make_account(api_client, registration, db_session, gate)

    anonymous = [(await post(api_client, PROBE)).status_code for _ in range(3)]
    signed_in = [(await post(api_client, PROBE, headers=headers)).status_code for _ in range(7)]

    assert anonymous == [422, 422, 429]
    assert signed_in == [422] * 6 + [429]


async def test_an_account_is_counted_wherever_it_calls_from(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(compile=1, multiplier=2)
    _, headers = await make_account(api_client, registration, db_session, gate)

    await post(api_client, PROBE, headers=headers)
    async with client_at("203.0.113.9") as elsewhere:
        await post(elsewhere, PROBE, headers=headers)
        assert_refused(await post(elsewhere, PROBE, headers=headers))


async def test_two_accounts_do_not_share_a_budget(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(compile=1)
    _, first = await make_account(api_client, registration, db_session, gate)
    _, second = await make_account(api_client, registration, db_session, gate)

    await post(api_client, PROBE, headers=first)

    assert_refused(await post(api_client, PROBE, headers=first))
    assert (await post(api_client, PROBE, headers=second)).status_code == 422


async def test_a_key_and_its_account_are_one_caller(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(compile=2)
    _, headers = await make_account(api_client, registration, db_session, gate)
    key = await make_key(api_client, headers, ["account:read"])

    await post(api_client, PROBE, headers=headers)
    await post(api_client, PROBE, headers=key)

    assert_refused(await post(api_client, PROBE, headers=key))


async def test_a_credential_that_names_nobody_is_an_anonymous_caller(api_client, budgets):
    budgets(compile=1)
    await post(api_client, PROBE)

    refused = await post(api_client, PROBE, headers={"Authorization": "Bearer not-a-token"})

    assert_refused(refused)


async def test_a_key_that_may_not_read_problems_is_counted_and_then_refused(
    api_client, registration, db_session, budgets, gate,  # noqa: F811
):
    """Validation writes nothing, so it needs ``problems:read``; the request is counted all the same."""
    budgets(compile=1)
    _, headers = await make_account(api_client, registration, db_session, gate)
    key = await make_key(api_client, headers, ["account:read"])

    response = await post(api_client, PROBE, headers=key)

    assert response.status_code == 403, response.text
    assert_refused(await post(api_client, PROBE, headers=key))


# ------------------------------------------------------------------- the store

async def test_the_counters_live_in_the_shared_backend(api_client, budgets):
    budgets(compile=2, window=120)
    redis = FakeRedis()
    set_work_limiter(WorkRateLimiter(primary=RedisBackend(redis)))

    for _ in range(3):
        await post(api_client, PROBE)
    refused = await post(api_client, PROBE)

    assert_refused(refused, retry_within=120)
    assert redis.counts == {"workrl:compile:ip:127.0.0.1": 4}
    assert redis.expirations == [("workrl:compile:ip:127.0.0.1", 120)]


async def test_a_signed_in_counter_is_named_after_the_account(api_client, registration, db_session, budgets, gate):  # noqa: F811
    budgets(compile=2)
    redis = FakeRedis()
    set_work_limiter(WorkRateLimiter(primary=RedisBackend(redis)))
    account, headers = await make_account(api_client, registration, db_session, gate)

    await post(api_client, PROBE, headers=headers)

    assert f"workrl:compile:user:{account['id']}" in redis.counts


async def test_redis_failure_degrades_to_process_counters_and_never_switches_the_limit_off(
    api_client, budgets, caplog, monkeypatch,
):
    # Running alembic in-process (applies ``fileConfig``) disables every logger that existed then.
    monkeypatch.setattr(ratelimit.logger, "disabled", False)
    budgets(compile=2)
    now = [1000.0]
    limiter = WorkRateLimiter(primary=DownBackend(), retry_after_failure_s=15.0, clock=lambda: now[0])
    set_work_limiter(limiter)

    with caplog.at_level(logging.WARNING, logger="openbinding_gateway.core.ratelimit"):
        statuses = [(await post(api_client, PROBE)).status_code for _ in range(3)]

    assert statuses == [422, 422, 429]  # still enforced, per process
    assert limiter.degradation.events == 1  # one failure, then Redis is left alone for 15 s
    assert limiter.degradation.last_error == "ConnectionError"
    assert any("work rate limiter" in record.getMessage() for record in caplog.records)

    now[0] += 16.0  # the retry window passed: Redis is tried (and degraded) again
    await post(api_client, PROBE)
    assert limiter.degradation.events == 2


async def test_a_redis_window_that_is_about_to_end_still_says_wait():
    redis = FakeRedis()
    redis.ttls["k"] = 0

    assert await RedisBackend(redis).hit("k", 60) == (1, 1)


def test_the_limiter_is_built_from_the_settings_once():
    set_work_limiter(None)
    try:
        assert get_work_limiter() is get_work_limiter()
        assert isinstance(get_work_limiter().primary, RedisBackend)
    finally:
        set_work_limiter(None)


# ------------------------------------------------------------------- the contract

@pytest.mark.parametrize("route", sorted(WORK_ROUTES))
def test_the_openapi_document_declares_the_refusal(route):
    method, path = route
    response = app.openapi()["paths"][path][method.lower()]["responses"]["429"]

    assert response["headers"]["Retry-After"]["schema"]["type"] == "integer"
    expected = "application/problem+json" if route in BIM_ROUTES else "application/json"
    assert list(response["content"]) == [expected]
    assert WORK_ROUTES[route] in response["description"]


# ------------------------------------------------------------------- the reads visitors may make

COMPOSITION = "/v1/organizations/{org}/compositions/{composition}"
#: A visitor's request for every read of public compositions, and what it answers once counted: the reads of
#: one composition 404 (nothing is there), the list of every organization's 200 (empty).
ANONYMOUS_REQUESTS = {
    ("GET", "/v1/compositions"): ("/v1/compositions", 200),
    ("GET", "/v1/organizations/public"): ("/v1/organizations/public", 200),
    ("GET", "/v1/organizations/{org}/compositions"): ("/v1/organizations/no-such-org/compositions", 404),
    ("GET", "/v1/organizations/{org}/profile"): ("/v1/organizations/no-such-org/profile", 404),
    ("GET", "/v1/invitations/{code}/preview"): ("/v1/invitations/0000000000000000/preview", 404),
    ("GET", COMPOSITION): ("/v1/organizations/{org}/compositions/none", 404),
    ("GET", f"{COMPOSITION}/versions"): ("/v1/organizations/{org}/compositions/none/versions", 404),
    ("GET", f"{COMPOSITION}/versions/{{version}}"): ("/v1/organizations/{org}/compositions/none/versions/1", 404),
    ("GET", f"{COMPOSITION}/versions/{{version}}/content"): (
        "/v1/organizations/{org}/compositions/none/versions/1/content", 404,
    ),
    ("GET", f"{COMPOSITION}/diff"): ("/v1/organizations/{org}/compositions/none/diff", 404),
}


def depends_on(dependant, call) -> bool:
    return any(item.call is call or depends_on(item, call) for item in dependant.dependencies)


def test_the_anonymous_reads_are_the_routes_that_take_a_reader():
    found = set()
    for included in app.routes:
        original = getattr(included, "original_router", None)
        for route in original.routes if original is not None else [included]:
            if isinstance(route, APIRoute) and depends_on(route.dependant, get_reader):
                found.update((method, route.path) for method in route.methods - {"HEAD", "OPTIONS"})
    assert found == set(ANONYMOUS_READ_ROUTES)
    assert set(ANONYMOUS_REQUESTS) == set(ANONYMOUS_READ_ROUTES)
    # The table of costly work is a separate one: these reads are charged to visitors only.
    assert not set(ANONYMOUS_READ_ROUTES) & set(WORK_ROUTES)


@pytest.mark.parametrize("route", sorted(ANONYMOUS_REQUESTS))
async def test_every_anonymous_read_is_limited_in_the_platform_envelope(api_client, budgets, member, route):
    budgets(read=1)
    template, answered = ANONYMOUS_REQUESTS[route]
    path = template.format(org=member[1]["org"])

    first = await api_client.get(path)
    second = await api_client.get(path)
    signed_in = [(await api_client.get(path, headers=member[0])).status_code for _ in range(3)]

    assert first.status_code == answered, first.text
    assert_refused(second)
    assert second.headers["content-type"].split(";")[0] == "application/json"
    assert second.json()["detail"]["code"] == "rate_limit_exceeded"
    assert second.json()["detail"]["work_class"] == "read"
    # A member is never charged for reading.
    assert signed_in == [answered] * 3


@pytest.mark.parametrize("route", sorted(ANONYMOUS_READ_ROUTES))
def test_the_openapi_document_declares_the_anonymous_refusal(route):
    method, path = route
    operation = app.openapi()["paths"][path][method.lower()]
    response = operation["responses"]["429"]

    assert response["headers"]["Retry-After"]["schema"]["type"] == "integer"
    assert list(response["content"]) == ["application/json"]
    assert "`read`" in response["description"]
    # The credential is optional there.
    assert {} in operation["security"]
