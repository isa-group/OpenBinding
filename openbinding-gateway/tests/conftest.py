"""Shared setup for the gateway unit tests.

Every test needs the gateway to find the repository's schemas, and several
need the same small placement instance. Both used to be repeated per module -
the schema bootstrap in five files, and the instance through a sys.path hack
that imported a helper out of another test module.
"""

from __future__ import annotations

import os

import pytest

REPO_ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))

# Set before anything imports the gateway: schema paths are resolved when the
# validators are constructed.
os.environ.setdefault(
    "GENERAL_SCHEMA_PATH", os.path.join(REPO_ROOT, "schemas", "general", "schema.json")
)
os.environ.setdefault("SCHEMAS_DIR", os.path.join(REPO_ROOT, "schemas"))


@pytest.fixture
def micro_placement_instance():
    """The shared placement instance, for tests that prefer injection."""
    from _fixtures import micro_instance

    return micro_instance()
