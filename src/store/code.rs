//! The code map's tables: one row per mapped checkout and one per source
//! file. A checkout is its folder (`root`). Writes for one checkout take an
//! advisory lock, and an update saves only if no other update moved the
//! checkout's commit since it started.

use anyhow::{Context, Result};
use sqlx::Row;
use sqlx::postgres::PgRow;

use super::Store;
use crate::codemap::{CodeFile, Language, PurposeSource, Symbol};

/// One update's result for a checkout.
pub struct CodeMapChange<'a> {
    pub domain: &'a str,
    pub root: &'a str,
    /// The checkout's name: its remote, else its folder's name.
    pub name: &'a str,
    /// The indexed commit the update started from: `None` for a checkout
    /// with no map, `Some(None)` for one only lookups wrote.
    pub started_from: Option<Option<&'a str>>,
    pub commit: &'a str,
    pub upserts: &'a [CodeFile],
    pub removed: &'a [String],
}

/// The columns [`decode_file`] reads, for `concat!` in static queries.
macro_rules! file_columns {
    () => {
        "path, language, digest, purpose, purpose_source, symbols, imports"
    };
}

impl Store {
    /// The commit a checkout's map was built from: `None` when it has no map,
    /// `Some(None)` when only lookups wrote it.
    pub async fn code_map_commit(
        &self,
        domain: &str,
        root: &str,
    ) -> Result<Option<Option<String>>> {
        let row = sqlx::query(
            "SELECT indexed_commit FROM code_map_repos WHERE domain = $1 AND root = $2",
        )
        .bind(domain)
        .bind(root)
        .fetch_optional(&self.pool)
        .await?;
        Ok(row.map(|row| row.get("indexed_commit")))
    }

    /// Every file of a checkout's map, by path.
    pub async fn code_map_files(&self, domain: &str, root: &str) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_map_files WHERE domain = $1 AND root = $2 ORDER BY path"
        ))
        .bind(domain)
        .bind(root)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_file).collect()
    }

    /// The files at `paths`, in that order; paths with no entry are left out.
    pub async fn code_map_files_at(
        &self,
        domain: &str,
        root: &str,
        paths: &[String],
    ) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_map_files WHERE domain = $1 AND root = $2 AND path = ANY($3)"
        ))
        .bind(domain)
        .bind(root)
        .bind(paths)
        .fetch_all(&self.pool)
        .await?;
        let mut files: Vec<CodeFile> = rows.iter().map(decode_file).collect::<Result<_>>()?;
        files.sort_by_key(|file| paths.iter().position(|path| *path == file.path));
        Ok(files)
    }

    /// Up to `limit` files that import `path`, by path.
    pub async fn code_map_importers(
        &self,
        domain: &str,
        root: &str,
        path: &str,
        limit: i64,
    ) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_map_files WHERE domain = $1 AND root = $2 AND imports @> ARRAY[$3]::text[]",
            " ORDER BY path LIMIT $4"
        ))
        .bind(domain)
        .bind(root)
        .bind(path)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_file).collect()
    }

    /// Save an update. Returns false, saving nothing, when another update
    /// moved the checkout's commit, or dropped its map, after this one started.
    pub async fn save_code_map(&self, change: &CodeMapChange<'_>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        lock_checkout(&mut tx, change.domain, change.root).await?;
        let current: Option<Option<String>> = sqlx::query(
            "SELECT indexed_commit FROM code_map_repos WHERE domain = $1 AND root = $2",
        )
        .bind(change.domain)
        .bind(change.root)
        .fetch_optional(&mut *tx)
        .await?
        .map(|row| row.get("indexed_commit"));
        let current = current.as_ref().map(|commit| commit.as_deref());
        // A lookup may have created the row since, without a commit.
        let moved = match (change.started_from, current) {
            (None, None | Some(None)) => false,
            (started, now) => started != now,
        };
        if moved {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO code_map_repos(domain, root, name, indexed_commit) VALUES ($1, $2, $3, $4)
             ON CONFLICT (domain, root) DO UPDATE SET
               name = EXCLUDED.name, indexed_commit = EXCLUDED.indexed_commit, updated_at = now()",
        )
        .bind(change.domain)
        .bind(change.root)
        .bind(change.name)
        .bind(change.commit)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "DELETE FROM code_map_files WHERE domain = $1 AND root = $2 AND path = ANY($3)",
        )
        .bind(change.domain)
        .bind(change.root)
        .bind(change.removed)
        .execute(&mut *tx)
        .await?;
        for file in change.upserts {
            write_file(&mut tx, change.domain, change.root, file).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Save one file a lookup parsed again, keeping the checkout's commit. A
    /// lookup writes no model purpose: a stored one survives, unless the file
    /// now has a doc comment, whose purpose replaces it.
    pub async fn refresh_code_file(
        &self,
        domain: &str,
        root: &str,
        name: &str,
        file: &CodeFile,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_checkout(&mut tx, domain, root).await?;
        sqlx::query(
            "INSERT INTO code_map_repos(domain, root, name) VALUES ($1, $2, $3)
             ON CONFLICT (domain, root) DO UPDATE SET name = EXCLUDED.name",
        )
        .bind(domain)
        .bind(root)
        .bind(name)
        .execute(&mut *tx)
        .await?;
        sqlx::query(
            "INSERT INTO code_map_files(domain, root, path, language, digest, purpose, purpose_source, symbols, imports)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
             ON CONFLICT (domain, root, path) DO UPDATE SET
               language = EXCLUDED.language, digest = EXCLUDED.digest,
               symbols = EXCLUDED.symbols, imports = EXCLUDED.imports, updated_at = now(),
               purpose = CASE WHEN EXCLUDED.purpose_source = 'doc'
                                OR code_map_files.purpose_source IS DISTINCT FROM 'model'
                              THEN EXCLUDED.purpose ELSE code_map_files.purpose END,
               purpose_source = CASE WHEN EXCLUDED.purpose_source = 'doc'
                                       OR code_map_files.purpose_source IS DISTINCT FROM 'model'
                                     THEN EXCLUDED.purpose_source ELSE code_map_files.purpose_source END",
        )
        .bind(domain)
        .bind(root)
        .bind(&file.path)
        .bind(file.language.as_str())
        .bind(&file.digest)
        .bind(&file.purpose)
        .bind(file.purpose_source.map(PurposeSource::as_str))
        .bind(serde_json::to_value(&file.symbols)?)
        .bind(&file.imports)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        Ok(())
    }

    /// Drop a checkout's map from `domain`. Returns how many files it held.
    pub async fn drop_code_map(&self, domain: &str, root: &str) -> Result<u64> {
        let mut tx = self.pool.begin().await?;
        lock_checkout(&mut tx, domain, root).await?;
        let files = sqlx::query("DELETE FROM code_map_files WHERE domain = $1 AND root = $2")
            .bind(domain)
            .bind(root)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        sqlx::query("DELETE FROM code_map_repos WHERE domain = $1 AND root = $2")
            .bind(domain)
            .bind(root)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(files)
    }

    /// Every mapped checkout of a repository, by its name: `(domain, root)`.
    pub async fn code_maps_named(&self, name: &str) -> Result<Vec<(String, String)>> {
        let rows = sqlx::query(
            "SELECT domain, root FROM code_map_repos WHERE name = $1 ORDER BY domain, root",
        )
        .bind(name)
        .fetch_all(&self.pool)
        .await?;
        Ok(rows
            .iter()
            .map(|row| (row.get("domain"), row.get("root")))
            .collect())
    }
}

async fn lock_checkout(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain: &str,
    root: &str,
) -> Result<()> {
    sqlx::query("SET LOCAL lock_timeout = '30s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("code-map\n{domain}\n{root}"))
        .execute(&mut **tx)
        .await
        .context("another code map update is busy; retry shortly")?;
    Ok(())
}

async fn write_file(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain: &str,
    root: &str,
    file: &CodeFile,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO code_map_files(domain, root, path, language, digest, purpose, purpose_source, symbols, imports)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (domain, root, path) DO UPDATE SET
           language = EXCLUDED.language, digest = EXCLUDED.digest, purpose = EXCLUDED.purpose,
           purpose_source = EXCLUDED.purpose_source, symbols = EXCLUDED.symbols,
           imports = EXCLUDED.imports, updated_at = now()",
    )
    .bind(domain)
    .bind(root)
    .bind(&file.path)
    .bind(file.language.as_str())
    .bind(&file.digest)
    .bind(&file.purpose)
    .bind(file.purpose_source.map(PurposeSource::as_str))
    .bind(serde_json::to_value(&file.symbols)?)
    .bind(&file.imports)
    .execute(&mut **tx)
    .await?;
    Ok(())
}

fn decode_file(row: &PgRow) -> Result<CodeFile> {
    let language: String = row.get("language");
    let source: Option<String> = row.get("purpose_source");
    let symbols: serde_json::Value = row.get("symbols");
    Ok(CodeFile {
        path: row.get("path"),
        language: Language::parse(&language)
            .with_context(|| format!("unknown code map language {language:?}"))?,
        digest: row.get("digest"),
        purpose: row.get("purpose"),
        purpose_source: source.as_deref().and_then(PurposeSource::parse),
        symbols: serde_json::from_value::<Vec<Symbol>>(symbols)?,
        imports: row.get("imports"),
    })
}
