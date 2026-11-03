use crate::config::Config;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::time::Duration;

#[derive(Clone)]
pub struct Embedder {
    client: reqwest::Client,
    config: Config,
}

impl Embedder {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(120))
                .build()?,
            config: config.clone(),
        })
    }
    pub async fn embed(&self, text: &str, query: bool) -> Result<Vec<f32>> {
        let text = if self.config.embedding_model.starts_with("nomic-embed-text") {
            format!(
                "{}: {}",
                if query {
                    "search_query"
                } else {
                    "search_document"
                },
                text
            )
        } else {
            text.to_owned()
        };
        let base = self.config.embedding_url.trim_end_matches('/');
        let (url, body) = if self.config.embedding_provider == "ollama" {
            (
                format!("{base}/api/embed"),
                json!({"model":self.config.embedding_model,"input":text,"truncate":false,"keep_alive":"10m"}),
            )
        } else {
            (
                format!("{base}/embeddings"),
                json!({"model":self.config.embedding_model,"input":text}),
            )
        };
        let mut request = self.client.post(url).json(&body);
        if let Some(key) = &self.config.embedding_api_key {
            request = request.bearer_auth(key);
        }
        let response = request
            .send()
            .await
            .context("embedding service unavailable")?;
        ensure!(
            response.status().is_success(),
            "embedding service returned HTTP {}; verify the model is downloaded and the note fits its context window",
            response.status()
        );
        let response: Value = response
            .json()
            .await
            .context("invalid embedding response")?;
        let values = if self.config.embedding_provider == "ollama" {
            &response["embeddings"][0]
        } else {
            &response["data"][0]["embedding"]
        };
        let vector: Vec<f32> =
            serde_json::from_value(values.clone()).context("embedding response lacks a vector")?;
        ensure!(
            vector.len() == self.config.embedding_dim,
            "embedding dimension mismatch: got {}, configured {}; use a separate collection when changing models",
            vector.len(),
            self.config.embedding_dim
        );
        ensure!(
            vector.iter().all(|v| v.is_finite()) && vector.iter().any(|v| *v != 0.0),
            "invalid or zero embedding vector"
        );
        Ok(vector)
    }
}
