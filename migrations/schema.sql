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

-- Search caches. Each server process keeps an index of every domain it has
-- searched, and checks per search whether the domain changed since. Every write
-- to a domain's notes or links bumps the domain's versions below, from
-- triggers, so writes by any process or version of Kioku count. A note that
-- moves to another domain counts as deleted from its old one, and TRUNCATE
-- counts as a deletion in every domain. Each note also records the
-- transaction that last wrote it, so a cache reloads only the notes written
-- since its snapshot. Needs PostgreSQL 13 or later.
--
-- This file runs whenever a process starts, so the column and triggers are
-- created only when missing: ALTER TABLE and CREATE TRIGGER lock the table even
-- when they would change nothing.
CREATE TABLE IF NOT EXISTS memory_search_versions (
    domain TEXT PRIMARY KEY,
    notes BIGINT NOT NULL DEFAULT 0,
    links BIGINT NOT NULL DEFAULT 0,
    deletes BIGINT NOT NULL DEFAULT 0
);

CREATE OR REPLACE FUNCTION memory_notes_stamp() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    NEW.written_by := pg_current_xact_id();
    RETURN NEW;
END $$;

CREATE OR REPLACE FUNCTION memory_notes_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO memory_search_versions AS v (domain, notes, deletes)
    SELECT DISTINCT domain, 1, CASE WHEN TG_OP = 'DELETE' THEN 1 ELSE 0 END FROM changed ORDER BY domain
    ON CONFLICT (domain) DO UPDATE SET notes = v.notes + 1, deletes = v.deletes + EXCLUDED.deletes;
    RETURN NULL;
END $$;

-- An updated note bumps its domain; one that left a domain (or took another
-- id) is gone from that domain as if deleted.
CREATE OR REPLACE FUNCTION memory_notes_updated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO memory_search_versions AS v (domain, notes, deletes)
    SELECT domain, 1, max(gone) FROM (
        SELECT domain, 0 AS gone FROM changed
        UNION ALL
        SELECT o.domain, 1 FROM old_notes o
        WHERE NOT EXISTS (SELECT 1 FROM changed c WHERE c.id = o.id AND c.domain = o.domain)
    ) bumped GROUP BY domain ORDER BY domain
    ON CONFLICT (domain) DO UPDATE SET notes = v.notes + 1, deletes = v.deletes + EXCLUDED.deletes;
    RETURN NULL;
END $$;

CREATE OR REPLACE FUNCTION memory_edges_changed() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO memory_search_versions AS v (domain, links)
    SELECT DISTINCT n.domain, 1 FROM changed c JOIN memory_notes n ON n.id = c.source ORDER BY n.domain
    ON CONFLICT (domain) DO UPDATE SET links = v.links + 1;
    RETURN NULL;
END $$;

-- TRUNCATE has no transition table, so every domain starts over: those with
-- versions, and those with notes, read before the truncation.
CREATE OR REPLACE FUNCTION memory_search_truncated() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
    INSERT INTO memory_search_versions AS v (domain, notes, deletes)
    SELECT domain, 1, 1 FROM (
        SELECT domain FROM memory_search_versions UNION SELECT domain FROM memory_notes
    ) known ORDER BY domain
    ON CONFLICT (domain) DO UPDATE SET notes = v.notes + 1, deletes = v.deletes + 1;
    RETURN NULL;
END $$;

DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE attrelid = 'memory_notes'::regclass
                   AND attname = 'written_by' AND NOT attisdropped) THEN
        ALTER TABLE memory_notes ADD COLUMN written_by xid8;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_notes_stamp') THEN
        CREATE TRIGGER memory_notes_stamp BEFORE INSERT OR UPDATE ON memory_notes
            FOR EACH ROW EXECUTE FUNCTION memory_notes_stamp();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_notes_inserted') THEN
        CREATE TRIGGER memory_notes_inserted AFTER INSERT ON memory_notes
            REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION memory_notes_changed();
    END IF;
    -- Earlier builds created this trigger without the rows before the update.
    IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'memory_notes'::regclass
               AND tgname = 'memory_notes_updated' AND tgoldtable IS NULL) THEN
        DROP TRIGGER memory_notes_updated ON memory_notes;
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_notes_updated') THEN
        CREATE TRIGGER memory_notes_updated AFTER UPDATE ON memory_notes
            REFERENCING OLD TABLE AS old_notes NEW TABLE AS changed
            FOR EACH STATEMENT EXECUTE FUNCTION memory_notes_updated();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_notes_deleted') THEN
        CREATE TRIGGER memory_notes_deleted AFTER DELETE ON memory_notes
            REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION memory_notes_changed();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_edges_inserted') THEN
        CREATE TRIGGER memory_edges_inserted AFTER INSERT ON memory_edges
            REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION memory_edges_changed();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_edges_updated') THEN
        CREATE TRIGGER memory_edges_updated AFTER UPDATE ON memory_edges
            REFERENCING NEW TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION memory_edges_changed();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_edges_deleted') THEN
        CREATE TRIGGER memory_edges_deleted AFTER DELETE ON memory_edges
            REFERENCING OLD TABLE AS changed FOR EACH STATEMENT EXECUTE FUNCTION memory_edges_changed();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_notes_truncated') THEN
        CREATE TRIGGER memory_notes_truncated BEFORE TRUNCATE ON memory_notes
            FOR EACH STATEMENT EXECUTE FUNCTION memory_search_truncated();
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE tgname = 'memory_edges_truncated') THEN
        CREATE TRIGGER memory_edges_truncated BEFORE TRUNCATE ON memory_edges
            FOR EACH STATEMENT EXECUTE FUNCTION memory_search_truncated();
    END IF;
END $$;
CREATE INDEX IF NOT EXISTS memory_notes_written_by ON memory_notes(domain, written_by);

-- The code map: what each source file of a repository is for and what it
-- defines, for small models that read code. Its own layer: no vectors, so note
-- search never sees it. `domain` is where the checkout's folder is placed, so
-- vault rules apply as they do to notes. A checkout is its folder (`root`);
-- `name` is its remote, else its folder's name, for display.
CREATE TABLE IF NOT EXISTS code_map_repos (
    domain TEXT NOT NULL,
    root TEXT NOT NULL,
    name TEXT NOT NULL,
    indexed_commit TEXT,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, root)
);
CREATE INDEX IF NOT EXISTS code_map_repos_name ON code_map_repos(name);

CREATE TABLE IF NOT EXISTS code_map_files (
    domain TEXT NOT NULL,
    root TEXT NOT NULL,
    path TEXT NOT NULL,
    language TEXT NOT NULL,
    digest TEXT NOT NULL,
    purpose TEXT,
    purpose_source TEXT CHECK (purpose_source IN ('doc', 'model')),
    symbols JSONB NOT NULL DEFAULT '[]'::jsonb,
    imports TEXT[] NOT NULL DEFAULT '{}',
    updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    PRIMARY KEY (domain, root, path),
    FOREIGN KEY (domain, root) REFERENCES code_map_repos(domain, root) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS code_map_files_imports ON code_map_files USING GIN (imports);
