//! Rebuildable Qdrant index. Never treat its payload as authoritative note text.
use crate::model::{Note, Status, VectorHit};
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
        for field in ["domain", "status"] {
            self.request(
                reqwest::Method::PUT,
                &format!("{}/index?wait=true", self.collection_path()),
            )
            .json(&json!({"field_name":field,"field_schema":"keyword"}))
            .send()
            .await?
            .error_for_status()
            .context("Could not create Qdrant filter index")?;
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

    /// Write points in batches. Payloads carry only what search filters on.
    pub async fn upsert_many(&self, points: &[(Note, Vec<f32>)]) -> Result<()> {
        for batch in points.chunks(64) {
            let mut body = Vec::with_capacity(batch.len());
            for (note, vector) in batch {
                self.validate_vector(vector)?;
                body.push(json!({"id": note.id, "vector": vector, "payload": {
                    "domain": note.input.domain, "status": note.status.as_str(), "revision": note.revision
                }}));
            }
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
        }
        Ok(())
    }

    pub async fn search(
        &self,
        vector: Vec<f32>,
        domain: Option<&str>,
        include_legacy: bool,
        limit: usize,
    ) -> Result<Vec<VectorHit>> {
        self.validate_vector(&vector)?;
        ensure!(
            (1..=200).contains(&limit),
            "Vector search limit must be between 1 and 200"
        );
        let mut must = Vec::new();
        if let Some(domain) = domain {
            must.push(json!({"key":"domain","match":{"value":domain}}));
        }
        if !include_legacy {
            must.push(json!({"key":"status","match":{"value":"active"}}));
        }
        let value: Value = self.request(reqwest::Method::POST, &format!("{}/points/query", self.collection_path()))
            .json(&json!({"query":vector,"filter":{"must":must},"limit":limit,"with_payload":true,"with_vector":false}))
            .send().await?.error_for_status().context("Qdrant search failed")?.json().await?;
        let points = value["result"]["points"]
            .as_array()
            .context("Qdrant returned an invalid search response")?;
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rejects_invalid_vectors_before_network() {
        let client = Qdrant::new("http://127.0.0.1:1", "test", None, 2).unwrap();
        assert!(client.validate_vector(&[1.0, 0.0]).is_ok());
        assert!(client.validate_vector(&[0.0, 0.0]).is_err());
        assert!(client.validate_vector(&[f32::NAN, 1.0]).is_err());
        assert!(client.validate_vector(&[1.0]).is_err());
    }
}
