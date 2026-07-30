"""Turning "solve this" into an HTTP request to a particular engine.

The router used to build engine requests itself: ``POST {service_url}/solve``
and ``GET {service_url}/jobs/{id}``, hardcoded. That is exactly right for an
engine that ships with the gateway, because those two paths *are* the contract
in ``schemas/engine-contract.openapi.yaml``. It is exactly wrong for an engine
that already existed before it heard of us and answers at ``/v1/optimize``.

So the two lines become a seam. ``BuiltinTransport`` reproduces what the router
did, unchanged; ``FederatedTransport`` reads the third party's own OpenAPI
document and their manifest's operation mapping. Everything the router does
around the request - retries, sync-versus-async detection, canonicalization,
feasibility - is untouched by which one it holds.

The federated side also carries the safety the builtin side does not need,
because the builtin side's URL comes from the deployment's own environment and
this one's comes from a stranger:

* the destination is re-checked immediately before every request, and the
  request is sent to the **address that was checked** rather than re-resolving
  the name (see ``ssrf``);
* redirects are refused, because a 302 is a second URL that nothing checked;
* the response is capped, so an engine cannot answer with a stream that fills
  memory;
* the credential is decrypted here, used, and never returned anywhere.
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from typing import Any, Dict, Optional, Tuple

import httpx

from ..models.manifest import AuthType, EngineManifest, resolve_pointer
from . import ssrf

#: How much of an engine's answer to accept. Generous - a Pareto front over a
#: large instance is genuinely big - but finite, because the alternative is
#: letting a third party decide how much of our memory to use.
MAX_RESPONSE_BYTES = 64 * 1024 * 1024

#: The HTTP methods an OpenAPI document can hang an operation on.
_METHODS = ("get", "put", "post", "delete", "options", "head", "patch", "trace")


class TransportError(RuntimeError):
    """The request could not be built or sent as described."""


class EngineTransport(ABC):
    """How to reach one engine's two operations."""

    @abstractmethod
    async def solve(
        self, client: httpx.AsyncClient, payload: Dict[str, Any], *, timeout: float
    ) -> httpx.Response:
        """Submit an instance."""

    @abstractmethod
    async def poll(
        self, client: httpx.AsyncClient, engine_job_id: str, *, timeout: float
    ) -> httpx.Response:
        """Ask after a job this engine is already running."""

    @property
    def is_federated(self) -> bool:
        return False


class BuiltinTransport(EngineTransport):
    """The two requests the router has always made.

    Deliberately verbatim. This class existing is the whole change for an
    in-tree engine, and if it differed from the previous code in any respect
    the seam would have cost something instead of costing nothing.
    """

    def __init__(self, base_url: str) -> None:
        self.base_url = base_url.rstrip("/")

    async def solve(
        self, client: httpx.AsyncClient, payload: Dict[str, Any], *, timeout: float
    ) -> httpx.Response:
        return await client.post(f"{self.base_url}/solve", json=payload, timeout=timeout)

    async def poll(
        self, client: httpx.AsyncClient, engine_job_id: str, *, timeout: float
    ) -> httpx.Response:
        return await client.get(f"{self.base_url}/jobs/{engine_job_id}", timeout=timeout)


def find_operation(document: Dict[str, Any], operation_id: str) -> Tuple[str, str]:
    """``(method, path)`` for an ``operationId``, or raise saying it is absent.

    Operations are located by id rather than by path because a path is a
    layout: a third party reorganising their routes should not silently break a
    registration, and an id that has disappeared should say so plainly.
    """
    paths = document.get("paths")
    if not isinstance(paths, dict):
        raise TransportError("The OpenAPI document declares no paths.")

    for path, item in paths.items():
        if not isinstance(item, dict):
            continue
        for method in _METHODS:
            operation = item.get(method)
            if isinstance(operation, dict) and operation.get("operationId") == operation_id:
                return method.upper(), path

    raise TransportError(
        f"The OpenAPI document has no operation with id {operation_id!r}."
    )


def _servers_base_url(document: Dict[str, Any]) -> Optional[str]:
    servers = document.get("servers")
    if isinstance(servers, list):
        for server in servers:
            if isinstance(server, dict) and isinstance(server.get("url"), str):
                return server["url"]
    return None


def fill_path(path: str, value: str) -> str:
    """Substitute a templated path parameter with the job identifier.

    A polling path is ``/jobs/{id}`` or ``/optimize/{jobId}`` or
    ``/runs/{run_id}/status``: one variable, whatever it is called. More than
    one is refused rather than guessed at - picking the wrong one produces a
    request that looks right and asks about the wrong thing.
    """
    import re

    names = re.findall(r"\{([^}]+)\}", path)
    if not names:
        return path
    if len(set(names)) > 1:
        raise TransportError(
            f"The polling path {path!r} has several parameters ({', '.join(sorted(set(names)))}); "
            f"the gateway only knows the job identifier, so it cannot fill them all."
        )
    return re.sub(r"\{[^}]+\}", value, path)


def set_pointer(document: Dict[str, Any], pointer: str, value: Any) -> Dict[str, Any]:
    """Put ``value`` at ``pointer``, creating the objects on the way.

    The empty pointer means the value *is* the body, which is how an engine
    that takes a bare instance is described.
    """
    if pointer == "":
        return value if isinstance(value, dict) else {"": value}

    tokens = [
        token.replace("~1", "/").replace("~0", "~") for token in pointer.lstrip("/").split("/")
    ]
    current = document
    for token in tokens[:-1]:
        nxt = current.get(token)
        if not isinstance(nxt, dict):
            nxt = {}
            current[token] = nxt
        current = nxt
    current[tokens[-1]] = value
    return document


class FederatedTransport(EngineTransport):
    """Somebody else's API, reached as described by their manifest."""

    def __init__(
        self,
        manifest: EngineManifest,
        openapi_document: Dict[str, Any],
        *,
        credential: Optional[str] = None,
        require_https: bool = True,
        max_response_bytes: int = MAX_RESPONSE_BYTES,
    ) -> None:
        if manifest.transport is None:
            raise TransportError(
                f"{manifest.engine_id} declares no transport, so it is not a federated engine."
            )
        self.manifest = manifest
        self.spec = manifest.transport
        self.document = openapi_document or {}
        self.credential = credential
        self.require_https = require_https
        self.max_response_bytes = max_response_bytes

    @property
    def is_federated(self) -> bool:
        return True

    # -- Building the request ------------------------------------------

    def base_url(self) -> str:
        declared = self.spec.base_url or _servers_base_url(self.document)
        if not declared:
            raise TransportError(
                "Neither the manifest nor the OpenAPI document says where this engine "
                "is: set transport.base_url."
            )
        return declared.rstrip("/")

    def _auth_headers(self) -> Dict[str, str]:
        auth = self.spec.auth
        if auth.type is AuthType.NONE:
            return {}
        if not self.credential:
            raise TransportError(
                f"This engine authenticates with {auth.type.value} but no credential is "
                f"stored for it. Its owner has to enter one."
            )
        if auth.type is AuthType.BEARER:
            return {"Authorization": f"Bearer {self.credential}"}
        return {auth.header or "X-API-Key": self.credential}

    def build_solve_body(self, payload: Dict[str, Any]) -> Dict[str, Any]:
        """Their request body, from ours.

        ``payload`` is what the plugin produced - ``{"instance": ..., "options":
        ...}`` - and the mapping says where each half belongs in their shape.
        """
        mapping = self.spec.request_mapping
        body: Dict[str, Any] = {}
        body = set_pointer(body, mapping.instance, payload.get("instance"))
        if mapping.options is not None and payload.get("options") is not None:
            body = set_pointer(body, mapping.options, payload.get("options"))
        return body

    # -- Sending it ----------------------------------------------------

    async def _send(
        self,
        client: httpx.AsyncClient,
        method: str,
        url: str,
        *,
        timeout: float,
        json_body: Optional[Dict[str, Any]] = None,
    ) -> httpx.Response:
        # Checked here rather than at registration alone: an engine's DNS can
        # change between the two, and this is the moment that matters.
        target = ssrf.resolve(url, require_https=self.require_https)

        pinned = httpx.URL(url).copy_with(host=target.address)
        headers = {
            **self._auth_headers(),
            # The name, so virtual hosting and certificate verification still
            # work while the connection goes to the address that was checked.
            "Host": target.host,
            "Accept": "application/json",
        }

        request = client.build_request(
            method,
            pinned,
            json=json_body,
            headers=headers,
            timeout=timeout,
            # TLS is negotiated for the name, not for the address it resolved
            # to, so the certificate is still verified against the hostname.
            extensions={"sni_hostname": target.host},
        )

        # follow_redirects stays off: a redirect is a second destination, and
        # nothing has checked it.
        response = await client.send(request, stream=True, follow_redirects=False)
        try:
            body = bytearray()
            async for chunk in response.aiter_bytes():
                body.extend(chunk)
                if len(body) > self.max_response_bytes:
                    raise TransportError(
                        f"{self.manifest.engine_id} answered with more than "
                        f"{self.max_response_bytes} bytes."
                    )
        finally:
            await response.aclose()

        # Rebuilt so the caller holds an ordinary, fully-read response. Only
        # the status and the body cross this line: a third party's response
        # headers are theirs and are not echoed onward.
        return httpx.Response(
            status_code=response.status_code,
            content=bytes(body),
            headers={"content-type": response.headers.get("content-type", "application/json")},
            request=request,
        )

    async def solve(
        self, client: httpx.AsyncClient, payload: Dict[str, Any], *, timeout: float
    ) -> httpx.Response:
        method, path = find_operation(self.document, self.spec.operations.solve.operation_id)
        return await self._send(
            client,
            method,
            f"{self.base_url()}{path}",
            timeout=timeout,
            json_body=self.build_solve_body(payload),
        )

    async def poll(
        self, client: httpx.AsyncClient, engine_job_id: str, *, timeout: float
    ) -> httpx.Response:
        if self.spec.operations.job is None:
            raise TransportError(
                f"{self.manifest.engine_id} answers synchronously; there is no job to poll."
            )
        method, path = find_operation(self.document, self.spec.operations.job.operation_id)
        return await self._send(
            client,
            method,
            f"{self.base_url()}{fill_path(path, engine_job_id)}",
            timeout=timeout,
        )

    async def healthy(self, client: httpx.AsyncClient, *, timeout: float = 5.0) -> bool:
        """Whether the engine answers its health operation.

        An engine that declares none is reported healthy rather than unhealthy:
        it has not failed a check, it has declined to offer one, and the
        catalogue should not paint that as being down.
        """
        if self.spec.operations.health is None:
            return True
        try:
            method, path = find_operation(
                self.document, self.spec.operations.health.operation_id
            )
            response = await self._send(
                client, method, f"{self.base_url()}{path}", timeout=timeout
            )
            return response.status_code == 200
        except Exception:
            return False


def read_solutions(manifest: EngineManifest, body: Any) -> Any:
    """The list of solutions in a federated engine's response.

    Split out from the plugin because the transport's mapping knows where it
    is and the plugin only knows what to do with it.
    """
    if manifest.transport is None:
        return body
    return resolve_pointer(body, manifest.transport.response_mapping.solutions)
