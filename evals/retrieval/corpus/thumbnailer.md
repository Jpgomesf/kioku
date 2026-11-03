---
key: thumbnailer
title: Thumbnailer generates WebP previews
aliases: [thumbnail worker, gerador de miniaturas]
related: [media-queue, cdn-cache, imgproc-retirement]
tags: [service, images]
confidence: 0.9
---

The thumbnailer is a Rust worker that consumes media.uploaded events and
renders 320 px and 1280 px WebP previews with libvips. It replaced the Python
imgproc worker in March 2025. Restart it with `twctl restart thumbnailer`; it
is stateless and safe to restart at any time.
