from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path
from typing import Any, Iterable


ID_PATTERN = re.compile(r"[^A-Za-z0-9_.-]+")


def safe_id(value: Any, *, fallback: str = "id") -> str:
    text = str(value).strip()
    text = ID_PATTERN.sub("_", text)
    text = re.sub(r"_+", "_", text).strip("_.-")
    return text or fallback


def stable_hash(*parts: Any, length: int = 12) -> str:
    h = hashlib.sha256()
    for part in parts:
        h.update(str(part).encode("utf-8"))
        h.update(b"\0")
    return h.hexdigest()[:length]


def stable_unit_float(*parts: Any) -> float:
    raw = int(stable_hash(*parts, length=16), 16)
    return raw / float(16**16 - 1)


def seeded_uniform(low: float, high: float, *seed_parts: Any) -> float:
    if high < low:
        low, high = high, low
    return low + (high - low) * stable_unit_float(*seed_parts)


def load_json(path: str | Path) -> Any:
    return json.loads(Path(path).read_text(encoding="utf-8"))


def write_json(path: str | Path, data: Any) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(data, indent=2, sort_keys=False), encoding="utf-8")


def parse_number(value: Any, *, inf_value: float = 1_000_000_000.0) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    text = str(value).strip().lower()
    if text in {"inf", "infinity", "+inf"}:
        return inf_value
    return float(text)


def unique_sorted(values: Iterable[str]) -> list[str]:
    return sorted(set(values))


def is_near_region(region: str) -> bool:
    text = region.lower()
    return text.startswith("eu") or text.startswith("europe") or "west europe" in text or text == "westeurope"


def trigger_event(trigger: str) -> str:
    event = trigger.split(",", 1)[0].strip()
    # The dataset uses both event02 and event2 for the same event family.
    return re.sub(r"event0+(\d+)$", r"event\1", event)


def trigger_labels(trigger: str) -> list[str]:
    if "[" not in trigger or "]" not in trigger:
        return []
    inner = trigger.split("[", 1)[1].split("]", 1)[0]
    return [part.strip().lower() for part in inner.split(",") if part.strip()]
