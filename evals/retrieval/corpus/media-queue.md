---
key: media-queue
title: Media events flow through the MEDIA JetStream stream
aliases: [media stream, fila de mídia]
related: [ingest-gateway, thumbnailer, dead-letter-policy]
tags: [messaging, nats]
confidence: 0.9
---

Media events use the NATS JetStream stream MEDIA with seven days of retention.
Consumers must acknowledge a message within 30 seconds; JetStream redelivers
unacknowledged messages up to five times (max_deliver = 5).
