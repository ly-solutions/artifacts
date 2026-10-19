# Search service architecture

How catalog search works today, and the two changes proposed for next quarter.

## Overview

Queries arrive at the **search gateway**, which fans out to the text index and the ranking service and merges the results.

| Component | Language | Owner | p95 |
|---|---|---|---:|
| Search gateway | Go | Platform | 42 ms |
| Text index | Rust | Search | 18 ms |
| Ranking service | Python | Relevance | 31 ms |

## Request flow

1. The gateway normalises the query and checks the cache (hit rate 61%).
2. On a miss it queries the index for 200 candidates.
3. Ranking re-scores the candidates with the user's context.
4. The gateway returns the top 20 and writes the cache entry.

```yaml
search:
  candidates: 200
  cache_ttl: 5m
  ranking_timeout: 80ms
```

## Proposed changes

- [x] Move synonym expansion from the gateway into the index.
- [ ] Return partial results when ranking times out instead of failing the request.

> Partial results trade a little relevance for availability. We think that is the right trade for search; it is not for checkout.
