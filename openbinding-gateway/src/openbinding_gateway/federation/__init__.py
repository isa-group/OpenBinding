"""Reaching engines the gateway does not host.

Three concerns, kept apart because they fail differently: ``ssrf`` decides
whether a URL may be fetched at all, ``transport`` turns a logical operation
into an HTTP request, and the federated plugin in
``validation.engine_plugins.federated`` translates between the general shapes
and a third party's own.
"""
