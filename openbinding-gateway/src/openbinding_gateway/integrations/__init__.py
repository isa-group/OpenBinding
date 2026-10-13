"""Stable boundaries to infrastructure the gateway does not own.

Nothing here imports routes, services, jobs, domain or the database: the rest of the
gateway depends on this package, never the other way round
(``tests/test_architecture_layers.py``).
"""
