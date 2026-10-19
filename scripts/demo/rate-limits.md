# API rate limits proposal

Per-token limits replace the global limit, so one noisy integration cannot slow everyone else down.

| Plan | Requests / minute | Burst |
|---|---:|---:|
| Free | 60 | 20 |
| Team | 600 | 100 |
| Enterprise | 6 000 | 1 000 |

Responses carry `RateLimit-Remaining` and `RateLimit-Reset`; a `429` includes `Retry-After`.
