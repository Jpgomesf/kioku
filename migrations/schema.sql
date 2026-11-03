-- PostgreSQL is the source of truth. Qdrant is a rebuildable search index.
CREATE TABLE IF NOT EXISTS memory_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS memory_notes (
    id UUID PRIMARY KEY,
    domain TEXT NOT NULL,
    note_key TEXT NOT NULL,
    input JSONB NOT NULL,
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'legacy')),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    last_accessed_at TIMESTAMPTZ,
    access_count BIGINT NOT NULL DEFAULT 0 CHECK (access_count >= 0),
    positive_feedback BIGINT NOT NULL DEFAULT 0 CHECK (positive_feedback >= 0),
    negative_feedback BIGINT NOT NULL DEFAULT 0 CHECK (negative_feedback >= 0),
    retention_score DOUBLE PRECISION NOT NULL DEFAULT 0.8 CHECK (retention_score >= 0 AND retention_score <= 1),
    last_decay_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    vector_synced BOOLEAN NOT NULL DEFAULT false,
    revision BIGINT NOT NULL DEFAULT 1 CHECK (revision >= 1),
    UNIQUE (domain, note_key)
);
CREATE INDEX IF NOT EXISTS memory_notes_domain_status ON memory_notes(domain, status);
CREATE INDEX IF NOT EXISTS memory_notes_unsynced ON memory_notes(id) WHERE NOT vector_synced;

CREATE TABLE IF NOT EXISTS memory_edges (
    source UUID NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    target UUID NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    weight DOUBLE PRECISION NOT NULL CHECK (weight > 0 AND weight <= 100),
    PRIMARY KEY(source, target, kind),
    CHECK (source <> target)
);
CREATE INDEX IF NOT EXISTS memory_edges_target ON memory_edges(target);

CREATE TABLE IF NOT EXISTS memory_feedback (
    request_id TEXT PRIMARY KEY,
    note_id UUID NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    positive BOOLEAN NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_feedback_note ON memory_feedback(note_id);
