#!/usr/bin/env python3
"""
Generate Pricing2Yaml variables for Google Cloud Functions priced as modern Cloud Run functions.

Output objects:
  - requestBasedPricesPerRegion
  - minimumInstancesPricesPerRegion
  - instanceBasedPricesPerRegion
  - gpuPricesPerRegionAndType

This script uses the Google Cloud Billing Pricing API v2beta. It does not invent
prices: incomplete maps are omitted and reported with diagnostics.
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
from collections import OrderedDict, defaultdict
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote
from urllib.request import urlopen

import yaml

from dotenv import load_dotenv

load_dotenv()

PRICING_API_BASE = "https://cloudbilling.googleapis.com/v2beta"
REFERENCE_YAML = Path("google_cloud_functions_variables.yml")
SERVICE_DISPLAY_NAMES = ("Cloud Run", "Cloud Run Functions", "Cloud Functions")

REQUEST_KEYS = (
    "request", "requestCommittedUseDiscount1Year", "requestCommittedUseDiscount3Year",
    "vcpuSecond", "vcpuCommittedUseDiscount1Year", "vcpuCommittedUseDiscount3Year",
    "gibSecond", "gibCommittedUseDiscount1Year", "gibCommittedUseDiscount3Year",
)
MINIMUM_KEYS = REQUEST_KEYS + (
    "idleVcpuSecond", "idleVcpuCommittedUseDiscount1Year", "idleVcpuCommittedUseDiscount3Year",
    "idleGibSecond", "idleGibCommittedUseDiscount1Year", "idleGibCommittedUseDiscount3Year",
)
INSTANCE_KEYS = (
    "vcpuSecond", "vcpuCommittedUseDiscount1Year", "vcpuCommittedUseDiscount3Year",
    "gibSecond", "gibCommittedUseDiscount1Year", "gibCommittedUseDiscount3Year",
)
GPU_KEYS = (
    "zonalRedundancy", "noZonalRedundancy", "vcpuSecond", "vcpuCommittedUseDiscount1Year", "vcpuCommittedUseDiscount3Year",
    "gibSecond", "gibCommittedUseDiscount1Year", "gibCommittedUseDiscount3Year",
)

DEFAULT_MODEL_IDS = {"7754-699E-0EBF"}
CUD_1Y_IDS = {"73A1-AD60-B867", "D97B-0795-975B"}
CUD_3Y_IDS = {"A4B6-DEDF-1A65", "70D7-D1AB-12A4"}
FALLBACK_CUD_FACTOR = Decimal("0.83")
IDLE_TOKENS = (
    "idle",
    "idle cpu",
    "idle vcpu",
    "idle memory",
    "idle ram",
    "minimum instance",
    "minimum instances",
    "min instance",
    "min instances",
    "min-instance",
    "min-instances",
)
REQUEST_BASED_TOKENS = (
    "request-based",
    "requests-based",
    "request based",
    "requests based",
)
INSTANCE_BASED_TOKENS = (
    "instance-based",
    "instance based",
)

class PlainYamlDumper(yaml.SafeDumper):
    def ignore_aliases(self, data):
        return True


def plain_decimal(value: Decimal, places: int = 12) -> str:
    quant = Decimal(1).scaleb(-places)
    rounded = value.quantize(quant, rounding=ROUND_HALF_UP)
    text = format(rounded, "f").rstrip("0").rstrip(".")
    return text or "0"


def represent_decimal(dumper: yaml.Dumper, value: Decimal):
    if value == value.to_integral_value():
        return dumper.represent_scalar("tag:yaml.org,2002:int", str(value.to_integral_value()))
    return dumper.represent_scalar("tag:yaml.org,2002:float", plain_decimal(value))

PlainYamlDumper.add_representer(Decimal, represent_decimal)
PlainYamlDumper.add_representer(OrderedDict, yaml.representer.SafeRepresenter.represent_dict)


def canonical(value: Decimal) -> Decimal:
    return Decimal(plain_decimal(value))


def norm(value: Any) -> str:
    return str(value or "").strip().lower()


def money_to_decimal(money: dict[str, Any]) -> Decimal:
    units = Decimal(str(money.get("units", "0") or "0"))
    nanos = Decimal(str(money.get("nanos", 0) or 0)) / Decimal("1000000000")
    return canonical(units + nanos)


def request_json(url: str) -> dict[str, Any]:
    with urlopen(url, timeout=90) as response:
        return json.loads(response.read().decode("utf-8"))


def paged_get(path: str, api_key: str, params: dict[str, str] | None = None, result_key: str | None = None) -> Iterable[dict[str, Any]]:
    params = dict(params or {})
    params["key"] = api_key
    params.setdefault("pageSize", "5000")
    token = None
    while True:
        query = "&".join(f"{quote(str(k))}={quote(str(v))}" for k, v in params.items())
        if token:
            query += f"&pageToken={quote(token)}"
        data = request_json(f"{PRICING_API_BASE}{path}?{query}")
        if result_key is None:
            for key in ("services", "skus", "prices"):
                if key in data:
                    result_key = key
                    break
        for item in data.get(result_key or "items", []):
            yield item
        token = data.get("nextPageToken")
        if not token:
            break


def list_services(api_key: str) -> list[dict[str, Any]]:
    return list(paged_get("/services", api_key, result_key="services"))


def service_names(api_key: str) -> list[str]:
    services = list_services(api_key)
    names = []
    for service in services:
        display = norm(service.get("displayName"))
        if any(norm(name) == display for name in SERVICE_DISPLAY_NAMES) or ("cloud run" in display) or ("cloud functions" in display):
            names.append(service["name"])
    if not names:
        available = sorted(str(s.get("displayName")) for s in services if s.get("displayName"))[:30]
        raise RuntimeError(f"Could not find Cloud Run/Functions services. Available examples: {available}")
    return names


def list_skus(api_key: str, service_name: str) -> list[dict[str, Any]]:
    return list(paged_get("/skus", api_key, params={"filter": f'service="{service_name}"'}, result_key="skus"))


def list_prices(api_key: str, sku_name: str) -> list[dict[str, Any]]:
    return list(paged_get(f"/{sku_name}/prices", api_key, result_key="prices"))


def taxonomy_text(sku: dict[str, Any]) -> str:
    bits = [sku.get("displayName"), sku.get("description")]
    taxonomy = sku.get("productTaxonomy") or {}
    for row in taxonomy.get("taxonomyCategories") or []:
        bits.append(row.get("category"))
    category = sku.get("category") or {}
    if isinstance(category, dict):
        bits.extend(category.values())
    return " ".join(norm(x) for x in bits if x is not None)


def regions_for_sku(sku: dict[str, Any]) -> list[str]:
    regions = []
    for r in sku.get("serviceRegions") or []:
        if r and r != "global":
            regions.append(str(r))
    geo = sku.get("geoTaxonomy") or {}
    region = ((geo.get("regionalMetadata") or {}).get("region") or {}).get("region")
    if region:
        regions.append(str(region))
    for row in geo.get("regions") or geo.get("geoRegions") or []:
        if isinstance(row, str):
            regions.append(row)
        elif isinstance(row, dict) and row.get("region"):
            regions.append(str(row["region"]))
    match = re.search(r"\b(?:us|europe|asia|australia|southamerica|northamerica|me|africa)-[a-z]+[a-z0-9-]*\d\b", taxonomy_text(sku))
    if match:
        regions.append(match.group(0))
    return sorted(dict.fromkeys(r for r in regions if r and r != "global"))


def iter_sku_prices(price_response: dict[str, Any]) -> Iterable[dict[str, Any]]:
    sku_prices = price_response.get("skuPrices")
    if isinstance(sku_prices, list):
        for price in sku_prices:
            if isinstance(price, dict):
                yield price
    elif "rate" in price_response:
        yield price_response


def consumption_model_id(price: dict[str, Any]) -> str:
    for key in ("consumptionModelId", "consumptionModel"):
        value = price.get(key)
        if isinstance(value, str):
            return value.rstrip("/").split("/")[-1]
        if isinstance(value, dict):
            for k in ("id", "consumptionModelId", "name"):
                if value.get(k):
                    return str(value[k]).rstrip("/").split("/")[-1]
    return ""


def price_kind(price: dict[str, Any]) -> str | None:
    mid = consumption_model_id(price)
    desc = norm((price.get("consumptionModel") or {}).get("description") if isinstance(price.get("consumptionModel"), dict) else price.get("consumptionModelDescription"))
    if mid in DEFAULT_MODEL_IDS or desc in {"", "default"}:
        return "default"
    if mid in CUD_1Y_IDS or "1 year" in desc:
        return "cud1"
    if mid in CUD_3Y_IDS or "3 year" in desc:
        return "cud3"
    return None


def first_unit_price(price: dict[str, Any], meter: str) -> Decimal | None:
    rate = price.get("rate") or {}
    tiers = rate.get("tiers") or []
    tier_price = None
    for tier in tiers:
        candidate = money_to_decimal(tier.get("listPrice") or {})
        if candidate > 0:
            tier_price = candidate
            break
    if tier_price is None:
        return None
    unit_info = rate.get("unitInfo") or {}
    unit = norm(unit_info.get("unit") or unit_info.get("unitDescription"))
    unit_quantity = Decimal(str((unit_info.get("unitQuantity") or {}).get("value") if isinstance(unit_info.get("unitQuantity"), dict) else unit_info.get("unitQuantity") or "1"))
    if unit_quantity <= 0:
        unit_quantity = Decimal("1")
    value = tier_price / unit_quantity
    if meter == "request" and unit_quantity == Decimal("1000000"):
        value = tier_price / Decimal("1000000")
    if meter in {"vcpu", "gib", "gpu"} and (unit == "h" or "hour" in unit or unit.endswith(".h")):
        value = value / Decimal("3600")
    return canonical(value)


def prices_by_kind(api_key: str, sku: dict[str, Any], meter: str) -> dict[str, Decimal]:
    out: dict[str, Decimal] = {}
    for response in list_prices(api_key, sku["name"]):
        for price in iter_sku_prices(response):
            kind = price_kind(price)
            if not kind:
                continue
            value = first_unit_price(price, meter)
            if value is None or value <= 0:
                continue
            previous = out.get(kind)
            if previous is None or value < previous:
                out[kind] = value
    return out


def factor(discounted: Decimal | None, default: Decimal | None) -> Decimal:
    if not default:
        return Decimal("1")
    if discounted is None:
        return FALLBACK_CUD_FACTOR
    return (discounted / default).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def classify_sku(sku: dict[str, Any]) -> tuple[str, str, str | None] | None:
    """Return (object_name, key, gpu_type)."""
    text = taxonomy_text(sku)
    if any(token in text for token in ("jobs", "worker pool", "worker-pool", "cloud build", "artifact registry", "eventarc", "network", "egress")):
        return None
    is_function_or_run = "cloud run" in text or "function" in text
    if not is_function_or_run:
        return None
    request_based = any(token in text for token in REQUEST_BASED_TOKENS)
    instance_based = any(token in text for token in INSTANCE_BASED_TOKENS)
    idle = any(token in text for token in IDLE_TOKENS)

    if "gpu" in text or "nvidia" in text:
        gpu_type = "nvidiaL4" if "l4" in text else "nvidiaRtxPro6000" if "6000" in text or "blackwell" in text else "gpu"
        key = "zonalRedundancy" if "zonal" in text and "no zonal" not in text else "noZonalRedundancy" if "no zonal" in text or "without zonal" in text else None
        if key:
            return "gpu", key, gpu_type

    meter_text = re.sub(r"requests?-based", "", text)
    if ("invocation" in meter_text or re.search(r"\brequests?\b", meter_text)) and not instance_based:
        return "request", "request", None
    if ("vcpu" in meter_text or re.search(r"\bcpu\b", meter_text)):
        if idle:
            return "minimum", "idleVcpuSecond", None
        if instance_based:
            return "instance", "vcpuSecond", None
        if request_based:
            return "request", "vcpuSecond", None
    if "memory" in meter_text or "gib" in meter_text or "ram" in meter_text:
        if idle:
            return "minimum", "idleGibSecond", None
        if instance_based:
            return "instance", "gibSecond", None
        if request_based:
            return "request", "gibSecond", None
    return None


def add_regional(row: dict[str, Any], key: str, prices: dict[str, Decimal]) -> None:
    default = prices.get("default")
    if default is None:
        return
    row[key] = default
    if key in {"request", "vcpuSecond", "gibSecond", "idleVcpuSecond", "idleGibSecond"}:
        base = key.replace("Second", "")
        prefix = {
            "request": "request",
            "vcpu": "vcpu",
            "gib": "gib",
            "idleVcpu": "idleVcpu",
            "idleGib": "idleGib",
        }.get(base, base)
        row[f"{prefix}CommittedUseDiscount1Year"] = factor(prices.get("cud1"), default)
        row[f"{prefix}CommittedUseDiscount3Year"] = factor(prices.get("cud3"), default)


def complete(data: dict[str, dict[str, Any]], keys: tuple[str, ...]) -> OrderedDict[str, OrderedDict[str, Any]]:
    out = OrderedDict()
    for region, row in sorted(data.items()):
        if set(keys) <= set(row):
            out[region] = OrderedDict((k, row[k]) for k in keys)
    return out


def build_google_cloud_functions_variables(api_key: str) -> OrderedDict[str, Any]:
    request_rows: dict[str, dict[str, Any]] = defaultdict(dict)
    min_rows: dict[str, dict[str, Any]] = defaultdict(dict)
    instance_rows: dict[str, dict[str, Any]] = defaultdict(dict)
    gpu_rows: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(dict))
    global_request: dict[str, Any] = {}
    classified = defaultdict(int)
    idle_candidates: list[str] = []
    debug_idle = os.environ.get("GCF_DEBUG_IDLE_SKUS", "").strip().lower() in {"1", "true", "yes"}

    for service_name in service_names(api_key):
        for sku in list_skus(api_key, service_name):
            c = classify_sku(sku)
            if not c:
                if debug_idle:
                    text = taxonomy_text(sku)
                    if ("cloud run" in text or "function" in text) and any(token in text for token in IDLE_TOKENS):
                        idle_candidates.append(sku.get("displayName") or sku.get("name") or "<unknown sku>")
                continue
            obj, key, gpu_type = c
            meter = "request" if key == "request" else "gpu" if obj == "gpu" and key in {"zonalRedundancy", "noZonalRedundancy"} else "vcpu" if "Vcpu" in key or key == "vcpuSecond" else "gib"
            prices = prices_by_kind(api_key, sku, meter)
            regions = regions_for_sku(sku)
            if not prices.get("default"):
                continue
            classified[f"{obj}.{key}"] += 1

            if obj == "request" and key == "request" and not regions:
                add_regional(global_request, key, prices)
                continue
            for region in regions:
                if obj == "request":
                    add_regional(request_rows[region], key, prices)
                elif obj == "minimum":
                    add_regional(min_rows[region], key, prices)
                elif obj == "instance":
                    add_regional(instance_rows[region], key, prices)
                elif obj == "gpu" and gpu_type:
                    gpu_rows[region][gpu_type][key] = prices["default"]

    # Request count is a global SKU in many Cloud Run/Functions price lists.
    if global_request:
        for rows in (request_rows, min_rows):
            for row in rows.values():
                for k, v in global_request.items():
                    row.setdefault(k, v)

    # Minimum-instances plan uses active request-based meters plus idle meters in one map.
    for region, request_row in request_rows.items():
        if region in min_rows:
            for k, v in request_row.items():
                min_rows[region].setdefault(k, v)

    # GPU plan also needs CPU/RAM instance-based prices.
    for region, gpu_by_type in gpu_rows.items():
        for gpu_type, row in gpu_by_type.items():
            if region in instance_rows:
                for k, v in instance_rows[region].items():
                    row.setdefault(k, v)

    gpu_complete = OrderedDict()
    for region, by_type in sorted(gpu_rows.items()):
        region_obj = OrderedDict()
        for gpu_type, row in sorted(by_type.items()):
            if set(GPU_KEYS) <= set(row):
                region_obj[gpu_type] = OrderedDict((k, row[k]) for k in GPU_KEYS)
        if region_obj:
            gpu_complete[region] = region_obj

    generated = OrderedDict([
        ("requestBasedPricesPerRegion", complete(request_rows, REQUEST_KEYS)),
        ("minimumInstancesPricesPerRegion", complete(min_rows, MINIMUM_KEYS)),
        ("instanceBasedPricesPerRegion", complete(instance_rows, INSTANCE_KEYS)),
        ("gpuPricesPerRegionAndType", gpu_complete),
    ])

    missing = [k for k, v in generated.items() if not v]
    if missing:
        if debug_idle and idle_candidates:
            sample = ", ".join(idle_candidates[:12])
            print(f"Idle SKU candidates (first {min(len(idle_candidates), 12)}): {sample}", file=sys.stderr)
        raise RuntimeError(f"Missing complete Google Cloud price maps: {missing}; classified={dict(classified)}")
    return generated


def write_yaml(generated: OrderedDict[str, Any], output: str) -> None:
    content = yaml.dump(generated, Dumper=PlainYamlDumper, sort_keys=False, allow_unicode=True)
    if output == "-":
        print(content, end="")
    else:
        Path(output).write_text(content, encoding="utf-8")
        print(f"Wrote {output}", file=sys.stderr)


def decimalize(obj: Any) -> Any:
    if isinstance(obj, dict):
        return {k: decimalize(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [decimalize(v) for v in obj]
    if isinstance(obj, float):
        return Decimal(str(obj))
    return obj


def diff(expected: Any, actual: Any, path: str = "") -> list[str]:
    if isinstance(expected, dict) and isinstance(actual, dict):
        out: list[str] = []
        for key in sorted(set(expected) - set(actual)):
            out.append(f"Missing {path}/{key}")
        for key in sorted(set(actual) - set(expected)):
            out.append(f"Extra {path}/{key}")
        for key in sorted(set(expected) & set(actual)):
            out.extend(diff(expected[key], actual[key], f"{path}/{key}"))
        return out
    if expected != actual:
        return [f"Different value at {path}: expected={expected!r}, actual={actual!r}"]
    return []


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Google Cloud Functions pricing variables")
    parser.add_argument("--api-key", default=os.environ.get("GOOGLE_CLOUD_API_KEY") or os.environ.get("CLOUD_BILLING_API_KEY"))
    parser.add_argument("--output", default=str(REFERENCE_YAML), help="Output YAML path, or '-' for stdout")
    parser.add_argument("--reference", default=None, help="Optional reference YAML to validate against")
    args = parser.parse_args()
    if not args.api_key:
        raise SystemExit("Missing API key. Set GOOGLE_CLOUD_API_KEY or CLOUD_BILLING_API_KEY, or pass --api-key.")
    start = time.perf_counter()
    generated = build_google_cloud_functions_variables(args.api_key)
    if args.reference:
        expected = decimalize(yaml.safe_load(Path(args.reference).read_text(encoding="utf-8")))
        diffs = diff(expected, generated)
        if diffs:
            print("ERROR: generated variables differ from reference", file=sys.stderr)
            for item in diffs[:80]:
                print(f"- {item}", file=sys.stderr)
            raise SystemExit(2)
        print("OK: generated variables match reference", file=sys.stderr)
    write_yaml(generated, args.output)
    print(f"Execution time: {time.perf_counter() - start:.2f}s", file=sys.stderr)

if __name__ == "__main__":
    main()
