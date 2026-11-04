//! Loading and validating evaluation datasets.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    name: String,
    #[serde(default)]
    description: String,
    domain: String,
    #[serde(default)]
    corpus: Option<PathBuf>,
    queries: PathBuf,
    #[serde(default)]
    retire: Vec<String>,
}

/// One graded query. `relevant` maps note keys to grades: 2 answers the
/// question, 1 is useful supporting context. An empty map means nothing in the
/// corpus answers it, which measures abstention.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Query {
    pub id: String,
    pub category: String,
    pub query: String,
    #[serde(default)]
    pub relevant: BTreeMap<String, u8>,
    /// Facts that a context pack for this query must contain (case-insensitive).
    #[serde(default)]
    pub answer: Vec<String>,
    #[serde(default)]
    pub include_legacy: bool,
    /// Keys that must never appear in the top k, such as a retired runbook.
    #[serde(default)]
    pub forbidden: Vec<String>,
    /// Notes an answer needs together, such as every hop of a multi-hop
    /// question. Complete support means all of them reached the top k.
    #[serde(default)]
    pub required: Vec<String>,
}

#[derive(Debug)]
pub struct Dataset {
    pub name: String,
    pub description: String,
    pub domain: String,
    pub corpus: Option<PathBuf>,
    pub retire: Vec<String>,
    pub queries: Vec<Query>,
}

impl Dataset {
    pub fn load(manifest: &Path) -> Result<Self> {
        let text = std::fs::read_to_string(manifest)
            .with_context(|| format!("cannot read dataset manifest {}", manifest.display()))?;
        let m: Manifest = serde_json::from_str(&text).context("invalid dataset manifest")?;
        let base = manifest.parent().unwrap_or_else(|| Path::new("."));
        let queries_path = base.join(&m.queries);
        let mut queries = Vec::new();
        let lines = std::fs::read_to_string(&queries_path)
            .with_context(|| format!("cannot read queries {}", queries_path.display()))?;
        for (number, line) in lines.lines().enumerate() {
            if line.trim().is_empty() {
                continue;
            }
            let query: Query = serde_json::from_str(line)
                .with_context(|| format!("invalid query on line {}", number + 1))?;
            ensure!(
                query.relevant.values().all(|grade| (1..=3).contains(grade)),
                "query {} has a relevance grade outside 1..=3",
                query.id
            );
            ensure!(
                query
                    .required
                    .iter()
                    .all(|key| query.relevant.contains_key(key)),
                "query {}: every required key must also be graded in relevant",
                query.id
            );
            queries.push(query);
        }
        ensure!(!queries.is_empty(), "dataset has no queries");
        let mut ids = std::collections::HashSet::new();
        for query in &queries {
            ensure!(ids.insert(&query.id), "duplicate query id {}", query.id);
        }
        Ok(Self {
            name: m.name,
            description: m.description,
            domain: m.domain,
            corpus: m.corpus.map(|corpus| base.join(corpus)),
            retire: m.retire,
            queries,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn bundled_dataset_is_consistent() {
        let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("evals/retrieval/dataset.json");
        let dataset = Dataset::load(&root).expect("dataset loads");
        let corpus = dataset
            .corpus
            .as_ref()
            .expect("bundled dataset has a corpus");
        let keys: std::collections::HashSet<String> = std::fs::read_dir(corpus)
            .expect("corpus directory")
            .filter_map(|e| e.ok())
            .filter_map(|e| {
                e.path()
                    .file_stem()
                    .map(|s| s.to_string_lossy().into_owned())
            })
            .collect();
        for query in &dataset.queries {
            for key in query.relevant.keys().chain(&query.forbidden) {
                assert!(
                    keys.contains(key),
                    "query {} references unknown note {key}",
                    query.id
                );
            }
        }
        for key in &dataset.retire {
            assert!(
                keys.contains(key),
                "retire list references unknown note {key}"
            );
        }
    }
}
