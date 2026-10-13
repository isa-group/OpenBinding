"""Platform-side pieces that sit next to the BIM v1 language.

The language itself (loading, compiling and evaluating packages, the engine protocol) lives in
``bim-toolchain`` and is reached through ``integrations.bim``. What remains here is the
platform's: ``remote`` (the bounded, SSRF-safe transport to registered engines) and ``archive``
(the analysis archive of binding solutions).
"""
