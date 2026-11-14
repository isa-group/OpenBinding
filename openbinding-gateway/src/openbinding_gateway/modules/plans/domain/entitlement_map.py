"""The entitlement ids of pricing 0.2.0, spelled once.

Every feature and limit the gateway reads from a plan is named here and nowhere
else (``tests/test_entitlement_map.py`` scans for string ids passed to
``caps.limit``, ``caps.allows`` and ``feature_refusal`` elsewhere). The
frontend mirrors the ids in ``frontend/src/utils/limits.ts``.

Ids the published 0.2.0 YAML declares but the gateway does not enforce
(``solverHours``, ``generator``, ``generatedInstances``,
``maxInstancesPerGeneration``, ``collaboration``, ``maxCollections`` and
``maxPrivateProjects``) are not listed, so the startup check does not require
them.

Units: ``maxRunMinutes`` is minutes (``x 60 000`` for ``time_budget_ms``);
``maxRepositoryStorage`` is MB, and one MB is 10**6 bytes.
"""

from __future__ import annotations

from typing import Any, Mapping

# -- features ----------------------------------------------------------------

#: Run problem revisions on the built-in engines.
RUNS = "runs"
#: Register federated engines and run problems on them.
FEDERATED_ENGINES = "federatedEngines"
#: Comparative studies.
STUDIES = "studies"
#: Upload and version problems.
REPOSITORY = "repository"
#: Use the API with API keys.
API_ACCESS = "apiAccess"

REQUIRED_FEATURES: tuple[str, ...] = (RUNS, FEDERATED_ENGINES, STUDIES, REPOSITORY, API_ACCESS)

# -- limits (all valueType NUMERIC) ------------------------------------------

#: Largest time budget of one run, in minutes.
MAX_RUN_MINUTES = "maxRunMinutes"
#: Runs of one account executing at the same time.
MAX_CONCURRENT_RUNS = "maxConcurrentRuns"
#: Cells in one study run (the lower of this and ``MAX_CELLS_PER_STUDY_RUN`` applies).
MAX_STUDY_CELLS = "maxStudyCells"
#: Active federated engine registrations of the account.
MAX_FEDERATED_ENGINES = "maxFederatedEngines"
#: Active API keys of the account.
MAX_API_KEYS = "maxApiKeys"
#: Problems the account owns.
MAX_PROBLEMS = "maxProblems"
#: Stored size of the account's problem revisions, in MB.
MAX_REPOSITORY_STORAGE = "maxRepositoryStorage"

REQUIRED_LIMITS: tuple[str, ...] = (
    MAX_RUN_MINUTES,
    MAX_CONCURRENT_RUNS,
    MAX_STUDY_CELLS,
    MAX_FEDERATED_ENGINES,
    MAX_API_KEYS,
    MAX_PROBLEMS,
    MAX_REPOSITORY_STORAGE,
)

#: Units the refusals report, by limit id.
LIMIT_UNITS: Mapping[str, str] = {
    MAX_RUN_MINUTES: "minute",
    MAX_CONCURRENT_RUNS: "run",
    MAX_STUDY_CELLS: "cell",
    MAX_FEDERATED_ENGINES: "engine",
    MAX_API_KEYS: "key",
    MAX_PROBLEMS: "problem",
    MAX_REPOSITORY_STORAGE: "MB",
}

MILLISECONDS_PER_MINUTE = 60_000
#: One MB of ``maxRepositoryStorage`` (decimal, as the pricing's unit says).
BYTES_PER_MB = 10**6


def run_minutes_to_ms(minutes: float) -> float:
    """``maxRunMinutes`` as a ``time_budget_ms`` ceiling."""
    return minutes * MILLISECONDS_PER_MINUTE


def run_minutes_to_seconds(minutes: float) -> float:
    """``maxRunMinutes`` as a wall-clock wait, in seconds."""
    return minutes * 60


def storage_mb_to_bytes(megabytes: float) -> float:
    """``maxRepositoryStorage`` in bytes (MB = 10**6 bytes)."""
    return megabytes * BYTES_PER_MB


def missing_ids(pricing_document: Any) -> list[str]:
    """The required ids ``pricing_document`` (a parsed Pricing2Yaml) lacks; empty when it has them all.

    A limit must also be ``valueType: NUMERIC``. Each entry names the id and
    what is wrong with it, in the order of ``REQUIRED_FEATURES`` then
    ``REQUIRED_LIMITS``.
    """
    document = pricing_document if isinstance(pricing_document, Mapping) else {}
    features = document.get("features")
    features = features if isinstance(features, Mapping) else {}
    limits = document.get("usageLimits")
    limits = limits if isinstance(limits, Mapping) else {}
    missing = [f"feature {name}" for name in REQUIRED_FEATURES if name not in features]
    for name in REQUIRED_LIMITS:
        declaration = limits.get(name)
        if declaration is None:
            missing.append(f"usageLimit {name}")
        elif not isinstance(declaration, Mapping) or declaration.get("valueType") != "NUMERIC":
            missing.append(f"usageLimit {name} (valueType NUMERIC)")
    return missing
