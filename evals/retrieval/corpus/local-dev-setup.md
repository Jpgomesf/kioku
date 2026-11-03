---
key: local-dev-setup
title: Local development environment
aliases: [ambiente local, dev setup]
related: [secrets-management, postgres-conventions]
tags: [development]
confidence: 0.9
---

`make dev` starts PostgreSQL 17 on port 5433, NATS on 4222, and MinIO on 9000
with Docker Compose. Load fixture data with `make seed`. All services bind to
localhost only.
