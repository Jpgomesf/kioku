---
key: dead-letter-policy
title: Dead-letter handling for media events
aliases: [DLQ policy, fila de mensagens mortas]
related: [media-queue, oncall-rotation]
tags: [messaging, operations]
confidence: 0.85
---

Messages that exhaust their five delivery attempts move to the MEDIA_DLQ
stream. The on-call engineer reviews MEDIA_DLQ every weekday at 09:00 UTC and
replays fixed messages with `twctl dlq replay --stream MEDIA`. Never purge
MEDIA_DLQ without a ticket.
