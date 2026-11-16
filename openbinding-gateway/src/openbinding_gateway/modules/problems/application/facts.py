"""The facts of a compiled problem, as the screens read them (``composition.facts``).

One projection serves a stored compilation (``getProblemCompilationFacts``) and a draft package
(``validateBimPackage?include=facts``), so both answer the same facts for the same package.
"""

from __future__ import annotations

from typing import Any, Mapping

from ....composition.facts import facts_view
from ....composition.problem import ProblemFactsError
from ....models.errors import api_error

FACTS_UNREADABLE = "problem_facts_unreadable"


def compilation_facts(
    ir: Mapping[str, Any],
    source_map: Mapping[str, Any] | None,
    analysis: Mapping[str, Any],
    *,
    ir_digest: str,
) -> dict[str, Any]:
    """The facts of a compilation; 422 ``problem_facts_unreadable``, with the reason, when the IR cannot be read.

    ``analysis`` is the compilation's analysis summary (``analysis_summary``).
    """
    try:
        return facts_view(ir, source_map or None, analysis, ir_digest=ir_digest)
    except ProblemFactsError as error:
        raise api_error(
            422, FACTS_UNREADABLE, "The facts of this compiled problem cannot be read.", reason=str(error),
        ) from error
