from __future__ import annotations

import json
import logging

from openbinding_gateway.core.logging import JsonFormatter, redact


def test_structured_logs_are_json_and_redact_credentials() -> None:
    formatter = JsonFormatter(["configured-sphere-secret"])
    record = logging.LogRecord(
        "openbinding.test",
        logging.WARNING,
        __file__,
        1,
        "Authorization: Bearer jwt-value x-api-key=header-value key=%s configured-sphere-secret",
        ("obk_prefix_private",),
        None,
    )

    document = json.loads(formatter.format(record))

    assert document["level"] == "WARNING"
    assert document["logger"] == "openbinding.test"
    assert document["timestamp"].endswith("+00:00")
    assert document["message"].count("[REDACTED]") >= 4
    for secret in ("jwt-value", "header-value", "obk_prefix_private", "configured-sphere-secret"):
        assert secret not in document["message"]


def test_redaction_leaves_non_secret_operational_context_intact() -> None:
    assert redact("job 42 completed in 3 ms") == "job 42 completed in 3 ms"
