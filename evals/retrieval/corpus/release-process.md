---
key: release-process
title: Weekly release process
aliases: [processo de release, deploy schedule]
related: [code-review-guidelines, feature-flags]
tags: [process, releases]
confidence: 0.9
---

Releases are cut from main every Tuesday at 14:00 UTC and tagged vYYYY.MM.DD.
A release needs green CI and approval from the release captain. Hotfixes
branch from the latest tag and are merged back into main afterwards.
