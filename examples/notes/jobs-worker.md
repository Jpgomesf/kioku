---
key: jobs-worker
title: Jobs worker owns background indexing
domain: demo
aliases:
  - indexing worker
  - worker de indexação
  - serviço de jobs
related:
  - local-stack
  - batch-worker-retirement
tags:
  - service
  - indexing
confidence: 0.9
pinned: false
---

This is fictional example knowledge for testing retrieval in the `demo` domain.

The jobs-worker is the current owner of background document indexing. It reads
approved Markdown notes, extracts aliases and related links, requests embeddings,
and updates the search index. PostgreSQL remains the canonical store.

O jobs-worker substituiu o batch-worker. Para investigar uma indexação atrasada,
verifique primeiro a fila de jobs e a disponibilidade do serviço de embeddings.
Não reinicie o serviço antigo: ele foi desativado.

An indexing retry must be idempotent. Reprocessing the same note key should
update its existing record instead of creating a duplicate.
