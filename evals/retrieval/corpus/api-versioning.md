---
key: api-versioning
title: API versioning and v1 sunset
aliases: [versionamento da API, deprecation policy]
related: [error-codes]
tags: [api]
confidence: 0.9
---

The public API is versioned in the URL path (/v2/). Version v1 is sunset on
2026-06-30; until then v1 responses carry a Sunset header and a Deprecation
header that links to the migration guide.
