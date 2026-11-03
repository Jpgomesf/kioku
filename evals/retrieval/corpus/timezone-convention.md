---
key: timezone-convention
title: Timestamps are stored in UTC
aliases: [fuso horário, time zones]
related: [postgres-conventions]
tags: [conventions]
confidence: 0.9
---

Store every timestamp in UTC and convert to the user's time zone only for
display. Cron schedules and log timestamps also use UTC.
