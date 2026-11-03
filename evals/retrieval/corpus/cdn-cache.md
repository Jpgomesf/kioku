---
key: cdn-cache
title: CDN caching for thumbnails
aliases: [CloudFront cache, cache da CDN]
related: [thumbnailer]
tags: [cdn, performance]
confidence: 0.85
---

CloudFront caches thumbnail responses for 30 days. The cache key includes the
width query parameter w. Purge a path with `twctl cdn purge /thumbs/<id>`;
full purges require approval from the platform lead.
