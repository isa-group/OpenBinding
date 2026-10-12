# bim-client

`bim_client.port.BimPort` is the interface a host uses to reach BIM, and it has two implementations with the
same methods, the same return values and the same errors:

* `InProcessBim` calls [`bim_core`](../bim-core) directly;
* `HttpBim` calls a [`bim-service`](../bim-service) with `httpx` and turns `application/problem+json` back
  into the `bim_core` errors (`CompileError`, `ContractError`, ...) with their `code` and `diagnostics`.

```python
from bim_client import HttpBim, InProcessBim

bim = InProcessBim()                      # or HttpBim("https://bim.internal", token_file="/run/secrets/bim_token")
result = bim.compile(open("demo.bim.zip", "rb").read())
print(result["irDigest"], result["analysis"]["bindingSpaceLog10"])
```

See [`docs/CLIENT.md`](../../docs/CLIENT.md) for the contract, the reasons for this boundary and the (few)
differences between the two implementations. License: undecided, see [`NOTICE.md`](../../NOTICE.md).
