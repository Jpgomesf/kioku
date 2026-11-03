---
key: mobile-upload-limits
title: Mobile clients compress video before upload
aliases: [compressão no app móvel]
related: [ingest-gateway]
tags: [mobile, uploads]
confidence: 0.8
---

The iOS and Android apps transcode videos to 720p H.264 before uploading so
typical clips stay under the gateway size limit. Uploads that still exceed the
limit show a "file too large" dialog instead of retrying.
