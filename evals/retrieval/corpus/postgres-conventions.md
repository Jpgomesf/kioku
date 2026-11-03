---
key: postgres-conventions
title: PostgreSQL schema conventions
aliases: [convenções do banco, database conventions]
related: [local-dev-setup, timezone-convention]
tags: [database, conventions]
confidence: 0.9
---

Schema changes go through sqlx migrations; never edit a migration that has
already been applied anywhere. Table names are plural snake_case, and every
table has created_at and updated_at columns of type timestamptz.
