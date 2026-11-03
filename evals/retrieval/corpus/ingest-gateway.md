---
key: ingest-gateway
title: Ingest gateway accepts uploads
aliases: [upload API, gateway de upload]
related: [media-queue, mobile-upload-limits, error-codes]
tags: [service, uploads]
confidence: 0.9
---

The ingest-gateway service is the only public entry point for media uploads.
It rejects files larger than 50 MB with error TW-4091, stores accepted
originals in the object storage bucket tw-raw, and publishes a media.uploaded
event for downstream processing.
