"""The outbound HTTP policy (``core.outbound``): addresses, pinning, redirects, size, encoding and timeouts."""

from __future__ import annotations

import asyncio
import logging
import socket

import httpx
import pytest

from openbinding_gateway.core import outbound
from openbinding_gateway.core.outbound import OutboundError, OutboundPolicy


def _dns(monkeypatch: pytest.MonkeyPatch, *answers: list[str] | str) -> list[str]:
    """Script the resolver; successive lookups take successive answers (the last one repeats)."""
    asked: list[str] = []
    queue = [a if isinstance(a, list) else [a] for a in answers]

    def resolve(host, port, *args, **kwargs):
        asked.append(host)
        values = queue.pop(0) if len(queue) > 1 else queue[0]
        return [(socket.AF_INET6 if ":" in v else socket.AF_INET, socket.SOCK_STREAM, 6, "", (v, port)) for v in values]

    monkeypatch.setattr(socket, "getaddrinfo", resolve)
    return asked


@pytest.mark.parametrize("url", ["http://example.org/x", "ftp://example.org/x", "file:///etc/passwd"])
def test_only_https_is_accepted(url: str) -> None:
    with pytest.raises(OutboundError) as caught:
        outbound.validate_endpoint(url)
    assert caught.value.code == "outbound_scheme"


@pytest.mark.parametrize("url", ["https://user:pw@example.org/", "https://user@example.org/", "https://example.org/#frag"])
def test_userinfo_and_fragments_are_refused(url: str) -> None:
    with pytest.raises(OutboundError) as caught:
        outbound.validate_endpoint(url)
    assert caught.value.code == "outbound_userinfo"


@pytest.mark.parametrize(
    "address",
    [
        "127.0.0.1",
        "127.8.9.10",
        "10.1.2.3",
        "172.16.0.1",
        "172.31.255.255",
        "192.168.1.1",
        "169.254.169.254",
        "169.254.1.1",
        "100.64.0.1",
        "0.0.0.0",
        "0.1.2.3",
        "224.0.0.1",
        "240.0.0.1",
        "::1",
        "fc00::1",
        "fd12:3456::1",
        "fe80::1",
        "::ffff:127.0.0.1",
        "64:ff9b::a9fe:a9fe",
        "2002:7f00:1::",
        "::",
    ],
)
def test_every_non_global_range_is_refused(address: str) -> None:
    host = f"[{address}]" if ":" in address else address
    with pytest.raises(OutboundError) as caught:
        outbound.validate_endpoint(f"https://{host}/")
    assert caught.value.code == "outbound_address"


def test_a_global_address_is_accepted() -> None:
    assert outbound.validate_endpoint("https://93.184.216.34/") == ("93.184.216.34",)
    assert outbound.validate_endpoint("https://[2606:4700::1111]/") == ("2606:4700::1111",)


def test_an_answer_with_one_private_address_is_refused(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, ["93.184.216.34", "10.0.0.7"])
    with pytest.raises(OutboundError) as caught:
        outbound.validate_endpoint("https://pricing.example/")
    assert caught.value.code == "outbound_address"


def test_an_unresolvable_name_is_a_dns_error(monkeypatch: pytest.MonkeyPatch) -> None:
    def fail(*args, **kwargs):
        raise socket.gaierror("no such host")

    monkeypatch.setattr(socket, "getaddrinfo", fail)
    with pytest.raises(OutboundError) as caught:
        outbound.validate_endpoint("https://nowhere.example/")
    assert caught.value.code == "outbound_dns"


def test_internal_addresses_need_an_operator_endpoint(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "10.0.0.7")
    assert outbound.validate_endpoint("https://registry.internal/", allow_internal=True) == ("10.0.0.7",)
    with pytest.raises(OutboundError):
        outbound.validate_endpoint("https://registry.internal/")
    # The forbidden classes stay forbidden even for an operator.
    with pytest.raises(OutboundError):
        outbound.validate_endpoint("https://100.64.0.1/", allow_internal=True)


def test_internal_http_reaches_only_local_addresses() -> None:
    assert outbound.validate_endpoint("http://10.0.0.5:8080/", allow_internal_http=True) == ("10.0.0.5",)
    with pytest.raises(OutboundError):
        outbound.validate_endpoint("http://93.184.216.34/", allow_internal_http=True)


def test_mask_url_hides_the_query_and_userinfo() -> None:
    assert outbound.mask_url("https://u:p@host.example/a/b?key=secret") == "https://host.example/a/b?…"


# --- fetch ------------------------------------------------------------------------------------------------------


@pytest.mark.asyncio
async def test_fetch_pins_the_checked_address_with_host_and_sni(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _dns(monkeypatch, "93.184.216.34", "10.0.0.7")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, content=b"ok")

    answer = await outbound.fetch(
        "https://pricing.example/a.yml?x=1", policy=OutboundPolicy(), transport=httpx.MockTransport(handler)
    )
    assert answer.status == 200 and answer.body == b"ok"
    # Resolved once: a second (rebinding) answer is never asked for, the first one is pinned.
    assert asked == ["pricing.example"]
    request = seen[0]
    assert request.url.host == "93.184.216.34"
    assert request.url.query == b"x=1"
    assert request.headers["host"] == "pricing.example"
    assert request.extensions["sni_hostname"] == "pricing.example"
    assert request.headers["accept-encoding"] == "identity"


@pytest.mark.asyncio
async def test_fetch_follows_https_redirects_revalidated_without_credentials(monkeypatch: pytest.MonkeyPatch) -> None:
    asked = _dns(monkeypatch, "93.184.216.34", "93.184.216.35")
    seen: list[httpx.Request] = []

    def handler(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        if len(seen) == 1:
            return httpx.Response(302, headers={"location": "https://cdn.example/b.yml"})
        return httpx.Response(200, content=b"pricing")

    answer = await outbound.fetch(
        "https://pricing.example/a.yml",
        policy=OutboundPolicy(max_redirects=3),
        headers={"x-api-key": "secret", "Authorization": "Bearer t", "Cookie": "c=1", "Accept": "x"},
        transport=httpx.MockTransport(handler),
    )
    assert answer.body == b"pricing" and answer.final_url == "https://cdn.example/b.yml"
    assert asked == ["pricing.example", "cdn.example"]
    assert seen[0].headers["x-api-key"] == "secret"
    second = seen[1]
    assert second.url.host == "93.184.216.35" and second.headers["host"] == "cdn.example"
    assert "x-api-key" not in second.headers and "authorization" not in second.headers
    assert "cookie" not in second.headers and second.headers["accept"] == "x"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("location", "code"),
    [("http://cdn.example/b.yml", "outbound_redirect"), ("https://internal.example/b.yml", "outbound_address")],
)
async def test_fetch_refuses_a_redirect_to_http_or_a_private_address(
    monkeypatch: pytest.MonkeyPatch, location: str, code: str
) -> None:
    _dns(monkeypatch, "93.184.216.34", "10.0.0.9")

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(302, headers={"location": location})

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch(
            "https://pricing.example/a.yml", policy=OutboundPolicy(max_redirects=3), transport=httpx.MockTransport(handler)
        )
    assert caught.value.code == code


@pytest.mark.asyncio
async def test_fetch_refuses_more_redirects_than_the_policy_allows(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")
    hops = []

    def handler(request: httpx.Request) -> httpx.Response:
        hops.append(request)
        return httpx.Response(302, headers={"location": f"/next/{len(hops)}"})

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch(
            "https://pricing.example/a", policy=OutboundPolicy(max_redirects=3), transport=httpx.MockTransport(handler)
        )
    assert caught.value.code == "outbound_redirect"
    assert len(hops) == 4
    with pytest.raises(OutboundError) as none_allowed:
        await outbound.fetch("https://pricing.example/a", policy=OutboundPolicy(), transport=httpx.MockTransport(handler))
    assert none_allowed.value.code == "outbound_redirect"


@pytest.mark.asyncio
async def test_a_declared_length_over_the_cap_is_refused_before_reading(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")

    class Exploding(httpx.AsyncByteStream):
        async def __aiter__(self):
            raise AssertionError("the body must not be read")
            yield b""  # pragma: no cover

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-length": "2048"}, stream=Exploding())

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch(
            "https://pricing.example/a", policy=OutboundPolicy(max_bytes=1024), transport=httpx.MockTransport(handler)
        )
    assert caught.value.code == "outbound_too_large"


@pytest.mark.asyncio
async def test_a_chunked_body_is_cut_at_the_cap(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")
    sent = []

    class Endless(httpx.AsyncByteStream):
        async def __aiter__(self):
            for _ in range(10_000):
                sent.append(1)
                yield b"x" * 256

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, stream=Endless())

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch(
            "https://pricing.example/a", policy=OutboundPolicy(max_bytes=1024), transport=httpx.MockTransport(handler)
        )
    assert caught.value.code == "outbound_too_large"
    assert len(sent) <= 6


@pytest.mark.asyncio
async def test_an_encoded_answer_is_refused_without_being_decoded(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")
    import gzip

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, headers={"content-encoding": "gzip"}, content=gzip.compress(b"a" * 100_000))

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch("https://pricing.example/a", policy=OutboundPolicy(), transport=httpx.MockTransport(handler))
    assert caught.value.code == "outbound_status"


@pytest.mark.asyncio
@pytest.mark.parametrize(
    ("error", "code"),
    [
        (httpx.ConnectTimeout("slow"), "outbound_timeout"),
        (httpx.ReadTimeout("slow"), "outbound_timeout"),
        (httpx.ConnectError("refused"), "outbound_connect"),
    ],
)
async def test_transport_failures_have_their_codes(monkeypatch: pytest.MonkeyPatch, error: Exception, code: str) -> None:
    _dns(monkeypatch, "93.184.216.34")

    def handler(request: httpx.Request) -> httpx.Response:
        raise error

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch("https://pricing.example/a", policy=OutboundPolicy(), transport=httpx.MockTransport(handler))
    assert caught.value.code == code


@pytest.mark.asyncio
async def test_the_total_timeout_bounds_a_slow_answer(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")

    async def handler(request: httpx.Request) -> httpx.Response:
        await asyncio.sleep(5)
        return httpx.Response(200)

    with pytest.raises(OutboundError) as caught:
        await outbound.fetch(
            "https://pricing.example/a", policy=OutboundPolicy(total_timeout_s=0.1), transport=httpx.MockTransport(handler)
        )
    assert caught.value.code == "outbound_timeout"


@pytest.mark.asyncio
async def test_the_proxy_environment_is_ignored(monkeypatch: pytest.MonkeyPatch) -> None:
    _dns(monkeypatch, "93.184.216.34")
    monkeypatch.setenv("HTTPS_PROXY", "http://proxy.invalid:3128")
    built: list[dict] = []
    real = httpx.AsyncClient

    def spy(*args, **kwargs):
        built.append(kwargs)
        return real(*args, **kwargs)

    monkeypatch.setattr(outbound.httpx, "AsyncClient", spy)
    answer = await outbound.fetch(
        "https://pricing.example/a",
        policy=OutboundPolicy(),
        transport=httpx.MockTransport(lambda request: httpx.Response(204)),
    )
    assert answer.status == 204
    assert built and all(kwargs["trust_env"] is False and kwargs["follow_redirects"] is False for kwargs in built)


@pytest.mark.asyncio
async def test_the_log_line_masks_the_query_string(monkeypatch: pytest.MonkeyPatch, caplog) -> None:
    _dns(monkeypatch, "93.184.216.34")

    def handler(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("refused")

    with caplog.at_level(logging.INFO, logger="openbinding_gateway.core.outbound"):
        with pytest.raises(OutboundError):
            await outbound.fetch(
                "https://pricing.example/a?token=s3cret", policy=OutboundPolicy(), transport=httpx.MockTransport(handler)
            )
    text = "\n".join(record.getMessage() for record in caplog.records)
    assert "pricing.example/a?…" in text
    assert "s3cret" not in text
