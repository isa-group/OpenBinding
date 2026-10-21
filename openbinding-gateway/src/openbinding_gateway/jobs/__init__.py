"""Job lifecycle plumbing: leases, the reconciler and the concurrency limit.

Nothing here knows about plans or SPACE. A job is claimed by a worker under a
lease, kept alive by a heartbeat and put back or failed by the reconciler when
its worker is lost.
"""
