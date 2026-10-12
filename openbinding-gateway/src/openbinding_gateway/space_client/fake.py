"""Retired: the in-memory SPACE substitute now lives in the test suite only (tests/_fake_space.py).

Production code builds the real gate, or the stateless open gate when
``SPACE_ENABLED=false`` outside production (see ``space_client.build_gate``).
This module is intentionally empty and can be deleted.
"""
