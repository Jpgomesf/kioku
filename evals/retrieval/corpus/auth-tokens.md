---
key: auth-tokens
title: Service-to-service authentication tokens
aliases: [JWT de serviço, internal auth]
related: [secrets-management]
tags: [security, auth]
confidence: 0.9
---

Internal services authenticate with JWTs that expire after 15 minutes, signed
by the tw-issuer service. Signing keys rotate every quarter; the previous key
stays valid for 24 hours after a rotation so in-flight tokens keep working.
