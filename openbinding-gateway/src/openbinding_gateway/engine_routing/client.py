"""HTTP client connecting to the dedicated meta-router-csp microservice.

Features a fast 500 ms timeout and graceful fallback on connection failure.
"""

from __future__ import annotations

import logging
from typing import Any

import httpx

logger = logging.getLogger(__name__)


class MetaRouterClient:
    """Client for dispatching meta-routing 1-task optimization to MiniZinc."""

    def __init__(self, timeout_s: float = 0.50) -> None:
        self.timeout_s = timeout_s

    async def solve_routing(self, base_url: str, request_data: dict[str, Any]) -> dict[str, Any] | None:
        url = f"{base_url.rstrip('/')}/route"
        try:
            async with httpx.AsyncClient(timeout=self.timeout_s) as client:
                response = await client.post(url, json=request_data)
                if response.status_code == 200:
                    return response.json()
                logger.warning(
                    "meta-router-csp responded with status %d: %s",
                    response.status_code,
                    response.text[:200],
                )
                return None
        except httpx.TimeoutException:
            logger.warning("meta-router-csp call timed out after %.2fs", self.timeout_s)
            return None
        except Exception as exc:
            logger.debug("meta-router-csp HTTP dispatch failed: %s", exc)
            return None


_DEFAULT_CLIENT = MetaRouterClient()


def get_meta_router_client() -> MetaRouterClient:
    return _DEFAULT_CLIENT
