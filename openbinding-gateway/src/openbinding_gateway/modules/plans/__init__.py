"""Plans: what pricing 0.2.0 entitles an account to, and the per-account quotas.

``domain/entitlement_map.py`` is the only place entitlement ids are spelled.
``pricing/openbinding-0.2.0.yml`` is a byte copy of the published pricing
(``docs/pricing/openbinding-0.2.0.yml``), shipped as package data so the image,
which copies only ``src/``, can check it at startup without SPACE.
"""
