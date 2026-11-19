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


def test_the_access_log_of_a_sign_in_callback_has_no_query() -> None:
    import logging as std_logging

    from openbinding_gateway.core.logging import AuthQueryFilter, JsonFormatter

    record = std_logging.LogRecord(
        "uvicorn.access", std_logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
        ("10.0.0.1:1234", "GET", "/v1/auth/identity/callback?state=abc123&code=secret-code&iss=https%3A%2F%2Fx", "1.1", 303),
        None,
    )
    assert AuthQueryFilter().filter(record)
    line = JsonFormatter().format(record)
    assert "/v1/auth/identity/callback" in line
    for value in ("abc123", "secret-code", "iss="):
        assert value not in line
    other = std_logging.LogRecord(
        "uvicorn.access", std_logging.INFO, __file__, 1, '%s - "%s %s HTTP/%s" %d',
        ("10.0.0.1:1234", "GET", "/v1/compositions?page=2", "1.1", 200), None,
    )
    AuthQueryFilter().filter(other)
    assert "page=2" in JsonFormatter().format(other)


def test_oauth_query_parameters_are_redacted_and_closed_codes_kept() -> None:
    from openbinding_gateway.core.logging import redact

    text = redact("GET https://x/cb?state=abcdef&code=the-code&session_state=s1 failed code=signin_failed")
    assert "abcdef" not in text and "the-code" not in text and "s1 " not in text
    assert "code=signin_failed" in text


def test_configure_logging_installs_the_access_filter_once() -> None:
    import logging as std_logging

    from openbinding_gateway.core.logging import AuthQueryFilter, configure_logging

    configure_logging()
    configure_logging()
    filters = [f for f in std_logging.getLogger("uvicorn.access").filters if isinstance(f, AuthQueryFilter)]
    assert len(filters) == 1
