"""Search text turned into a LIKE pattern that means what the user typed.

``%`` and ``_`` are wildcards in LIKE, so search text must be escaped before it
is put between the surrounding ``%``. Every query that uses the pattern passes
``escape=LIKE_ESCAPE`` to ``like``/``ilike``.
"""

from __future__ import annotations

LIKE_ESCAPE = "\\"


def like_contains(text: str) -> str:
    """Pattern matching rows that contain ``text`` literally."""
    escaped = (
        text.replace(LIKE_ESCAPE, LIKE_ESCAPE * 2)
        .replace("%", LIKE_ESCAPE + "%")
        .replace("_", LIKE_ESCAPE + "_")
    )
    return f"%{escaped}%"
