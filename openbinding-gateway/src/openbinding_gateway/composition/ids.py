"""The identifier patterns a composition shares with the container.

A Composition2Yaml document names tasks, properties and candidates by the ids of the
problem it describes, so it accepts exactly the ids the container accepts: the patterns
below are the container's own, not a convention of this package.
"""

from __future__ import annotations

import re

#: Task, feature and candidate ids; the container's own pattern for a map key.
SYMBOL = re.compile(r"^[A-Za-z][A-Za-z0-9_.-]{0,127}$")
#: Document names; the container's own pattern for ``metadata.name``.
NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$")
