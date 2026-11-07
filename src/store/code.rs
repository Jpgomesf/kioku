//! The code map's tables: one row per indexed repository and one per source
//! file. Writes for one repository take an advisory lock, and an update saves
//! only if no other update moved the repository's commit since it started.

use anyhow::{Context, Result};
use sqlx::Row;
use sqlx::postgres::PgRow;

use super::Store;
use crate::codemap::{CodeFile, Language, PurposeSource, Symbol};

/// One update's result for a repository.
pub struct CodeMapChange<'a> {
    pub domain: &'a str,
    pub repo: &'a str,
    pub root: &'a str,
    /// The indexed commit the update started from: `None` for a repository
    /// with no row, `Some(None)` for one never indexed from a commit.
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
    /// The commit a repository's map was built from: `None` when the
    /// repository has no map, `Some(None)` when only lookups wrote it.
    pub async fn code_repo_commit(
        &self,
        domain: &str,
        repo: &str,
    ) -> Result<Option<Option<String>>> {
        let row =
            sqlx::query("SELECT indexed_commit FROM code_repos WHERE domain = $1 AND repo = $2")
                .bind(domain)
                .bind(repo)
                .fetch_optional(&self.pool)
                .await?;
        Ok(row.map(|row| row.get("indexed_commit")))
    }

    /// Every file of a repository's map, by path.
    pub async fn code_files(&self, domain: &str, repo: &str) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_files WHERE domain = $1 AND repo = $2 ORDER BY path"
        ))
        .bind(domain)
        .bind(repo)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_file).collect()
    }

    /// The files at `paths`, in that order; paths with no entry are left out.
    pub async fn code_files_at(
        &self,
        domain: &str,
        repo: &str,
        paths: &[String],
    ) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_files WHERE domain = $1 AND repo = $2 AND path = ANY($3)"
        ))
        .bind(domain)
        .bind(repo)
        .bind(paths)
        .fetch_all(&self.pool)
        .await?;
        let mut files: Vec<CodeFile> = rows.iter().map(decode_file).collect::<Result<_>>()?;
        files.sort_by_key(|file| paths.iter().position(|path| *path == file.path));
        Ok(files)
    }

    /// Up to `limit` files that import `path`, by path.
    pub async fn code_importers(
        &self,
        domain: &str,
        repo: &str,
        path: &str,
        limit: i64,
    ) -> Result<Vec<CodeFile>> {
        let rows = sqlx::query(concat!(
            "SELECT ",
            file_columns!(),
            " FROM code_files WHERE domain = $1 AND repo = $2 AND imports @> ARRAY[$3]::text[]",
            " ORDER BY path LIMIT $4"
        ))
        .bind(domain)
        .bind(repo)
        .bind(path)
        .bind(limit)
        .fetch_all(&self.pool)
        .await?;
        rows.iter().map(decode_file).collect()
    }

    /// Save an update. Returns false, saving nothing, when another update
    /// moved the repository's commit after this one started.
    pub async fn save_code_map(&self, change: &CodeMapChange<'_>) -> Result<bool> {
        let mut tx = self.pool.begin().await?;
        lock_repo(&mut tx, change.domain, change.repo).await?;
        let current: Option<Option<String>> =
            sqlx::query("SELECT indexed_commit FROM code_repos WHERE domain = $1 AND repo = $2")
                .bind(change.domain)
                .bind(change.repo)
                .fetch_optional(&mut *tx)
                .await?
                .map(|row| row.get("indexed_commit"));
        let current = current.as_ref().map(|commit| commit.as_deref());
        // A lookup may have created the row since without moving the commit.
        let moved = match (change.started_from, current) {
            (None, None | Some(None)) => false,
            (started, now) => started != now,
        };
        if moved {
            return Ok(false);
        }
        sqlx::query(
            "INSERT INTO code_repos(domain, repo, root, indexed_commit) VALUES ($1, $2, $3, $4)
             ON CONFLICT (domain, repo) DO UPDATE SET
               root = EXCLUDED.root, indexed_commit = EXCLUDED.indexed_commit, updated_at = now()",
        )
        .bind(change.domain)
        .bind(change.repo)
        .bind(change.root)
        .bind(change.commit)
        .execute(&mut *tx)
        .await?;
        sqlx::query("DELETE FROM code_files WHERE domain = $1 AND repo = $2 AND path = ANY($3)")
            .bind(change.domain)
            .bind(change.repo)
            .bind(change.removed)
            .execute(&mut *tx)
            .await?;
        for file in change.upserts {
            upsert_file(&mut tx, change.domain, change.repo, file).await?;
        }
        tx.commit().await?;
        Ok(true)
    }

    /// Save one file a lookup re-parsed, keeping the repository's commit.
    pub async fn save_code_file(
        &self,
        domain: &str,
        repo: &str,
        root: &str,
        file: &CodeFile,
    ) -> Result<()> {
        let mut tx = self.pool.begin().await?;
        lock_repo(&mut tx, domain, repo).await?;
        sqlx::query(
            "INSERT INTO code_repos(domain, repo, root) VALUES ($1, $2, $3)
             ON CONFLICT (domain, repo) DO UPDATE SET root = EXCLUDED.root",
        )
        .bind(domain)
        .bind(repo)
        .bind(root)
        .execute(&mut *tx)
        .await?;
        upsert_file(&mut tx, domain, repo, file).await?;
        tx.commit().await?;
        Ok(())
    }

    /// Drop a repository's map from `domain`, as when its folder moved to
    /// another area. Returns how many files it held.
    pub async fn drop_code_repo(&self, domain: &str, repo: &str) -> Result<u64> {
        let mut tx = self.pool.begin().await?;
        lock_repo(&mut tx, domain, repo).await?;
        let files = sqlx::query("DELETE FROM code_files WHERE domain = $1 AND repo = $2")
            .bind(domain)
            .bind(repo)
            .execute(&mut *tx)
            .await?
            .rows_affected();
        sqlx::query("DELETE FROM code_repos WHERE domain = $1 AND repo = $2")
            .bind(domain)
            .bind(repo)
            .execute(&mut *tx)
            .await?;
        tx.commit().await?;
        Ok(files)
    }

    /// Each domain that holds a map of `repo`, with the folder it was built in.
    pub async fn code_repo_roots(&self, repo: &str) -> Result<Vec<(String, String)>> {
        let rows =
            sqlx::query("SELECT domain, root FROM code_repos WHERE repo = $1 ORDER BY domain")
                .bind(repo)
                .fetch_all(&self.pool)
                .await?;
        Ok(rows
            .iter()
            .map(|row| (row.get("domain"), row.get("root")))
            .collect())
    }
}

async fn lock_repo(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain: &str,
    repo: &str,
) -> Result<()> {
    sqlx::query("SET LOCAL lock_timeout = '30s'")
        .execute(&mut **tx)
        .await?;
    sqlx::query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))")
        .bind(format!("code-map\n{domain}\n{repo}"))
        .execute(&mut **tx)
        .await
        .context("another code map update is busy; retry shortly")?;
    Ok(())
}

async fn upsert_file(
    tx: &mut sqlx::Transaction<'_, sqlx::Postgres>,
    domain: &str,
    repo: &str,
    file: &CodeFile,
) -> Result<()> {
    sqlx::query(
        "INSERT INTO code_files(domain, repo, path, language, digest, purpose, purpose_source, symbols, imports)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (domain, repo, path) DO UPDATE SET
           language = EXCLUDED.language, digest = EXCLUDED.digest, purpose = EXCLUDED.purpose,
           purpose_source = EXCLUDED.purpose_source, symbols = EXCLUDED.symbols,
           imports = EXCLUDED.imports, updated_at = now()",
    )
    .bind(domain)
    .bind(repo)
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
