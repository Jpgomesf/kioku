---
key: rate-limits
title: Public API rate limits
aliases: [limites de requisições, throttling]
related: [error-codes]
tags: [api, limits]
confidence: 0.9
---

Each API key may send 600 requests per minute with bursts of up to 100.
Exceeding the limit returns HTTP 429 with error TW-4290 and a Retry-After
header. Internal service tokens are exempt.
