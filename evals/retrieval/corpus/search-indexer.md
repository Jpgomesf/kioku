---
key: search-indexer
title: Search indexing uses the media-v3 index
aliases: [indexador de busca, OpenSearch indexer]
related: [media-v2-retirement]
tags: [search, service]
confidence: 0.9
---

The search-indexer writes media documents to the OpenSearch index media-v3.
The alias media always points to the current index, and a full reindex runs
nightly at 02:00 UTC.
