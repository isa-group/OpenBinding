#!/usr/bin/env python3
"""
Generate Azure Functions Pricing2Yaml variables from the Azure Retail Prices API.

Output objects:
  - consumptionPricesPerRegion
  - flexConsumptionPricesPerRegion
  - premiumPricesPerRegion

The script intentionally does not invent fallback prices. If Microsoft changes meter
names or stops exposing a meter through the Retail Prices API, the generated output
omits that meter and the final validation explains what is missing.
"""
from __future__ import annotations

import argparse
import json
import random
import re
import sys
import time
from collections import OrderedDict, defaultdict
from datetime import datetime, timezone
from decimal import Decimal, ROUND_HALF_UP
from email.utils import parsedate_to_datetime
from pathlib import Path
from typing import Any, Iterable
from urllib.parse import quote
from urllib.request import urlopen
from urllib.error import HTTPError, URLError

import yaml

AZURE_RETAIL_PRICES_BASE = "https://prices.azure.com/api/retail/prices"
API_VERSION = "2023-01-01-preview"
REFERENCE_YAML = Path("azure_functions_variables.yml")

MAX_ATTEMPTS = 6
BASE_DELAY_SECONDS = 1.0
MAX_DELAY_SECONDS = 30.0
JITTER_RATIO = 0.3

CONSUMPTION_KEYS = ("execution", "gbSecond")
FLEX_KEYS = (
    "onDemandExecution", "onDemandExecutionSavingsPlan1Year", "onDemandExecutionSavingsPlan3Year",
    "onDemandGbSecond", "onDemandGbSecondSavingsPlan1Year", "onDemandGbSecondSavingsPlan3Year",
    "alwaysReadyExecution", "alwaysReadyExecutionSavingsPlan1Year", "alwaysReadyExecutionSavingsPlan3Year",
    "alwaysReadyBaselineGbSecond", "alwaysReadyBaselineGbSecondSavingsPlan1Year", "alwaysReadyBaselineGbSecondSavingsPlan3Year",
    "alwaysReadyExecutionGbSecond", "alwaysReadyExecutionGbSecondSavingsPlan1Year", "alwaysReadyExecutionGbSecondSavingsPlan3Year",
)
PREMIUM_KEYS = (
    "vcpuSecond", "vcpuSecondSavingsPlan1Year", "vcpuSecondSavingsPlan3Year",
    "gbSecond", "gbSecondSavingsPlan1Year", "gbSecondSavingsPlan3Year",
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


def canonical_decimal(value: Decimal) -> Decimal:
    return Decimal(plain_decimal(value))


def norm(value: Any) -> str:
    return str(value or "").strip().lower()


def text_of(item: dict[str, Any]) -> str:
    keys = ("serviceName", "productName", "skuName", "meterName", "meterSubCategory", "unitOfMeasure", "type")
    return " ".join(norm(item.get(k)) for k in keys)


def retail_item_identity(item: dict[str, Any]) -> str:
    """Return a stable identity for de-duping rows returned by overlapping filters.

    Do not use armSkuName as the primary key. A single SKU can expose multiple
    billable meters (for example executions and GB-seconds), so using armSkuName
    can drop required meters before classification. Also keep tierMinimumUnits:
    Consumption meters often have a zero-priced free-grant tier and a paid tier
    with the same meterId. If those tiers are de-duped together, the paid tier is
    skipped and the Consumption map ends up empty. meterId plus tier/region/unit
    fields still removes duplicates produced by overlapping API filters.
    """
    identity = {
        key: item.get(key)
        for key in (
            "meterId",
            "skuId",
            "productId",
            "armRegionName",
            "meterRegion",
            "meterName",
            "skuName",
            "productName",
            "unitOfMeasure",
            "tierMinimumUnits",
            "effectiveStartDate",
            "type",
        )
        if item.get(key) not in (None, "")
    }
    if identity:
        return json.dumps(identity, sort_keys=True, ensure_ascii=False, default=str)
    return json.dumps(item, sort_keys=True, ensure_ascii=False, default=str)


def retail_items(filter_expr: str) -> Iterable[dict[str, Any]]:
    url = f"{AZURE_RETAIL_PRICES_BASE}?api-version={quote(API_VERSION)}&$filter={quote(filter_expr)}"
    while url:
        data = request_json_with_retries(url)
        for item in data.get("Items", []):
            yield item
        url = data.get("NextPageLink")


def request_json_with_retries(url: str) -> dict[str, Any]:
    attempt = 0
    while True:
        attempt += 1
        try:
            with urlopen(url, timeout=90) as response:
                return json.loads(response.read().decode("utf-8"))
        except HTTPError as exc:
            status = exc.code
            retry_after = parse_retry_after(exc)
            retryable = status == 429 or 500 <= status < 600
            if not retryable or attempt >= MAX_ATTEMPTS:
                raise
            delay = compute_delay_seconds(attempt, retry_after)
            print(
                f"Retrying HTTP {status} in {delay:.2f}s (attempt {attempt}/{MAX_ATTEMPTS})",
                file=sys.stderr,
            )
            time.sleep(delay)
        except URLError:
            if attempt >= MAX_ATTEMPTS:
                raise
            delay = compute_delay_seconds(attempt, None)
            print(
                f"Retrying URL error in {delay:.2f}s (attempt {attempt}/{MAX_ATTEMPTS})",
                file=sys.stderr,
            )
            time.sleep(delay)


def parse_retry_after(exc: HTTPError) -> float | None:
    value = exc.headers.get("Retry-After") if exc.headers else None
    if not value:
        return None
    try:
        seconds = int(value)
        if seconds >= 0:
            return float(seconds)
    except ValueError:
        pass
    try:
        dt = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        return None
    if dt.tzinfo is None:
        dt = dt.replace(tzinfo=timezone.utc)
    delta = (dt - datetime.now(timezone.utc)).total_seconds()
    return max(0.0, delta)


def compute_delay_seconds(attempt: int, retry_after: float | None) -> float:
    base = min(MAX_DELAY_SECONDS, BASE_DELAY_SECONDS * (2 ** (attempt - 1)))
    delay = retry_after if retry_after is not None else base
    jitter = random.uniform(0.0, JITTER_RATIO * delay)
    return min(MAX_DELAY_SECONDS, delay + jitter)


def unit_price(item: dict[str, Any]) -> Decimal | None:
    value = item.get("retailPrice") or item.get("unitPrice")
    if value is None:
        return None
    price = Decimal(str(value))
    if price <= 0:
        return None
    return canonical_decimal(price)


def execution_unit_divisor(unit: str) -> Decimal | None:
    """Return the number of executions represented by an execution meter unit."""
    if "million" in unit or re.search(r"\b1\s*m\b", unit):
        return Decimal("1000000")
    if re.search(r"\b10\s*k\b|\b10k\b", unit):
        return Decimal("10000")
    if re.search(r"\b1\s*k\b|\b1k\b", unit):
        return Decimal("1000")
    return None


def normalized_price(item: dict[str, Any], kind: str) -> Decimal | None:
    price = unit_price(item)
    if price is None:
        return None
    unit = norm(item.get("unitOfMeasure"))
    if kind.endswith("Execution") or kind == "execution":
        divisor = execution_unit_divisor(unit)
        if divisor:
            return canonical_decimal(price / divisor)
    if "hour" in unit and ("Second" in kind or kind.endswith("GbSecond") or kind == "gbSecond"):
        return canonical_decimal(price / Decimal("3600"))
    return price


def savings_factor(item: dict[str, Any], years: int) -> Decimal:
    """Return the savings-plan multiplier for the meter's native published unit."""
    on_demand = unit_price(item)
    if on_demand is None or on_demand <= 0:
        return Decimal("1")
    for plan in item.get("savingsPlan") or []:
        term = norm(plan.get("term"))
        if (years == 1 and "1" in term) or (years == 3 and "3" in term):
            price = plan.get("retailPrice") or plan.get("unitPrice")
            if price is not None:
                return (Decimal(str(price)) / on_demand).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)
    return Decimal("1")


def classify(item: dict[str, Any]) -> tuple[str, str] | None:
    """Return (object_name, meter_key)."""
    t = text_of(item)
    product = norm(item.get("productName"))
    meter = norm(item.get("meterName"))
    sku = norm(item.get("skuName"))

    if "dev/test" in t or "spot" in t:
        return None
    if "functions" not in t and "function" not in t:
        return None

    is_flex = "flex" in t
    is_premium = "premium" in t or "elastic premium" in t
    is_always_ready = "always ready" in t or "always-ready" in t
    is_on_demand = "on demand" in t or "ondemand" in t

    if is_premium:
        if re.search(r"\b(vcpu|core)\b", t):
            return "premium", "vcpuSecond"
        if "memory" in t or "gb-s" in t or "gb second" in t or "gb-second" in t:
            return "premium", "gbSecond"

    is_gb_second = any(token in t for token in ("execution time", "execution duration", "gb-s", "gb second", "gb-second", "gb/second", "gb second"))
    is_execution_count = "execution" in t or "request" in t

    if is_flex:
        if is_always_ready:
            if "baseline" in t:
                return "flex", "alwaysReadyBaselineGbSecond"
            if is_gb_second:
                return "flex", "alwaysReadyExecutionGbSecond"
            if is_execution_count:
                return "flex", "alwaysReadyExecution"
        if is_on_demand or "on-demand" in t:
            if is_gb_second:
                return "flex", "onDemandGbSecond"
            if is_execution_count:
                return "flex", "onDemandExecution"

    # Legacy Consumption: avoid flex/premium rows.
    if not is_flex and not is_premium:
        if is_gb_second:
            return "consumption", "gbSecond"
        if is_execution_count:
            return "consumption", "execution"
    return None


def add_meter(target: dict[str, dict[str, Any]], object_name: str, region: str, key: str, item: dict[str, Any]) -> bool:
    price = normalized_price(item, key)
    if price is None:
        return False
    row = target[object_name][region]
    previous = row.get(key)
    if previous is None or price < previous:
        row[key] = price
        if object_name in {"flex", "premium"}:
            row[f"{key}SavingsPlan1Year"] = savings_factor(item, 1)
            row[f"{key}SavingsPlan3Year"] = savings_factor(item, 3)
    return True


def complete_map(data: dict[str, dict[str, Any]], required: tuple[str, ...]) -> OrderedDict[str, OrderedDict[str, Any]]:
    result = OrderedDict()
    for region, row in sorted(data.items()):
        if set(required) <= set(row):
            result[region] = OrderedDict((key, row[key]) for key in required)
    return result


def sample_item(item: dict[str, Any], note: str) -> dict[str, Any]:
    return {
        "note": note,
        "serviceName": item.get("serviceName"),
        "productName": item.get("productName"),
        "skuName": item.get("skuName"),
        "meterName": item.get("meterName"),
        "meterSubCategory": item.get("meterSubCategory"),
        "unitOfMeasure": item.get("unitOfMeasure"),
        "armRegionName": item.get("armRegionName"),
        "meterRegion": item.get("meterRegion"),
        "retailPrice": item.get("retailPrice"),
        "unitPrice": item.get("unitPrice"),
    }


def missing_keys_by_region(
    data: dict[str, dict[str, Any]],
    required: tuple[str, ...],
) -> dict[str, list[str]]:
    out: dict[str, list[str]] = {}
    required_set = set(required)
    for region, row in data.items():
        missing = sorted(required_set - set(row))
        if missing:
            out[region] = missing
    return out


def build_azure_functions_variables(debug_samples: int = 0) -> OrderedDict[str, Any]:
    # Use a broad filter and classify locally; service/product names vary over time and locale.
    filters = [
        "serviceFamily eq 'Compute' and priceType eq 'Consumption'",
        "serviceName eq 'Functions' and priceType eq 'Consumption'",
        "serviceName eq 'Azure Functions' and priceType eq 'Consumption'",
    ]
    seen_ids: set[str] = set()
    raw: dict[str, dict[str, Any]] = {"consumption": defaultdict(dict), "flex": defaultdict(dict), "premium": defaultdict(dict)}
    total = 0
    classified = defaultdict(int)
    samples: dict[str, list[dict[str, Any]]] = {
        "unclassified": [],
        "no_price": [],
    }

    for filter_expr in filters:
        for item in retail_items(filter_expr):
            item_id = retail_item_identity(item)
            if item_id in seen_ids:
                continue
            seen_ids.add(item_id)
            total += 1
            c = classify(item)
            if not c:
                if debug_samples and ("functions" in text_of(item)) and len(samples["unclassified"]) < debug_samples:
                    samples["unclassified"].append(sample_item(item, note="unclassified"))
                continue
            object_name, key = c
            region = item.get("armRegionName") or item.get("meterRegion")
            if not region or str(region).strip().lower() == "global":
                continue
            added = add_meter(raw, object_name, str(region), key, item)
            if debug_samples and not added and len(samples["no_price"]) < debug_samples:
                samples["no_price"].append(sample_item(item, note=f"no_price:{object_name}.{key}"))
            classified[f"{object_name}.{key}"] += 1

    generated = OrderedDict([
        ("consumptionPricesPerRegion", complete_map(raw["consumption"], CONSUMPTION_KEYS)),
        ("flexConsumptionPricesPerRegion", complete_map(raw["flex"], FLEX_KEYS)),
        ("premiumPricesPerRegion", complete_map(raw["premium"], PREMIUM_KEYS)),
    ])

    missing = [name for name, value in generated.items() if not value]
    if missing:
        if debug_samples:
            missing_by_region = {
                "consumption": missing_keys_by_region(raw["consumption"], CONSUMPTION_KEYS),
                "flex": missing_keys_by_region(raw["flex"], FLEX_KEYS),
                "premium": missing_keys_by_region(raw["premium"], PREMIUM_KEYS),
            }
            debug_payload = {
                "missingByRegion": missing_by_region,
                "samples": samples,
            }
            print("DEBUG: missing meter diagnostics", file=sys.stderr)
            print(json.dumps(debug_payload, indent=2, sort_keys=True), file=sys.stderr)
        preview = {obj: {r: sorted(v.keys()) for r, v in list(rows.items())[:12]} for obj, rows in raw.items()}
        raise RuntimeError(
            f"Missing complete Azure Functions price maps: {missing}. Items read={total}; "
            f"classified={dict(classified)}; preview={preview}"
        )
    return generated


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
    if Decimal(str(expected)) != Decimal(str(actual)) if (isinstance(expected, (Decimal, int, float)) and isinstance(actual, (Decimal, int, float))) else expected != actual:
        return [f"Different value at {path}: expected={expected!r}, actual={actual!r}"]
    return []


def write_yaml(generated: OrderedDict[str, Any], output: str) -> None:
    content = yaml.dump(generated, Dumper=PlainYamlDumper, sort_keys=False, allow_unicode=True)
    if output == "-":
        print(content, end="")
    else:
        Path(output).write_text(content, encoding="utf-8")
        print(f"Wrote {output}", file=sys.stderr)


def main() -> None:
    parser = argparse.ArgumentParser(description="Generate Azure Functions pricing variables")
    parser.add_argument("--output", default=str(REFERENCE_YAML), help="Output YAML path, or '-' for stdout")
    parser.add_argument("--reference", default=None, help="Optional reference YAML to validate against before writing")
    parser.add_argument("--debug-samples", type=int, default=0, help="Log debug sample items when maps are missing")
    args = parser.parse_args()
    start = time.perf_counter()
    generated = build_azure_functions_variables(debug_samples=max(0, args.debug_samples))
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
