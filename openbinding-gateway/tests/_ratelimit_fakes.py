"""Stand-ins for Redis, for the tests of the rate limiters."""

from __future__ import annotations


class FakePipeline:
    def __init__(self, redis):
        self.redis, self.operations = redis, []

    def incr(self, key, amount=1):
        self.operations.append(("incr", key, amount))

    def ttl(self, key):
        self.operations.append(("ttl", key, None))

    async def execute(self):
        results = []
        for operation, key, amount in self.operations:
            if operation == "incr":
                self.redis.counts[key] = self.redis.counts.get(key, 0) + amount
                results.append(self.redis.counts[key])
            else:
                results.append(self.redis.ttls.get(key, -1))
        return results


class FakeRedis:
    """Just enough of redis.asyncio for INCR + TTL + EXPIRE."""

    def __init__(self):
        self.counts: dict[str, int] = {}
        self.ttls: dict[str, int] = {}
        self.expirations: list[tuple[str, int]] = []

    def pipeline(self, transaction=True):
        return FakePipeline(self)

    async def expire(self, key, seconds):
        self.ttls[key] = seconds
        self.expirations.append((key, seconds))


class DownBackend:
    async def hit(self, key, window_s, cost=1):
        raise ConnectionError("redis is down")
