from __future__ import annotations

from pathlib import Path
from typing import Any

import yaml


class FaaSPricing:
    def __init__(self, pricing_dir: str | Path):
        self.root = Path(pricing_dir)
        self.aws = self._load("aws/lambda_variables.yml")
        self.azure = self._load("azure/azure_functions_variables.yml")
        self.gcp = self._load("gcloud/google_cloud_functions_variables.yml")

    def _load(self, relative: str) -> dict[str, Any]:
        path = self.root / relative
        return yaml.safe_load(path.read_text(encoding="utf-8")) or {}

    @staticmethod
    def gb_seconds(invocations: float, duration_ms: float, memory_mb: float) -> float:
        return invocations * (duration_ms / 1000.0) * (memory_mb / 1024.0)

    def estimate(
        self,
        provider: str,
        region: str,
        *,
        invocations_per_month: float,
        avg_duration_ms: float,
        memory_mb: float,
        vcpu: float = 1.0,
    ) -> float:
        provider = provider.lower()
        if provider == "aws":
            return self.aws_lambda(region, invocations_per_month, avg_duration_ms, memory_mb)
        if provider == "azure":
            return self.azure_functions(region, invocations_per_month, avg_duration_ms, memory_mb)
        if provider == "gcp":
            return self.gcp_functions(region, invocations_per_month, avg_duration_ms, memory_mb, vcpu)
        raise ValueError(f"Unsupported FaaS provider: {provider}")

    def aws_lambda(self, region: str, invocations: float, duration_ms: float, memory_mb: float) -> float:
        prices = self.aws["pricesPerRegionAndArchitecture"][region]
        request = float(prices["lambdaRequest"])
        compute = float(prices["x86"]["firstGbSeconds"])
        return invocations * request + self.gb_seconds(invocations, duration_ms, memory_mb) * compute

    def azure_functions(self, region: str, invocations: float, duration_ms: float, memory_mb: float) -> float:
        prices = self.azure["consumptionPricesPerRegion"][region]
        request = float(prices["execution"])
        compute = float(prices["gbSecond"])
        return invocations * request + self.gb_seconds(invocations, duration_ms, memory_mb) * compute

    def gcp_functions(
        self,
        region: str,
        invocations: float,
        duration_ms: float,
        memory_mb: float,
        vcpu: float,
    ) -> float:
        prices = self.gcp["requestBasedPricesPerRegion"][region]
        request = float(prices["request"])
        vcpu_seconds = invocations * (duration_ms / 1000.0) * max(vcpu, 0.001)
        gib_seconds = self.gb_seconds(invocations, duration_ms, memory_mb)
        return (
            invocations * request
            + vcpu_seconds * float(prices["vcpuSecond"])
            + gib_seconds * float(prices["gibSecond"])
        )
