"""Universidad de Sevilla CAS 2.0 validation and one-time state storage."""

from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from typing import Protocol

from lxml import etree
from redis.asyncio import Redis

from .core.settings import Settings


class OneTimeStore(Protocol):
    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None: ...
    async def pop(self, namespace: str, key: str) -> dict | None: ...


@dataclass
class MemoryOneTimeStore:
    """Deterministic test/development store; production configuration uses Redis."""

    values: dict[tuple[str, str], tuple[dict, float]] = field(default_factory=dict)

    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None:
        self.values[(namespace, key)] = (dict(value), time.monotonic() + ttl)

    async def pop(self, namespace: str, key: str) -> dict | None:
        stored = self.values.pop((namespace, key), None)
        if stored is None:
            return None
        value, expires_at = stored
        return value if expires_at > time.monotonic() else None


class RedisOneTimeStore:
    def __init__(self, url: str) -> None:
        self.redis = Redis.from_url(url, decode_responses=True)

    @staticmethod
    def _key(namespace: str, key: str) -> str:
        return f"openbinding:{namespace}:{key}"

    async def put(self, namespace: str, key: str, value: dict, ttl: int) -> None:
        await self.redis.set(self._key(namespace, key), json.dumps(value), ex=ttl, nx=True)

    async def pop(self, namespace: str, key: str) -> dict | None:
        raw = await self.redis.getdel(self._key(namespace, key))
        return json.loads(raw) if raw else None

    async def aclose(self) -> None:
        await self.redis.aclose()


_store: OneTimeStore | None = None


def set_cas_store(store: OneTimeStore | None) -> None:
    global _store
    _store = store


def get_cas_store(settings: Settings) -> OneTimeStore:
    global _store
    if _store is None:
        _store = (
            MemoryOneTimeStore()
            if settings.cas_store_backend == "memory"
            else RedisOneTimeStore(settings.redis_url)
        )
    return _store


@dataclass(frozen=True)
class CasPrincipal:
    subject: str
    attributes: dict[str, str]


def parse_service_validate(xml: bytes) -> CasPrincipal:
    """Parse a bounded CAS response with DTDs, entities and network disabled."""

    if len(xml) > 256 * 1024 or b"<!DOCTYPE" in xml.upper() or b"<!ENTITY" in xml.upper():
        raise ValueError("Unsafe or oversized CAS validation response")
    parser = etree.XMLParser(
        resolve_entities=False, load_dtd=False, no_network=True,
        recover=False, remove_comments=True, huge_tree=False,
    )
    try:
        root = etree.fromstring(xml, parser=parser)
    except etree.XMLSyntaxError as exc:
        raise ValueError("Malformed CAS validation response") from exc
    success = next((node for node in root.iter() if etree.QName(node).localname == "authenticationSuccess"), None)
    if success is None:
        failure = next((node for node in root.iter() if etree.QName(node).localname == "authenticationFailure"), None)
        detail = "CAS refused the ticket" if failure is None else " ".join("".join(failure.itertext()).split())
        raise ValueError(detail)
    user = next((node for node in success.iter() if etree.QName(node).localname == "user"), None)
    subject = "" if user is None else " ".join("".join(user.itertext()).split())
    if not subject or len(subject) > 160:
        raise ValueError("CAS response has no valid UVUS subject")
    attributes: dict[str, str] = {}
    container = next((node for node in success.iter() if etree.QName(node).localname == "attributes"), None)
    if container is not None:
        for child in container:
            key = etree.QName(child).localname.casefold()
            value = " ".join("".join(child.itertext()).split())
            if key and value:
                attributes[key] = value[:1000]
    return CasPrincipal(subject=subject, attributes=attributes)
