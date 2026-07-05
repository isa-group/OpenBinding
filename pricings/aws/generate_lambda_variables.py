#!/usr/bin/env python3
"""
Generate Pricing2Yaml variables for the expanded AWS Lambda pricing model.

Every emitted price value is obtained from AWS APIs in the current run:
    - AWS Price List API for AWSLambda and AmazonEC2 on-demand prices;
    - AWS Savings Plans Offering Rates for Savings Plans multipliers.

The script does not use pricing-page fallback constants. If an optional price
family is absent from the AWS API response, the corresponding generated map is
left empty and a warning is printed. Use --strict-complete to fail when any map
referenced by aws_lambda_pricing.yml is empty.
"""
from __future__ import annotations

import argparse
import json
import re
import sys
import time
from collections import Counter, OrderedDict, defaultdict
from urllib.error import HTTPError, URLError
from urllib.request import urlopen
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path
from typing import Any, Iterable

import boto3
import yaml
from botocore.exceptions import BotoCoreError, ClientError

AWS_LAMBDA_SERVICE_CODE = "AWSLambda"
AWS_EC2_SERVICE_CODE = "AmazonEC2"
AWS_CLOUDFRONT_SERVICE_CODE = "AmazonCloudFront"
BULK_PRICE_LIST_BASE = "https://pricing.us-east-1.amazonaws.com/offers/v1.0/aws"
PRICING_ENDPOINT_REGION = "us-east-1"
SAVINGS_PLANS_ENDPOINT_REGION = "us-east-1"
REFERENCE_YAML = Path("lambda_variables.yml")
ARCHITECTURES = ("x86", "arm")
TIER_PRICE_KEYS = ("firstGbSeconds", "nextGbSeconds", "lastGbSeconds")
SAVINGS_PLAN_DURATION_SECONDS_TO_KEY = {
    31_536_000: "1Year",
    94_608_000: "3Year",
}

BLOCKED_ON_DEMAND_TOKENS = (
    "edge", "provisioned", "provisioned-concurrency", "ephemeral", "storage",
    "snapstart", "response-stream", "response streaming", "tenant isolation",
    "managed instances", "durable", "event source mapping", "event poller",
)

TARGETED_LAMBDA_GROUPS = (
    # Provisioned Concurrency: configured capacity + provisioned execution duration.
    "AWS-Lambda-Provisioned-Concurrency",
    "AWS-Lambda-Provisioned-Concurrency-ARM",
    "AWS-Lambda-Duration-Provisioned",
    "AWS-Lambda-Duration-Provisioned-ARM",
    # Response streaming.
    "AWS-Lambda-Processed-Bytes",
    "AWS-Lambda-Processed-Bytes-ARM",
    # Durable Functions.
    "AWS-Lambda-Durable-Execution-Operations",
    "AWS-Lambda-Durable-Execution-Written-Bytes",
    "AWS-Lambda-Durable-Execution-TimedStorage-ByteHrs",
    # Provisioned Mode for Event Source Mapping.
    "AWS-Lambda-Event-Poller-Unit-Duration",
    "AWS-Lambda-SQS-Event-Poller-Unit-Duration",
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


def dec(value: Any) -> Decimal:
    return Decimal(str(value))


def canonical(value: Decimal) -> Decimal:
    return Decimal(plain_decimal(value))


def norm(value: Any) -> str:
    return str(value or "").strip().lower()


def joined(*values: Any) -> str:
    return " ".join(norm(v) for v in values if v is not None)


def compact(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", "", norm(value))


def normalize_unit(unit: Any) -> str:
    return norm(unit).replace(" ", "")


def is_inf(value: Any) -> bool:
    return str(value).lower() in {"inf", "infinity"}


def get_products(pricing_client, service_code: str, filters: list[dict[str, str]] | None = None) -> Iterable[dict[str, Any]]:
    paginator = pricing_client.get_paginator("get_products")
    for page in paginator.paginate(
        ServiceCode=service_code,
        Filters=filters or [],
        FormatVersion="aws_v1",
        PaginationConfig={"PageSize": 100},
    ):
        for raw in page.get("PriceList", []):
            yield json.loads(raw)




def bulk_products(service_code: str) -> Iterable[dict[str, Any]]:
    """Yield products from the official AWS Price List Bulk API.

    The Query API and Bulk API are both AWS Price List APIs.  Some newer or
    global Lambda-related families can be absent from a broad get_products
    response but present in the current bulk offer file.  This is not a pricing
    fallback: every value still comes from AWS-published API data.
    """
    url = f"{BULK_PRICE_LIST_BASE}/{service_code}/current/index.json"
    try:
        with urlopen(url, timeout=120) as response:
            data = json.loads(response.read().decode("utf-8"))
    except (HTTPError, URLError, TimeoutError, json.JSONDecodeError) as exc:
        print(f"WARN: could not read AWS Price List Bulk API for {service_code}: {exc}", file=sys.stderr)
        return

    terms = data.get("terms", {}).get("OnDemand", {})
    for sku, product in (data.get("products") or {}).items():
        yield {
            "product": product,
            "terms": {"OnDemand": terms.get(sku, {})},
            "_serviceCode": service_code,
            "_sku": sku,
            "_source": "bulk",
        }


def iter_service_products(session: boto3.Session, service_codes: Iterable[str], include_bulk: bool = False) -> Iterable[dict[str, Any]]:
    """Yield de-duplicated products from AWS Price List Query API.

    Bulk API access is deliberately opt-in because the full offer files are
    large and made the generator slow without improving the targeted Lambda
    families that the Price List Query API exposes through exact group values.
    """
    pricing = session.client("pricing", region_name=PRICING_ENDPOINT_REGION)
    seen: set[tuple[str, str, str]] = set()

    for service_code in service_codes:
        try:
            for product in get_products(pricing, service_code):
                sku = str(product.get("product", {}).get("sku") or product.get("_sku") or "")
                key = (service_code, sku, "query")
                if key in seen:
                    continue
                seen.add(key)
                product.setdefault("_serviceCode", service_code)
                product.setdefault("_sku", sku)
                product.setdefault("_source", "query")
                yield product
        except (BotoCoreError, ClientError) as exc:
            print(f"WARN: could not query AWS Price List API for {service_code}: {exc}", file=sys.stderr)

        if include_bulk:
            for product in bulk_products(service_code):
                sku = str(product.get("product", {}).get("sku") or product.get("_sku") or "")
                key = (service_code, sku, "bulk")
                if key in seen:
                    continue
                seen.add(key)
                yield product

def dimensions(product: dict[str, Any]) -> list[dict[str, Any]]:
    out = []
    for term in product.get("terms", {}).get("OnDemand", {}).values():
        for dim in term.get("priceDimensions", {}).values():
            out.append({
                "begin": dec(dim.get("beginRange", "0")),
                "end": dim.get("endRange", "Inf"),
                "price": dec(dim.get("pricePerUnit", {}).get("USD", "0")),
                "unit": dim.get("unit", ""),
                "description": dim.get("description", ""),
            })
    return out


def product_text(attrs: dict[str, Any], dims: list[dict[str, Any]], service_code: str | None = None, sku: str | None = None) -> str:
    # AWS adds new Lambda price families by introducing new product attributes
    # before their names are consistently reflected in a small fixed set of
    # fields.  Include every attribute value so classifiers are resilient to
    # current SKU naming without hardcoded prices.
    attr_values = []
    for key, value in sorted(attrs.items()):
        if value is not None:
            attr_values.append(f"{key}={value}")
    dim_values = []
    for dim in dims:
        dim_values.append(str(dim.get("unit", "")))
        dim_values.append(str(dim.get("description", "")))
    return joined(service_code, sku, *attr_values, *dim_values)


def arch_from_text(text: str) -> str:
    return "arm" if re.search(r"(^|[-_ ])arm(64)?($|[-_ ])", text) or "graviton" in text else "x86"


def region_code(attrs: dict[str, Any]) -> str | None:
    region = attrs.get("regionCode") or attrs.get("location") or attrs.get("fromLocation")
    if not region:
        return None
    text = str(region).strip()
    if text.lower() in {"global", "any", ""}:
        return "global"
    return text


def extract_prices(dims: list[dict[str, Any]], predicate) -> list[Decimal]:
    prices = [canonical(d["price"]) for d in dims if d["price"] > 0 and predicate(d)]
    return sorted(set(prices))




def first_positive_price(dims: list[dict[str, Any]]) -> Decimal | None:
    prices = [canonical(d["price"]) for d in dims if d.get("price", Decimal("0")) > 0]
    return min(prices) if prices else None


def edge_compute_price_from_dimension(dim: dict[str, Any]) -> Decimal | None:
    if dim["price"] <= 0:
        return None
    unit = normalize_unit(dim.get("unit"))
    desc = norm(dim.get("description"))
    if "128mb" in unit or "128 mb" in desc or "128mb" in desc:
        return canonical(dim["price"])
    if "gb-second" in unit or "gb-sec" in unit or "gb second" in desc or "gb-second" in desc or "gb-sec" in desc:
        # Lambda@Edge is modeled in the YAML as 128 MB-seconds.  If the AWS
        # API publishes a GB-second price, convert it to 1/8 GB.
        return canonical(dim["price"] / Decimal("8"))
    return None


def unique_sorted_prices(candidates: list[dict[str, Any]]) -> list[dict[str, Any]]:
    by_price: OrderedDict[Decimal, dict[str, Any]] = OrderedDict()
    for item in sorted(candidates, key=lambda x: x["price"]):
        by_price.setdefault(item["price"], item)
    return list(by_price.values())

def duration_tiers(dims: list[dict[str, Any]]) -> list[dict[str, Any]]:
    tiers = []
    for d in dims:
        unit = normalize_unit(d.get("unit"))
        desc = norm(d.get("description"))
        if d["price"] <= 0:
            continue
        if "gb-second" in unit or "gb-sec" in unit or "gb-second" in desc or "gb second" in desc or "gb-sec" in desc:
            tiers.append({"begin": d["begin"], "end": d["end"], "price": canonical(d["price"])})
    uniq = OrderedDict()
    for t in tiers:
        uniq[(t["begin"], str(t["end"]), t["price"])] = t
    return sorted(uniq.values(), key=lambda x: x["begin"])


def tier_prices(tiers: list[dict[str, Any]], keys: tuple[str, str, str]) -> OrderedDict[str, Decimal]:
    if not tiers:
        raise RuntimeError("No duration tiers")
    prices = [t["price"] for t in tiers]
    while len(prices) < 3:
        prices.append(prices[-1])
    return OrderedDict((key, prices[i]) for i, key in enumerate(keys))


def tier_limits(tiers: list[dict[str, Any]]) -> tuple[int, int] | None:
    finite = [t for t in tiers if not is_inf(t["end"])]
    if len(finite) < 2:
        return None
    first = dec(finite[0]["end"]) - finite[0]["begin"]
    second = dec(finite[1]["end"]) - finite[1]["begin"]
    if first <= 0 or second <= 0:
        return None
    return int(first), int(second)


def derive_limits(region_data: dict[str, dict[str, Any]], raw_key: str) -> OrderedDict[str, OrderedDict[str, int]]:
    counters = {arch: Counter() for arch in ARCHITECTURES}
    for row in region_data.values():
        for arch in ARCHITECTURES:
            tiers = row.get(raw_key, {}).get(arch)
            if tiers:
                limits = tier_limits(tiers)
                if limits:
                    counters[arch][limits] += 1
    out = OrderedDict()
    for arch in ARCHITECTURES:
        if counters[arch]:
            first, second = counters[arch].most_common(1)[0][0]
        else:
            first, second = 0, 0
        out[arch] = OrderedDict([("firstLimit", first), ("secondLimit", second)])
    return out


def usage_prefix(usage_type: Any, markers: tuple[str, ...]) -> str | None:
    text = str(usage_type or "")
    for marker in markers:
        idx = text.find(marker)
        if idx >= 0:
            return text[:idx]
    return None


def request_matches_prefix(usage_type: Any, prefix: str | None) -> bool:
    if not prefix:
        return False
    text = str(usage_type or "")
    if not text.startswith(prefix):
        return False
    return bool(re.fullmatch(r"Requests?", text[len(prefix):], flags=re.IGNORECASE))


def choose_request_price(candidates: list[dict[str, Any]], prefixes: list[str]) -> Decimal | None:
    if not candidates:
        return None
    prefixed = [c for c in candidates if any(request_matches_prefix(c.get("usageType"), p) for p in prefixes)]
    if prefixed:
        return max(prefixed, key=lambda c: c["price"])["price"]
    return max(candidates, key=lambda c: c["price"])["price"]


def lambda_savings_rates(session: boto3.Session) -> dict[str, dict[str, Decimal]]:
    """Return Lambda Compute Savings Plans rates by usage type and term.

    The pricing YAML exposes annual and triannual customBilling separately. They
    can be equal today for some Lambda meters, but AWS publishes different
    offering durations, so the generator keeps both factors independent.
    """
    client = session.client("savingsplans", region_name=SAVINGS_PLANS_ENDPOINT_REGION)
    out: dict[str, dict[str, Decimal]] = {}
    token = None
    while True:
        kwargs = {
            "savingsPlanPaymentOptions": ["No Upfront"],
            "savingsPlanTypes": ["Compute"],
            "products": ["Lambda"],
            "serviceCodes": [AWS_LAMBDA_SERVICE_CODE],
            "maxResults": 1000,
        }
        if token:
            kwargs["nextToken"] = token
        page = client.describe_savings_plans_offering_rates(**kwargs)
        for row in page.get("searchResults", []):
            offering = row.get("savingsPlanOffering", {}) or {}
            term_key = SAVINGS_PLAN_DURATION_SECONDS_TO_KEY.get(offering.get("durationSeconds"))
            if not term_key:
                continue
            usage_type = row.get("usageType")
            rate = row.get("rate")
            if not usage_type or rate is None:
                continue
            rate_dec = canonical(dec(rate))
            term_rates = out.setdefault(usage_type, {})
            previous = term_rates.get(term_key)
            if previous is None or rate_dec < previous:
                term_rates[term_key] = rate_dec
        token = page.get("nextToken")
        if not token:
            return out




def ec2_savings_rates(session: boto3.Session) -> dict[str, dict[str, Decimal]]:
    """Return EC2 Compute Savings Plans rates by usage type and term."""
    client = session.client("savingsplans", region_name=SAVINGS_PLANS_ENDPOINT_REGION)
    out: dict[str, dict[str, Decimal]] = {}
    token = None
    while True:
        kwargs = {
            "savingsPlanPaymentOptions": ["No Upfront"],
            "savingsPlanTypes": ["Compute"],
            "products": ["EC2"],
            "serviceCodes": [AWS_EC2_SERVICE_CODE],
            "maxResults": 1000,
        }
        if token:
            kwargs["nextToken"] = token
        page = client.describe_savings_plans_offering_rates(**kwargs)
        for row in page.get("searchResults", []):
            offering = row.get("savingsPlanOffering", {}) or {}
            term_key = SAVINGS_PLAN_DURATION_SECONDS_TO_KEY.get(offering.get("durationSeconds"))
            if not term_key:
                continue
            usage_type = row.get("usageType")
            rate = row.get("rate")
            if not usage_type or rate is None:
                continue
            rate_dec = canonical(dec(rate))
            term_rates = out.setdefault(usage_type, {})
            previous = term_rates.get(term_key)
            if previous is None or rate_dec < previous:
                term_rates[term_key] = rate_dec
        token = page.get("nextToken")
        if not token:
            return out


def discount_from_savings_rate(base_price: Decimal | None, rate: Decimal | None) -> Decimal:
    if not base_price or base_price <= 0 or rate is None:
        return Decimal("1")
    return (rate / base_price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)

def discount_for_usage(usage_type: str | None, base_price: Decimal | None, savings_rates: dict[str, dict[str, Decimal]], term_key: str) -> Decimal:
    if not usage_type or not base_price or base_price <= 0:
        return Decimal("1")
    rate = savings_rates.get(usage_type, {}).get(term_key)
    if not rate:
        return Decimal("1")
    return (rate / base_price).quantize(Decimal("0.01"), rounding=ROUND_HALF_UP)


def build_lambda_from_price_list(session: boto3.Session) -> OrderedDict[str, Any]:
    pricing = session.client("pricing", region_name=PRICING_ENDPOINT_REGION)
    regions: dict[str, dict[str, Any]] = defaultdict(lambda: {"_requestCandidates": [], "_usageTypes": {}, "_rawTiers": {}})
    pc_regions: dict[str, dict[str, Any]] = defaultdict(lambda: {"_requestCandidates": [], "_usageTypes": {}, "_rawTiers": {}, "_gbSecondCandidates": defaultdict(list)})
    ephem: dict[str, dict[str, Any]] = defaultdict(dict)
    response: dict[str, dict[str, Any]] = defaultdict(dict)
    snap: dict[str, dict[str, Any]] = defaultdict(dict)
    tenant: dict[str, dict[str, Any]] = defaultdict(dict)
    durable: dict[str, dict[str, Any]] = defaultdict(dict)
    esm: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(dict))
    edge: dict[str, Any] = {}
    classified = Counter()
    samples = []

    for product in iter_service_products(session, (AWS_LAMBDA_SERVICE_CODE, AWS_CLOUDFRONT_SERVICE_CODE), include_bulk=False):
        attrs = product.get("product", {}).get("attributes", {})
        dims = dimensions(product)
        service_code = product.get("_serviceCode", AWS_LAMBDA_SERVICE_CODE)
        sku = product.get("_sku") or product.get("product", {}).get("sku")
        text = product_text(attrs, dims, service_code=service_code, sku=sku)
        region = region_code(attrs)
        usage_type = attrs.get("usagetype")
        arch = arch_from_text(text)

        def has_duration(d):
            u, desc = normalize_unit(d.get("unit")), norm(d.get("description"))
            return "gb-second" in u or "gb-sec" in u or "gb second" in desc or "gb-second" in desc or "gb-sec" in desc
        def has_request(d):
            return "request" in normalize_unit(d.get("unit")) or "request" in norm(d.get("description"))

        if not region and "lambda@edge" not in text and "lambdaedge" not in compact(text) and not ("lambda" in text and "edge" in text):
            continue

        compact_text = compact(text)
        if "lambda@edge" in text or "lambdaedge" in compact_text or ("lambda" in text and "edge" in text and service_code in {AWS_LAMBDA_SERVICE_CODE, AWS_CLOUDFRONT_SERVICE_CODE}):
            for p in extract_prices(dims, has_request):
                current = edge.get("edgeRequest")
                edge["edgeRequest"] = p if current is None else min(current, p)
            edge_compute_prices = [p for p in (edge_compute_price_from_dimension(d) for d in dims) if p is not None]
            if edge_compute_prices:
                current = edge.get("edge128MbSecond")
                candidate = min(edge_compute_prices)
                edge["edge128MbSecond"] = candidate if current is None else min(current, candidate)
            classified["edge"] += 1
            continue

        if "provisioned mode" in text and ("event source mapping" in text or "event poller" in text or "epu" in text):
            source = "sqs" if "sqs" in text else "kafka" if "kafka" in text or "msk" in text or "smk" in text else "default"
            prices = extract_prices(dims, lambda d: "epu" in normalize_unit(d.get("unit")) or "event-poller" in norm(d.get("description")) or "event poller" in norm(d.get("description")))
            if prices:
                esm[region][source]["epuHour"] = min(prices)
                classified[f"esm.{source}"] += 1
            continue

        if "durable" in text:
            if "operation" in text or "steps" in text or "waits" in text:
                prices = extract_prices(dims, lambda d: "operation" in normalize_unit(d.get("unit")) or "operation" in norm(d.get("description")))
                if prices: durable[region]["operation"] = min(prices)
            if "data written" in text or "written" in text:
                prices = extract_prices(dims, lambda d: "gb" in normalize_unit(d.get("unit")) or "gb" in norm(d.get("description")))
                if prices: durable[region]["dataWrittenGb"] = min(prices)
            if "retained" in text or "storage" in text or "gb-month" in text:
                prices = extract_prices(dims, lambda d: "gb-month" in normalize_unit(d.get("unit")) or "gb-month" in norm(d.get("description")))
                if prices: durable[region]["dataRetainedGbMonth"] = min(prices)
            classified["durable"] += 1
            continue

        if "tenant isolation" in text or "tenant-isolated" in text:
            prices = extract_prices(dims, lambda d: "environment" in norm(d.get("description")) or "environment" in normalize_unit(d.get("unit")))
            if not prices:
                prices = extract_prices(dims, lambda d: d["price"] > 0)
            if prices:
                tenant[region].setdefault(arch, OrderedDict())["environmentGb"] = min(prices)
                classified[f"tenant.{arch}"] += 1
            continue

        if "snapstart" in text or "snap start" in text:
            prices = extract_prices(dims, lambda d: d["price"] > 0)
            if prices:
                key = "restoreGb" if "restore" in text else "cacheGbSecond" if "cache" in text or "caching" in text else None
                if key:
                    snap[region].setdefault(arch, OrderedDict())[key] = min(prices)
                    classified[f"snap.{key}.{arch}"] += 1
            continue

        if "responsestream" in compact_text or "streamingresponse" in compact_text or "bytesstreamed" in compact_text or "streamedbytes" in compact_text or "response stream" in text or "response-stream" in text or "bytes streamed" in text:
            prices = extract_prices(dims, lambda d: "gb" in normalize_unit(d.get("unit")) or "gb" in norm(d.get("description")))
            if prices:
                response[region]["gb"] = min(prices)
                classified["response"] += 1
            continue

        if "ephemeral" in text or "tmp" in text or "storage" in text:
            if "ephemeral" in text:
                prices = extract_prices(dims, lambda d: has_duration(d) or "gb-second" in norm(d.get("description")))
                if prices:
                    ephem[region].setdefault(arch, OrderedDict())["gbSecond"] = min(prices)
                    classified[f"ephemeral.{arch}"] += 1
            continue

        if "provisionedconcurrency" in compact_text or "provisionedconcurrent" in compact_text or ("provisioned" in compact_text and "concurrency" in compact_text):
            if "request" in text:
                for p in extract_prices(dims, has_request):
                    pc_regions[region]["_requestCandidates"].append({"price": p, "usageType": usage_type})
                classified["pc.request"] += 1
            if any(has_duration(d) for d in dims) or "gbsecond" in compact_text or "gbsec" in compact_text:
                tiers = duration_tiers(dims)
                if tiers:
                    candidate = {"price": tiers[0]["price"], "usageType": usage_type, "text": text}
                    pc_regions[region]["_gbSecondCandidates"][arch].append(candidate)
                    # Prefer semantic labels when AWS exposes them.  If names are
                    # ambiguous, a later reconciliation step assigns the lower
                    # GB-second API price to configured capacity and the higher
                    # GB-second API price to execution duration.
                    if "configured" in compact_text or "capacity" in compact_text:
                        pc_regions[region].setdefault(arch, OrderedDict())["configuredGbSecond"] = tiers[0]["price"]
                        pc_regions[region]["_usageTypes"][f"configured.{arch}"] = usage_type
                        classified[f"pc.configured.{arch}"] += 1
                    elif "duration" in compact_text or "compute" in compact_text or "execution" in compact_text:
                        pc_regions[region].setdefault(arch, OrderedDict())["computeGbSecond"] = tiers[0]["price"]
                        pc_regions[region]["_usageTypes"][f"compute.{arch}"] = usage_type
                        classified[f"pc.compute.{arch}"] += 1
            continue

        # Default on-demand Lambda.
        if not any(token in text for token in BLOCKED_ON_DEMAND_TOKENS):
            if re.search(r"(^|-)requests?$", norm(usage_type)) or any(has_request(d) for d in dims):
                for p in extract_prices(dims, has_request):
                    regions[region]["_requestCandidates"].append({"price": p, "usageType": usage_type})
                classified["ondemand.request"] += 1
                continue
            if any(has_duration(d) for d in dims):
                tiers = duration_tiers(dims)
                if tiers:
                    regions[region]["_rawTiers"][arch] = tiers
                    regions[region].setdefault(arch, OrderedDict()).update(tier_prices(tiers, TIER_PRICE_KEYS))
                    regions[region]["_usageTypes"][arch] = usage_type
                    classified[f"ondemand.duration.{arch}"] += 1
                    continue

        if len(samples) < 12:
            samples.append(str(usage_type or attrs.get("groupDescription") or attrs.get("productFamily") or "<unknown>"))

    savings = {}
    try:
        savings = lambda_savings_rates(session)
    except (BotoCoreError, ClientError) as exc:
        print(f"WARN: could not retrieve Lambda Savings Plans rates: {exc}", file=sys.stderr)

    for region, row in regions.items():
        prefixes = [usage_prefix(row.get("_usageTypes", {}).get(a), ("Lambda-GB-Second", "Lambda-GB-Sec")) for a in ARCHITECTURES]
        row["lambdaRequest"] = choose_request_price(row.get("_requestCandidates", []), [p for p in prefixes if p])
        # One multiplier per region and term, preserving the pricing YAML shape
        # while keeping 1-year and 3-year Savings Plans independent.
        for term_key in ("1Year", "3Year"):
            discount = Decimal("1")
            for arch in ARCHITECTURES:
                first = row.get(arch, {}).get("firstGbSeconds")
                discount = discount_for_usage(row.get("_usageTypes", {}).get(arch), first, savings, term_key)
                if discount != Decimal("1"):
                    break
            row[f"durationDiscount{term_key}"] = discount

    for region, row in pc_regions.items():
        for arch, candidates in row.get("_gbSecondCandidates", {}).items():
            if not candidates:
                continue
            arch_row = row.setdefault(arch, OrderedDict())
            unique = unique_sorted_prices(candidates)
            configured = arch_row.get("configuredGbSecond")
            compute = arch_row.get("computeGbSecond")
            if configured is None or compute is None:
                configured_candidates = [c for c in unique if "configured" in compact(c.get("text")) or "capacity" in compact(c.get("text"))]
                compute_candidates = [c for c in unique if "duration" in compact(c.get("text")) or "compute" in compact(c.get("text")) or "execution" in compact(c.get("text"))]
                if configured is None and configured_candidates:
                    chosen = configured_candidates[0]
                    arch_row["configuredGbSecond"] = chosen["price"]
                    row["_usageTypes"][f"configured.{arch}"] = chosen.get("usageType")
                if compute is None and compute_candidates:
                    chosen = compute_candidates[-1]
                    arch_row["computeGbSecond"] = chosen["price"]
                    row["_usageTypes"][f"compute.{arch}"] = chosen.get("usageType")
            if (arch_row.get("configuredGbSecond") is None or arch_row.get("computeGbSecond") is None) and len(unique) >= 2:
                # AWS publishes two separate Provisioned Concurrency GB-second
                # prices: configured capacity and execution duration.  Use the
                # relative order of API prices only when labels are ambiguous.
                low, high = unique[0], unique[-1]
                arch_row.setdefault("configuredGbSecond", low["price"])
                arch_row.setdefault("computeGbSecond", high["price"])
                row["_usageTypes"].setdefault(f"configured.{arch}", low.get("usageType"))
                row["_usageTypes"].setdefault(f"compute.{arch}", high.get("usageType"))
            elif len(unique) == 1:
                # One PC GB-second price is not enough to model the two AWS PC
                # meters truthfully; keep the region incomplete instead of
                # duplicating the value.
                pass

    for region, row in pc_regions.items():
        prefixes = [usage_prefix(row.get("_usageTypes", {}).get(f"compute.{a}"), ("ProvisionedConcurrency", "Lambda-Provisioned", "Lambda-PC")) for a in ARCHITECTURES]
        row["lambdaRequest"] = choose_request_price(row.get("_requestCandidates", []), [p for p in prefixes if p])
        if row.get("lambdaRequest") is None and region in regions:
            # AWS uses the same request meter for Provisioned Concurrency.  If
            # the Price List does not duplicate a PC-specific request SKU, reuse
            # the regional request price obtained from the AWS API above.
            row["lambdaRequest"] = regions[region].get("lambdaRequest")
        for term_key in ("1Year", "3Year"):
            row[f"configuredDiscount{term_key}"] = Decimal("1")
            row[f"computeDiscount{term_key}"] = Decimal("1")
        for arch in ARCHITECTURES:
            arch_row = row.get(arch)
            if not arch_row:
                continue
            arch_row.setdefault("configuredGbSecond", arch_row.get("computeGbSecond"))
            for term_key in ("1Year", "3Year"):
                configured_discount = discount_for_usage(
                    row.get("_usageTypes", {}).get(f"configured.{arch}"),
                    arch_row.get("configuredGbSecond"),
                    savings,
                    term_key,
                )
                if configured_discount != Decimal("1"):
                    row[f"configuredDiscount{term_key}"] = configured_discount
                if arch_row.get("computeGbSecond"):
                    compute_discount = discount_for_usage(
                        row.get("_usageTypes", {}).get(f"compute.{arch}"),
                        arch_row.get("computeGbSecond"),
                        savings,
                        term_key,
                    )
                    if compute_discount != Decimal("1"):
                        row[f"computeDiscount{term_key}"] = compute_discount

    def clean_on_demand() -> OrderedDict[str, Any]:
        out = OrderedDict()
        for region, row in sorted(regions.items()):
            if row.get("lambdaRequest") is not None and all(row.get(a) for a in ARCHITECTURES):
                out[region] = OrderedDict([
                    ("lambdaRequest", row["lambdaRequest"]),
                    ("x86", row["x86"]),
                    ("arm", row["arm"]),
                    ("durationDiscount1Year", row["durationDiscount1Year"]),
                    ("durationDiscount3Year", row["durationDiscount3Year"]),
                ])
        return out

    def clean_pc() -> OrderedDict[str, Any]:
        out = OrderedDict()
        for region, row in sorted(pc_regions.items()):
            if row.get("lambdaRequest") is not None:
                region_obj = OrderedDict()
                for arch in ARCHITECTURES:
                    arch_row = row.get(arch)
                    if arch_row and arch_row.get("configuredGbSecond") and arch_row.get("computeGbSecond"):
                        region_obj[arch] = OrderedDict([
                            ("configuredGbSecond", arch_row["configuredGbSecond"]),
                            ("computeGbSecond", arch_row["computeGbSecond"]),
                        ])
                if region_obj:
                    out[region] = OrderedDict([
                        ("lambdaRequest", row["lambdaRequest"]),
                        *region_obj.items(),
                        ("configuredDiscount1Year", row["configuredDiscount1Year"]),
                        ("configuredDiscount3Year", row["configuredDiscount3Year"]),
                        ("computeDiscount1Year", row["computeDiscount1Year"]),
                        ("computeDiscount3Year", row["computeDiscount3Year"]),
                    ])
        return out

    def clean_nested(data: dict[str, dict[str, Any]], required: tuple[str, ...]) -> OrderedDict[str, Any]:
        out = OrderedDict()
        for region, by_arch in sorted(data.items()):
            region_obj = OrderedDict()
            for arch in ARCHITECTURES:
                row = by_arch.get(arch)
                if row and set(required) <= set(row):
                    region_obj[arch] = OrderedDict((k, row[k]) for k in required)
            if region_obj:
                out[region] = region_obj
        return out

    durable_clean = OrderedDict((r, OrderedDict((k, row[k]) for k in ("operation", "dataWrittenGb", "dataRetainedGbMonth"))) for r, row in sorted(durable.items()) if {"operation", "dataWrittenGb", "dataRetainedGbMonth"} <= set(row))
    response_clean = OrderedDict((r, OrderedDict([("gb", row["gb"])])) for r, row in sorted(response.items()) if "gb" in row)
    esm_clean = OrderedDict()
    for r, by_source in sorted(esm.items()):
        obj = OrderedDict()
        for source, row in sorted(by_source.items()):
            if "epuHour" in row:
                obj[source] = OrderedDict([("epuHour", row["epuHour"])])
        if obj:
            esm_clean[r] = obj

    generated = OrderedDict([
        ("limitsGbSeconds", derive_limits(regions, "_rawTiers")),
        ("pricesPerRegionAndArchitecture", clean_on_demand()),
        ("provisionedConcurrencyPricesPerRegionAndArchitecture", clean_pc()),
        ("ephemeralStoragePricesPerRegionAndArchitecture", clean_nested(ephem, ("gbSecond",))),
        ("responseStreamingPricesPerRegion", response_clean),
        ("snapStartPricesPerRegionAndArchitecture", clean_nested(snap, ("cacheGbSecond", "restoreGb"))),
        ("tenantIsolationPricesPerRegionAndArchitecture", clean_nested(tenant, ("environmentGb",))),
        ("durableFunctionsPricesPerRegion", durable_clean),
        ("eventSourceMappingProvisionedModePricesPerRegionAndSourceType", esm_clean),
        # Managed Instances is added by build_managed_instances() below.
        ("managedInstancePricesPerRegionAndType", OrderedDict()),
        ("edgePrices", OrderedDict((k, edge[k]) for k in ("edgeRequest", "edge128MbSecond") if k in edge)),
    ])

    # Minimal hard failure for core Lambda; optional families are reported but not fabricated.
    if not generated["pricesPerRegionAndArchitecture"]:
        raise RuntimeError(f"No complete on-demand Lambda regions found. classified={dict(classified)}; samples={samples}")
    return generated



def arch_from_group_or_usage(group: str, usage_type: str) -> str:
    text = f"{group} {usage_type}".lower()
    return "arm" if re.search(r"(^|[-_ ])arm(64)?($|[-_ ])", text) or text.endswith("-arm") else "x86"


def first_dimension_price(product: dict[str, Any]) -> Decimal | None:
    prices = [canonical(d["price"]) for d in dimensions(product) if d.get("price", Decimal("0")) > 0]
    return min(prices) if prices else None


def merge_targeted_lambda_family_prices(session: boto3.Session, generated: OrderedDict[str, Any]) -> None:
    """Populate specialized Lambda families using exact AWSLambda group filters.

    The broad classifier is intentionally conservative and can miss current AWS
    group names such as AWS-Lambda-Processed-Bytes or
    AWS-Lambda-Durable-Execution-TimedStorage-ByteHrs.  This pass is fast: it
    performs one Price List Query API call per exact group and merges only API
    values into the generated variables.
    """
    pricing = session.client("pricing", region_name=PRICING_ENDPOINT_REGION)
    request_prices = {
        region: row.get("lambdaRequest")
        for region, row in (generated.get("pricesPerRegionAndArchitecture") or {}).items()
        if isinstance(row, dict) and row.get("lambdaRequest") is not None
    }

    pc: dict[str, dict[str, Any]] = defaultdict(lambda: {"_usageTypes": {}})
    response: dict[str, dict[str, Any]] = defaultdict(dict)
    durable: dict[str, dict[str, Any]] = defaultdict(dict)
    esm: dict[str, dict[str, dict[str, Any]]] = defaultdict(lambda: defaultdict(dict))

    for group in TARGETED_LAMBDA_GROUPS:
        filters = [{"Type": "TERM_MATCH", "Field": "group", "Value": group}]
        for product in get_products(pricing, AWS_LAMBDA_SERVICE_CODE, filters):
            attrs = product.get("product", {}).get("attributes", {})
            region = attrs.get("regionCode")
            usage_type = str(attrs.get("usagetype") or "")
            if not region:
                continue
            price = first_dimension_price(product)
            if price is None:
                continue
            arch = arch_from_group_or_usage(group, usage_type)

            if group == "AWS-Lambda-Provisioned-Concurrency":
                pc[region].setdefault(arch, OrderedDict())["configuredGbSecond"] = price
                pc[region]["_usageTypes"][f"configured.{arch}"] = usage_type
            elif group == "AWS-Lambda-Provisioned-Concurrency-ARM":
                pc[region].setdefault(arch, OrderedDict())["configuredGbSecond"] = price
                pc[region]["_usageTypes"][f"configured.{arch}"] = usage_type
            elif group == "AWS-Lambda-Duration-Provisioned":
                pc[region].setdefault(arch, OrderedDict())["computeGbSecond"] = price
                pc[region]["_usageTypes"][f"compute.{arch}"] = usage_type
            elif group == "AWS-Lambda-Duration-Provisioned-ARM":
                pc[region].setdefault(arch, OrderedDict())["computeGbSecond"] = price
                pc[region]["_usageTypes"][f"compute.{arch}"] = usage_type
            elif group.startswith("AWS-Lambda-Processed-Bytes"):
                # AWS currently publishes both x86 and ARM response-streaming
                # SKUs. The pricing model has a single regional streamed-GB
                # price, so keep the lowest API value if duplicates exist.
                previous = response[region].get("gb")
                response[region]["gb"] = price if previous is None else min(previous, price)
            elif group == "AWS-Lambda-Durable-Execution-Operations":
                durable[region]["operation"] = price
            elif group == "AWS-Lambda-Durable-Execution-Written-Bytes":
                durable[region]["dataWrittenGb"] = price
            elif group == "AWS-Lambda-Durable-Execution-TimedStorage-ByteHrs":
                durable[region]["dataRetainedGbMonth"] = price
            elif group == "AWS-Lambda-Event-Poller-Unit-Duration":
                esm[region]["kafka"]["epuHour"] = price
            elif group == "AWS-Lambda-SQS-Event-Poller-Unit-Duration":
                esm[region]["sqs"]["epuHour"] = price

    try:
        savings = lambda_savings_rates(session)
    except (BotoCoreError, ClientError) as exc:
        print(f"WARN: could not retrieve Lambda Savings Plans rates for targeted families: {exc}", file=sys.stderr)
        savings = {}

    pc_clean = OrderedDict()
    for region, row in sorted(pc.items()):
        if request_prices.get(region) is None:
            # The PC request add-on uses the Lambda request meter. If the core
            # generator did not find that regional request price, the region is
            # not complete enough for the pricing YAML.
            continue
        region_obj = OrderedDict([("lambdaRequest", request_prices[region])])
        for arch in ARCHITECTURES:
            arch_row = row.get(arch)
            if arch_row and {"configuredGbSecond", "computeGbSecond"} <= set(arch_row):
                region_obj[arch] = OrderedDict([
                    ("configuredGbSecond", arch_row["configuredGbSecond"]),
                    ("computeGbSecond", arch_row["computeGbSecond"]),
                ])
        if not any(arch in region_obj for arch in ARCHITECTURES):
            continue
        for term_key in ("1Year", "3Year"):
            configured_discount = Decimal("1")
            compute_discount = Decimal("1")
            for arch in ARCHITECTURES:
                arch_row = row.get(arch)
                if not arch_row:
                    continue
                candidate = discount_for_usage(row["_usageTypes"].get(f"configured.{arch}"), arch_row.get("configuredGbSecond"), savings, term_key)
                if candidate != Decimal("1"):
                    configured_discount = candidate
                candidate = discount_for_usage(row["_usageTypes"].get(f"compute.{arch}"), arch_row.get("computeGbSecond"), savings, term_key)
                if candidate != Decimal("1"):
                    compute_discount = candidate
            region_obj[f"configuredDiscount{term_key}"] = configured_discount
            region_obj[f"computeDiscount{term_key}"] = compute_discount
        pc_clean[region] = region_obj

    if pc_clean:
        generated["provisionedConcurrencyPricesPerRegionAndArchitecture"] = pc_clean
    if response:
        generated["responseStreamingPricesPerRegion"] = OrderedDict(
            (region, OrderedDict([("gb", row["gb"])]))
            for region, row in sorted(response.items())
            if "gb" in row
        )
    durable_clean = OrderedDict(
        (region, OrderedDict((key, row[key]) for key in ("operation", "dataWrittenGb", "dataRetainedGbMonth")))
        for region, row in sorted(durable.items())
        if {"operation", "dataWrittenGb", "dataRetainedGbMonth"} <= set(row)
    )
    if durable_clean:
        generated["durableFunctionsPricesPerRegion"] = durable_clean
    esm_clean = OrderedDict()
    for region, by_source in sorted(esm.items()):
        region_obj = OrderedDict()
        for source, row in sorted(by_source.items()):
            if "epuHour" in row:
                region_obj[source] = OrderedDict([("epuHour", row["epuHour"])])
        if region_obj:
            esm_clean[region] = region_obj
    if esm_clean:
        generated["eventSourceMappingProvisionedModePricesPerRegionAndSourceType"] = esm_clean


def parse_managed_instance_type(usage_type: str) -> str | None:
    match = re.search(r"Lambda-Managed-Instances-(?P<instance>.+)-Management-Hours$", usage_type)
    return match.group("instance") if match else None


def is_graviton_instance_type(instance_type: str) -> bool:
    family = instance_type.split(".", 1)[0]
    return bool(re.search(r"\d+g[a-z]*$", family))


def discover_managed_instances_from_lambda_api(session: boto3.Session, regions: set[str] | None = None) -> OrderedDict[str, Any]:
    """Discover Lambda Managed Instance request and management-fee prices.

    Managed Instance management-fee prices are AWSLambda products, not EC2
    products. This discovery scans AWSLambda Query API products and keeps only
    usage types with the Lambda-Managed-Instances prefix. No instance type is
    hardcoded; the returned instance types are exactly those published by AWS.
    """
    pricing = session.client("pricing", region_name=PRICING_ENDPOINT_REGION)
    by_region: dict[str, dict[str, Any]] = defaultdict(lambda: {
        "request_x86": None,
        "request_arm": None,
        "types": OrderedDict(),
    })

    for product in get_products(pricing, AWS_LAMBDA_SERVICE_CODE, []):
        attrs = product.get("product", {}).get("attributes", {})
        region = attrs.get("regionCode")
        if not region or (regions is not None and region not in regions):
            continue
        usage_type = str(attrs.get("usagetype") or "")
        if "Lambda-Managed-Instances" not in usage_type:
            continue
        price = first_dimension_price(product)
        if price is None:
            continue
        if re.search(r"Lambda-Managed-Instances-Request-ARM$", usage_type):
            by_region[region]["request_arm"] = price
            continue
        if re.search(r"Lambda-Managed-Instances-Request$", usage_type):
            by_region[region]["request_x86"] = price
            continue
        instance_type = parse_managed_instance_type(usage_type)
        if instance_type:
            by_region[region]["types"][instance_type] = OrderedDict([
                ("managementFeeHour", price),
                ("architecture", "arm" if is_graviton_instance_type(instance_type) else "x86"),
                ("usageType", usage_type),
            ])

    out = OrderedDict()
    for region, row in sorted(by_region.items()):
        region_types = OrderedDict()
        for instance_type, type_row in row["types"].items():
            request = row["request_arm"] if type_row["architecture"] == "arm" else row["request_x86"]
            if request is None:
                continue
            region_types[instance_type] = OrderedDict([
                ("request", request),
                ("managementFeeHour", type_row["managementFeeHour"]),
                ("architecture", type_row["architecture"]),
            ])
        if region_types:
            out[region] = region_types
    return out

def build_managed_instances(
    session: boto3.Session,
    managed_discovery: OrderedDict[str, Any],
    instance_types: list[str] | None = None,
) -> OrderedDict[str, Any]:
    """Add EC2 instance-hour prices to discovered Lambda Managed Instances.

    Lambda Managed Instance request and management-fee prices come from the
    AWSLambda Price List API discovery above. EC2 instance-hour prices and EC2
    Savings Plans multipliers come from EC2/Savings Plans APIs. If
    instance_types is empty, every instance type discovered from AWSLambda is
    attempted; no default instance type is injected.
    """
    if not managed_discovery:
        return OrderedDict()

    allowed_types = set(instance_types or [])
    wanted_types = sorted({
        instance_type
        for by_type in managed_discovery.values()
        for instance_type in by_type
        if not allowed_types or instance_type in allowed_types
    })
    if not wanted_types:
        return OrderedDict()

    pricing = session.client("pricing", region_name=PRICING_ENDPOINT_REGION)
    try:
        savings = ec2_savings_rates(session)
    except (BotoCoreError, ClientError) as exc:
        print(f"WARN: could not retrieve EC2 Savings Plans rates: {exc}", file=sys.stderr)
        savings = {}

    ec2_by_region_type: dict[str, dict[str, Any]] = defaultdict(dict)
    for instance_type in wanted_types:
        filters = [
            {"Type": "TERM_MATCH", "Field": "instanceType", "Value": instance_type},
            {"Type": "TERM_MATCH", "Field": "operatingSystem", "Value": "Linux"},
            {"Type": "TERM_MATCH", "Field": "tenancy", "Value": "Shared"},
            {"Type": "TERM_MATCH", "Field": "preInstalledSw", "Value": "NA"},
            {"Type": "TERM_MATCH", "Field": "capacitystatus", "Value": "Used"},
        ]
        for product in get_products(pricing, AWS_EC2_SERVICE_CODE, filters):
            attrs = product.get("product", {}).get("attributes", {})
            region = attrs.get("regionCode")
            usage_type = str(attrs.get("usagetype") or "")
            if not region or region not in managed_discovery or instance_type not in managed_discovery[region]:
                continue
            prices = extract_prices(
                dimensions(product),
                lambda d: "hrs" in normalize_unit(d.get("unit")) or "hour" in norm(d.get("description")),
            )
            if not prices:
                continue
            ec2_hour = min(prices)
            ec2_by_region_type[region][instance_type] = OrderedDict([
                ("ec2InstanceHour", ec2_hour),
                ("ec2SavingsPlan1Year", discount_from_savings_rate(ec2_hour, savings.get(usage_type, {}).get("1Year"))),
                ("ec2SavingsPlan3Year", discount_from_savings_rate(ec2_hour, savings.get(usage_type, {}).get("3Year"))),
            ])

    out: dict[str, dict[str, Any]] = defaultdict(dict)
    for region, by_type in managed_discovery.items():
        for instance_type, lambda_row in by_type.items():
            if allowed_types and instance_type not in allowed_types:
                continue
            ec2_row = ec2_by_region_type.get(region, {}).get(instance_type)
            if not ec2_row:
                continue
            out[region][instance_type] = OrderedDict([
                ("request", lambda_row["request"]),
                ("ec2InstanceHour", ec2_row["ec2InstanceHour"]),
                ("ec2SavingsPlan1Year", ec2_row["ec2SavingsPlan1Year"]),
                ("ec2SavingsPlan3Year", ec2_row["ec2SavingsPlan3Year"]),
                ("managementFeeHour", lambda_row["managementFeeHour"]),
            ])
    return OrderedDict((region, OrderedDict(sorted(by_type.items()))) for region, by_type in sorted(out.items()))




def empty_price_maps(generated: OrderedDict[str, Any]) -> list[str]:
    """Return generated price maps that are empty.

    Empty optional maps are allowed by default because AWS can omit newer or
    specialized Lambda families from the AWS Price List API response in some
    accounts/partitions. We never fill these maps from static constants.
    """
    map_keys = (
        "pricesPerRegionAndArchitecture",
        "provisionedConcurrencyPricesPerRegionAndArchitecture",
        "ephemeralStoragePricesPerRegionAndArchitecture",
        "responseStreamingPricesPerRegion",
        "snapStartPricesPerRegionAndArchitecture",
        "tenantIsolationPricesPerRegionAndArchitecture",
        "durableFunctionsPricesPerRegion",
        "eventSourceMappingProvisionedModePricesPerRegionAndSourceType",
        "managedInstancePricesPerRegionAndType",
        "edgePrices",
    )
    return [key for key in map_keys if not generated.get(key)]


def report_empty_price_maps(generated: OrderedDict[str, Any], strict_complete: bool) -> None:
    empty = empty_price_maps(generated)
    if not empty:
        return
    message = (
        "The following AWS Lambda price maps are empty because no matching "
        "prices were found in AWS APIs for this run: " + ", ".join(empty) + ". "
        "No fallback/static prices were used."
    )
    if strict_complete:
        raise RuntimeError(message)
    print(f"WARN: {message}", file=sys.stderr)


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
    parser = argparse.ArgumentParser(description="Generate expanded AWS Lambda pricing variables")
    parser.add_argument("--output", default=str(REFERENCE_YAML), help="Output YAML path, or '-' for stdout")
    parser.add_argument("--reference", default=None, help="Optional reference YAML to validate against")
    parser.add_argument("--managed-instance-type", action="append", default=[], help="Optional filter for Lambda Managed Instance EC2 instance types. If omitted, all instance types discovered from AWSLambda API are attempted.")
    parser.add_argument("--skip-managed-instances", action="store_true", help="Do not query EC2 prices for Managed Instances")
    parser.add_argument("--strict-complete", action="store_true", help="Fail if any generated price map referenced by the pricing YAML is empty. No fallback prices are ever emitted.")
    args = parser.parse_args()

    start = time.perf_counter()
    session = boto3.Session()
    generated = build_lambda_from_price_list(session)
    # Fast targeted pass for current Lambda families whose AWS Price List group
    # names are exact and should not require a slow bulk-offer scan.
    merge_targeted_lambda_family_prices(session, generated)

    if not args.skip_managed_instances:
        try:
            managed_regions = set(generated.get("pricesPerRegionAndArchitecture", {}).keys())
            managed_discovery = discover_managed_instances_from_lambda_api(session, managed_regions)
            generated["managedInstancePricesPerRegionAndType"] = build_managed_instances(
                session,
                managed_discovery,
                instance_types=args.managed_instance_type,
            )
            if args.managed_instance_type:
                print(
                    f"INFO: limited Managed Instances to requested instance types: {', '.join(args.managed_instance_type)}",
                    file=sys.stderr,
                )
            else:
                discovered_count = sum(len(v) for v in managed_discovery.values())
                print(f"INFO: discovered {discovered_count} Lambda Managed Instance region/type pairs from AWSLambda API.", file=sys.stderr)
        except (BotoCoreError, ClientError) as exc:
            print(f"WARN: could not retrieve Managed Instances prices from AWS APIs: {exc}", file=sys.stderr)
    if not generated["managedInstancePricesPerRegionAndType"]:
        print("WARN: managedInstancePricesPerRegionAndType is empty. No Lambda Managed Instance products with matching EC2 prices were found in AWS APIs.", file=sys.stderr)

    report_empty_price_maps(generated, strict_complete=args.strict_complete)

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
