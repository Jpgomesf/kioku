---
key: secrets-management
title: Where secrets live
aliases: [gestão de segredos, secrets]
related: [auth-tokens, local-dev-setup]
tags: [security]
confidence: 0.95
pinned: true
---

Production secrets live in AWS Secrets Manager; local development reads them
through 1Password Connect. Never commit .env files or paste credentials into
tickets. Rotate any secret that appears in a log immediately.
