---
key: local-stack
title: Local development services
domain: demo
aliases:
  - ambiente local
  - development stack
related:
  - jobs-worker
  - batch-worker-retirement
tags:
  - development
  - architecture
confidence: 0.95
pinned: true
---

This is fictional example knowledge for testing retrieval in the `demo` domain.

The development stack uses PostgreSQL as the source of truth for documents,
aliases, explicit relationships, and feedback. Qdrant stores document vectors
for similarity search. A Rust service joins search results with the canonical
PostgreSQL records and ranks the related notes.

Only loopback ports are published. Stopping containers preserves their named
volumes. The jobs-worker handles background indexing and replaces the old
batch-worker. See the retirement record before following historical runbooks.

For a question about a service, retrieve its focused note and related records
before reading an entire architecture folder.
