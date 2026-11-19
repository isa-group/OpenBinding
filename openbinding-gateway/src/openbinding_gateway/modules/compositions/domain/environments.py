"""Composition environments: what names one and who may adopt in it. Pure.

An environment's ``slug`` is part of its feed's address, so it is fixed at creation and never changes (renaming
means a new environment). ``AdoptRole`` is the environment's adoption policy: the weakest organization role that
may adopt in it (plan §1 "política de adopción"; every adoption is a human action). An environment holds at most
``MAX_LIVE_FEED_KEYS`` live feed keys: two, so a key can be rotated without a gap.
"""

from __future__ import annotations

import enum
import re

#: A lower-case slug of 1 to 40 characters starting with a letter.
ENVIRONMENT_SLUG = re.compile(r"^[a-z][a-z0-9-]{0,39}$")
ENVIRONMENT_SLUG_PATTERN = ENVIRONMENT_SLUG.pattern

#: Live (unrevoked) feed keys an environment may hold at once: the key in use and its replacement.
MAX_LIVE_FEED_KEYS = 2

#: The ``expected_users`` bounds (and the ``users`` of margins).
MIN_USERS = 1
MAX_USERS = 1_000_000_000


class AdoptRole(str, enum.Enum):
    """The weakest role that may adopt a version in an environment."""

    MEMBER = "MEMBER"
    ADMIN = "ADMIN"
