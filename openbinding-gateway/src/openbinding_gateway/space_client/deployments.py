"""Administrative SPACE pricing deployment operations.

Contract evaluation remains in :mod:`space_client.space`; this small client is
only for the pricing lifecycle exposed by the administrator control room.
"""

from __future__ import annotations

from typing import Any
from urllib.parse import quote

import httpx

from ..core.settings import Settings
from .gate import PricingUnavailable, SERVICE_NAME


class SpaceDeploymentClient:
    def __init__(self, settings: Settings, transport: httpx.AsyncBaseTransport | None = None):
        if not settings.space_url or not settings.space_api_key:
            raise PricingUnavailable("SPACE_URL and SPACE_API_KEY are required.")
        self.settings = settings
        self._base = settings.space_url.rstrip("/") + "/api/v1"
        self._transport = transport

    async def _request(
        self,
        method: str,
        path: str,
        *,
        destructive: bool = False,
        allow_not_found: bool = False,
        **kwargs,
    ) -> httpx.Response | None:
        key = self.settings.space_destructive_api_key if destructive else self.settings.space_api_key
        if not key:
            raise PricingUnavailable(
                "SPACE_DESTRUCTIVE_API_KEY is required for archived-version deletion."
                if destructive
                else "SPACE_API_KEY is not configured."
            )
        try:
            async with httpx.AsyncClient(
                headers={"x-api-key": key},
                timeout=self.settings.space_timeout_ms / 1000,
                follow_redirects=False,
                transport=self._transport,
            ) as client:
                response = await client.request(method, f"{self._base}{path}", **kwargs)
        except httpx.HTTPError as exc:
            raise PricingUnavailable(f"SPACE is unavailable: {exc}") from exc
        if allow_not_found and response.status_code == 404:
            return None
        if response.status_code >= 400:
            try:
                message = str(response.json().get("error") or "")
            except (ValueError, AttributeError):
                message = ""
            raise PricingUnavailable(
                f"SPACE returned {response.status_code}" + (f": {message[:300]}" if message else ".")
            )
        return response

    @staticmethod
    def _json(response: httpx.Response | None) -> Any:
        if response is None or response.status_code == 204 or not response.content:
            return None
        return response.json()

    async def health(self) -> dict[str, Any]:
        response = await self._request("GET", f"/services/{SERVICE_NAME}", allow_not_found=True)
        return {"reachable": True, "service": self._json(response)}

    async def versions(self) -> dict[str, list[dict[str, Any]]]:
        result: dict[str, list[dict[str, Any]]] = {"active": [], "archived": []}
        for state in result:
            response = await self._request(
                "GET", f"/services/{SERVICE_NAME}/pricings?pricingStatus={state}", allow_not_found=True
            )
            value = self._json(response)
            if isinstance(value, list):
                result[state] = [item for item in value if isinstance(item, dict)]
        return result

    async def deploy(self, pricing_url: str) -> dict[str, Any]:
        service = await self._request("GET", f"/services/{SERVICE_NAME}", allow_not_found=True)
        path = "/services" if service is None else f"/services/{SERVICE_NAME}/pricings"
        response = await self._request("POST", path, json={"pricing": pricing_url})
        value = self._json(response)
        return value if isinstance(value, dict) else {}

    async def set_availability(
        self, version: str, availability: str, fallback: dict[str, Any] | None = None
    ) -> dict[str, Any]:
        if availability not in {"active", "archived"}:
            raise ValueError("availability must be active or archived")
        path = (
            f"/services/{SERVICE_NAME}/pricings/{quote(version, safe='')}"
            f"?availability={availability}"
        )
        response = await self._request("PUT", path, json=fallback or {})
        value = self._json(response)
        return value if isinstance(value, dict) else {}

    async def contract_count(self, version: str) -> int:
        """Count contracts pinned to one exact OpenBinding pricing version."""
        response = await self._request(
            "GET",
            "/contracts",
            params={"limit": 1},
            json={"filters": {"services": {SERVICE_NAME: [version]}}},
        )
        if response is None:
            return 0
        header = response.headers.get("x-total-count")
        if header is not None:
            try:
                return int(header)
            except ValueError:
                pass
        value = self._json(response)
        return len(value) if isinstance(value, list) else 0

    async def delete_archived(self, version: str) -> None:
        await self._request(
            "DELETE",
            f"/services/{SERVICE_NAME}/pricings/{quote(version, safe='')}",
            destructive=True,
        )
