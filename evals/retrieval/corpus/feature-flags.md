---
key: feature-flags
title: Feature flag conventions
aliases: [flags, sinalizadores de funcionalidade]
related: [release-process]
tags: [process, flags]
confidence: 0.8
---

Feature flags live in Unleash and are named team.feature.variant. A flag that
has served 100% of traffic for 30 days must be removed from the code in the
next sprint.
