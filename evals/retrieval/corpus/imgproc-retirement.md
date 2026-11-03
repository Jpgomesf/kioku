---
key: imgproc-retirement
title: The imgproc worker was retired in March 2025
aliases: [imgproc retirement, aposentadoria do imgproc]
related: [thumbnailer, imgproc-runbook]
tags: [historical, migration]
confidence: 0.95
---

The Python imgproc worker and its Redis job list were decommissioned in March
2025 when the thumbnailer took over thumbnail generation. Do not restart
imgproc; the media-01 host no longer runs it. Its runbook is kept only as
history.
