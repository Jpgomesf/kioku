//! Rebuildable Qdrant index. Never treat its payload as authoritative note text:
//! it holds the note's BM25 terms for keyword search in Qdrant, but PostgreSQL
//! decides what a search returns.
use crate::model::{Note, Status, VectorHit};
use crate::rank;
use anyhow::{Context, Result, ensure};
use reqwest::{Client, RequestBuilder, StatusCode};
use serde_json::{Value, json};
use std::time::Duration;
use uuid::Uuid;

#[derive(Clone)]
pub struct Qdrant {
    client: Client,
    base_url: String,
    collection: String,
    api_key: Option<String>,
    dimension: usize,
}

impl Qdrant {
    pub fn new(
        url: &str,
        collection: &str,
        api_key: Option<String>,
        dimension: usize,
    ) -> Result<Self> {
        Ok(Self {
            // Never route the API key through an environment proxy or a redirect.
            client: Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .timeout(Duration::from_secs(30))
                .connect_timeout(Duration::from_secs(5))
                .build()
                .context("cannot build the Qdrant HTTP client")?,
            base_url: url.trim_end_matches('/').into(),
            collection: collection.into(),
            api_key,
            dimension,
        })
    }

    fn request(&self, method: reqwest::Method, endpoint: &str) -> RequestBuilder {
        let request = self
            .client
            .request(method, format!("{}{endpoint}", self.base_url));
        if let Some(key) = &self.api_key {
            request.header("api-key", key)
        } else {
            request
        }
    }

    fn collection_path(&self) -> String {
        format!("/collections/{}", self.collection)
    }

    pub async fn ensure_collection(&self) -> Result<()> {
        self.ensure_collection_created().await?;
        Ok(())
    }

    /// Returns true when this call created the derived collection.
    pub async fn ensure_collection_created(&self) -> Result<bool> {
        ensure!(
            !self.collection.is_empty()
                && self.collection.len() <= 128
                && self
                    .collection
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
            "Invalid Qdrant collection name"
        );
        ensure!(
            self.dimension > 0 && self.dimension <= 65536,
            "Invalid embedding dimension"
        );
        let response = self
            .request(reqwest::Method::GET, &self.collection_path())
            .send()
            .await
            .context("Cannot reach Qdrant")?;
        let created = if response.status() == StatusCode::NOT_FOUND {
            let creation = self
                .request(reqwest::Method::PUT, &self.collection_path())
                .json(&json!({"vectors":{"size":self.dimension,"distance":"Cosine"}}))
                .send()
                .await?;
            if creation.status() == StatusCode::CONFLICT {
                false
            } else {
                creation
                    .error_for_status()
                    .context("Could not create Qdrant collection")?;
                true
            }
        } else {
            response
                .error_for_status()
                .context("Could not inspect Qdrant collection")?;
            false
        };
        // Re-read even after creation: another process may have created it first.
        let value: Value = self
            .request(reqwest::Method::GET, &self.collection_path())
            .send()
            .await?
            .error_for_status()
            .context("Could not inspect Qdrant collection")?
            .json()
            .await?;
        let vectors = &value["result"]["config"]["params"]["vectors"];
        ensure!(
            vectors["size"].as_u64() == Some(self.dimension as u64)
                && vectors["distance"].as_str() == Some("Cosine"),
            "Existing Qdrant collection has incompatible dimensions/distance; use a new collection when changing embedding models"
        );
        // Keyword search in Qdrant (`MEMORY_LEXICAL=qdrant`) scores BM25 over
        // `lexical`, which holds Kioku's own tokens: splitting on whitespace
        // alone keeps them as they are.
        let lexical =
            json!({"type": "text", "tokenizer": "whitespace", "lowercase": true, "scoring": true});
        for (field, schema) in [
            ("domain", json!("keyword")),
            ("status", json!("keyword")),
            ("lock", json!("keyword")),
            ("labels", json!("keyword")),
            ("lexical", lexical),
        ] {
            let indexed = self
                .request(
                    reqwest::Method::PUT,
                    &format!("{}/index?wait=true", self.collection_path()),
                )
                .json(&json!({"field_name": field, "field_schema": schema}))
                .send()
                .await?
                .error_for_status()
                .context("Could not create Qdrant filter index");
            match indexed {
                // A Qdrant older than 1.20 can't score BM25; only keyword
                // search in Qdrant needs it, and that search then runs in
                // process.
                Err(error) if field == "lexical" => tracing::warn!(
                    error = format!("{error:#}"),
                    "this Qdrant can't score BM25; MEMORY_LEXICAL=qdrant needs Qdrant 1.20 or later"
                ),
                indexed => {
                    indexed?;
                }
            }
        }
        Ok(created)
    }

    /// Delete this collection if it exists. Used only for isolated evaluation storage.
    pub async fn delete_collection(&self) -> Result<()> {
        let response = self
            .request(reqwest::Method::DELETE, &self.collection_path())
            .send()
            .await
            .context("cannot reach Qdrant")?;
        if response.status() != StatusCode::NOT_FOUND {
            response
                .error_for_status()
                .context("cannot delete the Qdrant collection")?;
        }
        Ok(())
    }

    /// Allows recovery if a prior process crashed after collection creation but
    /// before it invalidated PostgreSQL's vector flags.
    pub async fn point_count(&self) -> Result<u64> {
        let value: Value = self
            .request(
                reqwest::Method::POST,
                &format!("{}/points/count", self.collection_path()),
            )
            .json(&json!({"exact":true}))
            .send()
            .await?
            .error_for_status()
            .context("Could not count Qdrant points")?
            .json()
            .await?;
        value["result"]["count"]
            .as_u64()
            .context("Qdrant count response is invalid")
    }

    fn validate_vector(&self, vector: &[f32]) -> Result<()> {
        ensure!(
            vector.len() == self.dimension,
            "Embedding dimension mismatch: expected {}, received {}",
            self.dimension,
            vector.len()
        );
        ensure!(
            vector.iter().all(|v| v.is_finite()),
            "Embedding contains non-finite values"
        );
        ensure!(
            vector.iter().any(|v| *v != 0.0),
            "Embedding vector is all zero"
        );
        Ok(())
    }

    pub async fn upsert(&self, note: &Note, vector: Vec<f32>) -> Result<()> {
        self.upsert_many(&[(note.clone(), vector)]).await
    }

    /// Write points in batches.
    pub async fn upsert_many(&self, points: &[(Note, Vec<f32>)]) -> Result<()> {
        for batch in points.chunks(64) {
            let mut body = Vec::with_capacity(batch.len());
            for (note, vector) in batch {
                self.validate_vector(vector)?;
                body.push(json!({"id": note.id, "vector": vector, "payload": payload(note)}));
            }
            self.put_points(body).await?;
        }
        Ok(())
    }

    /// Write points without a vector for notes the embedding service may not
    /// read, so keyword search in Qdrant still finds them. Any vector such a
    /// point had is removed.
    pub async fn upsert_unembedded(&self, notes: &[Note]) -> Result<()> {
        for batch in notes.chunks(64) {
            let body = batch
                .iter()
                .map(|note| json!({"id": note.id, "vector": {}, "payload": payload(note)}))
                .collect();
            self.put_points(body).await?;
        }
        Ok(())
    }

    async fn put_points(&self, body: Vec<Value>) -> Result<()> {
        self.request(
            reqwest::Method::PUT,
            &format!("{}/points?wait=true", self.collection_path()),
        )
        .json(&json!({"points": body}))
        .send()
        .await
        .context("cannot reach Qdrant")?
        .error_for_status()
        .context("cannot update Qdrant vectors; the notes remain saved in PostgreSQL")?;
        Ok(())
    }

    /// Remove payload `keys` from every point, as points written by an older
    /// version lack them.
    #[cfg(test)]
    pub(crate) async fn delete_payload_keys(&self, keys: &[&str]) -> Result<()> {
        self.request(
            reqwest::Method::POST,
            &format!("{}/points/payload/delete?wait=true", self.collection_path()),
        )
        .json(&json!({"keys": keys, "filter": {"must": []}}))
        .send()
        .await?
        .error_for_status()?;
        Ok(())
    }

    /// Rewrite the payloads of existing points without touching their
    /// vectors, as for points written before payloads carried keyword fields.
    pub async fn set_payloads(&self, notes: &[Note]) -> Result<()> {
        for batch in notes.chunks(64) {
            let operations: Vec<Value> = batch
                .iter()
                .map(|note| json!({"set_payload": {"payload": payload(note), "points": [note.id]}}))
                .collect();
            self.request(
                reqwest::Method::POST,
                &format!("{}/points/batch?wait=true", self.collection_path()),
            )
            .json(&json!({"operations": operations}))
            .send()
            .await
            .context("cannot reach Qdrant")?
            .error_for_status()
            .context("cannot update Qdrant payloads")?;
        }
        Ok(())
    }

    /// Remove the points of `ids`, if any: notes the embedding service may no
    /// longer read keep no vector. Missing points are not an error.
    pub async fn delete(&self, ids: &[Uuid]) -> Result<()> {
        for batch in ids.chunks(256) {
            self.request(
                reqwest::Method::POST,
                &format!("{}/points/delete?wait=true", self.collection_path()),
            )
            .json(&json!({"points": batch}))
            .send()
            .await
            .context("cannot reach Qdrant")?
            .error_for_status()
            .context("cannot remove Qdrant vectors")?;
        }
        Ok(())
    }

    /// Nearest points, in `domains` when given (one domain, or several for a
    /// whole vault), or in every domain. Points in `exclude` are never
    /// returned, so they can't take candidate slots from the others.
    pub async fn search(
        &self,
        vector: Vec<f32>,
        domains: Option<&[&str]>,
        include_legacy: bool,
        exclude: &[Uuid],
        limit: usize,
    ) -> Result<Vec<VectorHit>> {
        self.validate_vector(&vector)?;
        ensure!(
            (1..=200).contains(&limit),
            "Vector search limit must be between 1 and 200"
        );
        let Some(filter) = search_filter(domains, include_legacy, exclude) else {
            return Ok(Vec::new());
        };
        let value: Value = self.request(reqwest::Method::POST, &format!("{}/points/query", self.collection_path()))
            .json(&json!({"query":vector,"filter":filter,"limit":limit,"with_payload":true,"with_vector":false}))
            .send().await?.error_for_status().context("Qdrant search failed")?.json().await?;
        parse_points(
            value["result"]["points"]
                .as_array()
                .context("Qdrant returned an invalid search response")?,
        )
    }

    pub async fn set_status(&self, id: Uuid, status: Status) -> Result<()> {
        self.request(
            reqwest::Method::POST,
            &format!("{}/points/payload?wait=true", self.collection_path()),
        )
        .json(&json!({"payload":{"status":status.as_str()},"points":[id]}))
        .send()
        .await?
        .error_for_status()
        .context("Could not update Qdrant lifecycle status")?;
        Ok(())
    }

    pub async fn health(&self) -> Result<()> {
        self.request(reqwest::Method::GET, "/readyz")
            .send()
            .await?
            .error_for_status()
            .context("Qdrant is not ready")?;
        Ok(())
    }
}

/// A point's payload: what search filters on, and for keyword search in
/// Qdrant the note's BM25 terms and exact labels, as Kioku's own tokenizer
/// produces them. Derived data like the vector: PostgreSQL stays the truth.
fn payload(note: &Note) -> Value {
    let input = &note.input;
    json!({
        "domain": input.domain,
        "status": note.status.as_str(),
        "revision": note.revision,
        "lock": input.lock,
        "labels": rank::exact_labels(&input.key, &input.title, &input.aliases),
        "lexical": rank::lexical_text(&input.key, &input.title, &input.aliases, &input.tags, &input.body),
    })
}

/// Which points a keyword-and-vector search may return, and over which its
/// BM25 statistics run.
pub struct Scope<'a> {
    /// The searched domains; never empty.
    pub domains: &'a [&'a str],
    pub include_legacy: bool,
    /// Points never returned or counted: hidden or not yet indexed.
    pub exclude: &'a [Uuid],
    /// With vault rules, the caller's provider: notes whose lock leaves it
    /// out are skipped. `None` sees every lock.
    pub provider: Option<&'a str>,
}

/// One query for [`Qdrant::hybrid`].
pub struct HybridQuery<'a> {
    pub vector: Option<Vec<f32>>,
    /// The query's BM25 terms, as Kioku tokenizes them.
    pub terms: &'a [String],
    /// The query as exact matches compare labels, if it has any text.
    pub label: Option<&'a str>,
    pub dense_limit: usize,
    pub lexical_limit: usize,
}

/// Candidates from each signal of [`Qdrant::hybrid`], best first.
#[derive(Debug, Default)]
pub struct HybridHits {
    pub dense: Vec<VectorHit>,
    pub lexical: Vec<VectorHit>,
    pub exact: Vec<VectorHit>,
}

/// BM25's term-frequency saturation and length normalization, as Kioku's own.
const BM25: (f64, f64) = (1.2, 0.75);

/// Exact label matches returned at most.
const EXACT_LIMIT: usize = 64;

impl Qdrant {
    /// Dense, BM25, and exact-label candidates in one batch request. BM25
    /// statistics are computed over the same points the search may return
    /// (Qdrant's per-query `idf` corpus), so other domains, hidden notes, and
    /// retired notes don't change them.
    pub async fn hybrid(&self, query: &HybridQuery<'_>, scope: &Scope<'_>) -> Result<HybridHits> {
        let Some(mut filter) =
            search_filter(Some(scope.domains), scope.include_legacy, scope.exclude)
        else {
            return Ok(HybridHits::default());
        };
        if let Some(provider) = scope.provider {
            filter["must"]
                .as_array_mut()
                .context("invalid search filter")?
                .push(json!({"should": [
                    {"is_empty": {"key": "lock"}},
                    {"key": "lock", "match": {"value": provider}},
                ]}));
        }
        let fields = json!(["revision"]);
        let mut searches = Vec::new();
        let mut kinds = Vec::new();
        if let Some(vector) = &query.vector {
            self.validate_vector(vector)?;
            searches.push(
                json!({"query": vector, "filter": filter, "limit": query.dense_limit,
                "with_payload": fields, "with_vector": false}),
            );
            kinds.push(0);
        }
        if !query.terms.is_empty() {
            searches.push(json!({
                "query": {"text": {"query": query.terms.join(" "), "scoring": {"bm25": {"k": BM25.0, "b": BM25.1}}}},
                "using": "lexical", "filter": filter, "params": {"idf": {"corpus": filter}},
                "limit": query.lexical_limit, "with_payload": fields,
            }));
            kinds.push(1);
        }
        if let Some(label) = query.label {
            let mut exact = filter.clone();
            exact["must"]
                .as_array_mut()
                .context("invalid search filter")?
                .push(json!({"key": "labels", "match": {"value": label}}));
            searches.push(json!({"filter": exact, "limit": EXACT_LIMIT, "with_payload": fields}));
            kinds.push(2);
        }
        if searches.is_empty() {
            return Ok(HybridHits::default());
        }
        let value: Value = self
            .request(
                reqwest::Method::POST,
                &format!("{}/points/query/batch", self.collection_path()),
            )
            .json(&json!({"searches": searches}))
            .send()
            .await?
            .error_for_status()
            .context("Qdrant search failed")?
            .json()
            .await?;
        let results = value["result"]
            .as_array()
            .context("Qdrant returned an invalid search response")?;
        let mut hits = HybridHits::default();
        for (kind, result) in kinds.into_iter().zip(results) {
            let points = parse_points(
                result["points"]
                    .as_array()
                    .context("Qdrant returned an invalid search response")?,
            )?;
            match kind {
                0 => hits.dense = points,
                1 => hits.lexical = points,
                _ => hits.exact = points,
            }
        }
        Ok(hits)
    }
}

/// Points of a query response, with their score and indexed revision.
fn parse_points(points: &[Value]) -> Result<Vec<VectorHit>> {
    points
        .iter()
        .map(|point| {
            let id = Uuid::parse_str(point["id"].as_str().context("Invalid Qdrant point ID")?)?;
            let score = point["score"].as_f64().context("Invalid Qdrant score")?;
            let revision = point["payload"]["revision"]
                .as_i64()
                .context("Missing Qdrant content revision; rebuild this index")?;
            ensure!(
                score.is_finite() && revision >= 1,
                "Invalid Qdrant score or revision"
            );
            Ok(VectorHit {
                id,
                score,
                revision,
            })
        })
        .collect()
}

/// The filter of a vector search, or `None` when no domain is allowed.
fn search_filter(
    domains: Option<&[&str]>,
    include_legacy: bool,
    exclude: &[Uuid],
) -> Option<Value> {
    let mut must = Vec::new();
    match domains {
        None => {}
        Some([]) => return None,
        Some([domain]) => must.push(json!({"key":"domain","match":{"value":domain}})),
        Some(several) => must.push(json!({"key":"domain","match":{"any":several}})),
    }
    if !include_legacy {
        must.push(json!({"key":"status","match":{"value":"active"}}));
    }
    let mut filter = json!({"must": must});
    if !exclude.is_empty() {
        filter["must_not"] = json!([{"has_id": exclude}]);
    }
    Some(filter)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn search_filters_leave_out_excluded_points() {
        let plain = search_filter(Some(&["a"]), false, &[]).unwrap();
        assert_eq!(
            plain,
            json!({"must": [
                {"key": "domain", "match": {"value": "a"}},
                {"key": "status", "match": {"value": "active"}},
            ]}),
            "without exclusions the filter is unchanged"
        );
        let id = Uuid::nil();
        let vault = search_filter(Some(&["a", "b"]), true, &[id]).unwrap();
        assert_eq!(
            vault,
            json!({
                "must": [{"key": "domain", "match": {"any": ["a", "b"]}}],
                "must_not": [{"has_id": [id]}],
            })
        );
        assert!(search_filter(Some(&[]), false, &[id]).is_none());
        assert_eq!(search_filter(None, true, &[]).unwrap(), json!({"must": []}));
    }
    #[test]
    fn rejects_invalid_vectors_before_network() {
        let client = Qdrant::new("http://127.0.0.1:1", "test", None, 2).unwrap();
        assert!(client.validate_vector(&[1.0, 0.0]).is_ok());
        assert!(client.validate_vector(&[0.0, 0.0]).is_err());
        assert!(client.validate_vector(&[f32::NAN, 1.0]).is_err());
        assert!(client.validate_vector(&[1.0]).is_err());
    }
}
