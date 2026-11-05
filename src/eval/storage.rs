//! Disposable database and collection names, so evaluation never touches live memories.

use anyhow::{Context, Result, ensure};

use crate::config::Config;
use crate::vector::Qdrant;

/// `<base>_eval_<model>` with characters PostgreSQL and Qdrant both accept,
/// at most `max_len` bytes. Separate names per embedding model let you
/// compare models side by side.
pub fn isolated_name(base: &str, model: &str, max_len: usize) -> String {
    let slug = |text: &str| -> String {
        let mut out = String::new();
        for c in text.chars().flat_map(char::to_lowercase) {
            if c.is_ascii_alphanumeric() {
                out.push(c);
            } else if !out.ends_with('_') {
                out.push('_');
            }
        }
        out.trim_matches('_').to_owned()
    };
    let mut name = format!("{}_eval_{}", slug(base), slug(model));
    name.truncate(max_len);
    name.trim_end_matches('_').to_owned()
}

fn is_disposable(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 63
        && name
            .bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'_')
        && (name.contains("eval") || name.contains("test"))
}

/// Point `config` at a freshly recreated database and Qdrant collection, so a
/// fixture corpus never touches real memories. Both names must contain
/// "eval" or "test" and differ from the configured ones.
pub async fn isolate_storage(config: &mut Config, database: &str, collection: &str) -> Result<()> {
    use sqlx::Connection;

    let live_database = config.database_name()?;
    ensure!(
        is_disposable(database) && database != live_database,
        "evaluation database {database:?} must be lowercase, contain eval or test, and differ from {live_database:?}"
    );
    ensure!(
        is_disposable(collection) && collection != config.collection,
        "evaluation collection {collection:?} must be lowercase, contain eval or test, and differ from {:?}",
        config.collection
    );
    let mut admin = sqlx::PgConnection::connect(&config.database_url)
        .await
        .context("cannot connect to PostgreSQL to prepare the evaluation database")?;
    // Audited: both names were validated above to contain only [a-z0-9_].
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "DROP DATABASE IF EXISTS \"{database}\" WITH (FORCE)"
    )))
    .execute(&mut admin)
    .await
    .context("cannot drop the previous evaluation database")?;
    sqlx::raw_sql(sqlx::AssertSqlSafe(format!(
        "CREATE DATABASE \"{database}\""
    )))
    .execute(&mut admin)
    .await
    .context("cannot create the evaluation database")?;
    admin.close().await?;
    config.database_url = config.with_database(database)?;
    // The dataset belongs to no vault, so vault rules, including which notes
    // a hosted embedding service may read, don't apply to it.
    config.vaults = None;
    Qdrant::new(
        &config.qdrant_url,
        collection,
        config.qdrant_api_key.clone(),
        config.embedding_dim,
    )?
    .delete_collection()
    .await?;
    config.collection = collection.to_owned();
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn isolated_names_are_disposable_and_bounded() {
        let name = isolated_name("memory", "nomic-embed-text:latest", 63);
        assert_eq!(name, "memory_eval_nomic_embed_text_latest");
        assert!(is_disposable(&name));
        let long = isolated_name("memory", &"x".repeat(200), 63);
        assert!(long.len() <= 63 && is_disposable(&long));
        assert!(!is_disposable("memory"));
        assert!(!is_disposable("Memory_eval"));
        assert!(!is_disposable("memory_eval\"; drop"));
    }
}
