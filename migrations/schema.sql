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

-- Append-only history: every write that changes a note's content or status
-- adds a row in the same transaction, so overwritten text stays recoverable.
-- Rows go away only with their note. `revision` is the note's content
-- revision; a status change appends a row at the same revision.
CREATE TABLE IF NOT EXISTS memory_note_revisions (
    id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    note_id UUID NOT NULL REFERENCES memory_notes(id) ON DELETE CASCADE,
    revision BIGINT NOT NULL CHECK (revision >= 1),
    input JSONB NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'legacy')),
    written_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS memory_note_revisions_note ON memory_note_revisions(note_id, id DESC);

-- Notes saved before history existed start it with their current revision,
-- and writes by an older binary that kept no history are caught up. Neither
-- time is known exactly; the latest edit time is the best bound.
INSERT INTO memory_note_revisions(note_id, revision, input, status, written_at)
SELECT n.id, n.revision, n.input, n.status, GREATEST(n.updated_at, latest.written_at)
FROM memory_notes n
LEFT JOIN LATERAL (
    SELECT r.revision, r.status, r.written_at FROM memory_note_revisions r
    WHERE r.note_id = n.id ORDER BY r.id DESC LIMIT 1
) latest ON true
WHERE latest.revision IS DISTINCT FROM n.revision OR latest.status IS DISTINCT FROM n.status;

-- The code map: what each source file of a repository is for and what it
-- defines, for small models that read code. Its own layer: no vectors, so note
-- search never sees it. `domain` is where the repository's folder is placed,
-- so vault rules apply as they do to notes. `repo` names the repository by
-- its remote, else its folder.
CREATE TABLE IF NOT EXISTS code_repos (
    domain TEXT NOT NULL,
    repo TEXT NOT NULL,
    root TEXT NOT NULL,
    indexed_commit TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, repo)
);

CREATE TABLE IF NOT EXISTS code_files (
    domain TEXT NOT NULL,
    repo TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    digest TEXT NOT NULL,
    purpose TEXT,
    purpose_source TEXT CHECK (purpose_source IN ('doc', 'model')),
    symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
    imports TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, repo, path),
    FOREIGN KEY (domain, repo) REFERENCES code_repos(domain, repo) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS code_files_imports ON code_files USING GIN (imports);
