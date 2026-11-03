---
key: imgproc-runbook
title: Restarting the imgproc worker
aliases: [imgproc, old thumbnail worker]
related: [imgproc-retirement]
tags: [runbook, historical]
confidence: 0.7
---

To restart the imgproc thumbnail worker, SSH to media-01 and run
`sudo systemctl restart imgproc`. It reads jobs from the Redis list
thumbs:pending. If the list grows past 10,000 entries, scale workers with
`imgproc-scale 4`.
