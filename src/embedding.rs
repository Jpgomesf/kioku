//! Client for the embedding service: Ollama's `/api/embed` or any
//! OpenAI-compatible `/embeddings` endpoint.

use std::time::Duration;

use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};

use crate::config::{Config, EmbeddingProvider};

/// Texts per request when embedding many documents.
const BATCH: usize = 16;
/// Attempts for transient failures (connection errors, 429, 5xx).
const ATTEMPTS: u32 = 3;

#[derive(Clone)]
pub struct Embedder {
    client: reqwest::Client,
    config: Config,
}

/// Why an embedding request failed, separated so callers can tell a note that
/// is too long apart from a service that is down.
#[derive(Debug, thiserror::Error)]
pub enum EmbedError {
    #[error(
        "the text is longer than the embedding model {model} accepts; split it into smaller, focused notes"
    )]
    TooLong {
        model: String,
        /// Position of the offending text in an [`Embedder::embed_documents`] call.
        index: Option<usize>,
    },
    #[error("the embedding service rejected the request (HTTP {status}): {message}")]
    Rejected { status: u16, message: String },
    #[error("the embedding service is unavailable: {0}")]
    Unavailable(String),
}

impl Embedder {
    pub fn new(config: &Config) -> Result<Self> {
        Ok(Self {
            client: reqwest::Client::builder()
                .no_proxy()
                .redirect(reqwest::redirect::Policy::none())
                .connect_timeout(Duration::from_secs(5))
                .timeout(Duration::from_secs(120))
                .build()
                .context("cannot build the embedding HTTP client")?,
            config: config.clone(),
        })
    }

    /// Embed a search query with the model's query prompt.
    pub async fn embed_query(&self, text: &str) -> Result<Vec<f32>> {
        let input = format!("{}{text}", self.config.embedding_prompts.query);
        let mut vectors = self.request(&[input]).await?;
        vectors
            .pop()
            .context("the embedding service returned no vector")
    }

    /// Embed documents with the model's document prompt, in batches.
    pub async fn embed_documents(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        let prefix = &self.config.embedding_prompts.document;
        let mut out = Vec::with_capacity(texts.len());
        for (batch, chunk) in texts.chunks(BATCH).enumerate() {
            let inputs: Vec<String> = chunk.iter().map(|t| format!("{prefix}{t}")).collect();
            match self.request(&inputs).await {
                Ok(vectors) => out.extend(vectors),
                // One oversized text fails the whole batch; retry singly to find it.
                Err(error) if is_too_long(&error) => {
                    for (offset, input) in inputs.into_iter().enumerate() {
                        match self.request(std::slice::from_ref(&input)).await {
                            Ok(vectors) => out.extend(vectors),
                            Err(error) if is_too_long(&error) => {
                                return Err(EmbedError::TooLong {
                                    model: self.config.embedding_model.clone(),
                                    index: Some(batch * BATCH + offset),
                                }
                                .into());
                            }
                            Err(error) => return Err(error),
                        }
                    }
                }
                Err(error) => return Err(error),
            }
        }
        Ok(out)
    }

    async fn request(&self, inputs: &[String]) -> Result<Vec<Vec<f32>>> {
        let base = self.config.embedding_url.trim_end_matches('/');
        let (url, body) = match self.config.embedding_provider {
            EmbeddingProvider::Ollama => (
                format!("{base}/api/embed"),
                json!({"model": self.config.embedding_model, "input": inputs, "truncate": false, "keep_alive": "10m"}),
            ),
            EmbeddingProvider::OpenAi => (
                format!("{base}/embeddings"),
                json!({"model": self.config.embedding_model, "input": inputs}),
            ),
        };
        let mut attempt = 0;
        let response: Value = loop {
            attempt += 1;
            let mut request = self.client.post(&url).json(&body);
            if let Some(key) = &self.config.embedding_api_key {
                request = request.bearer_auth(key);
            }
            let outcome = match request.send().await {
                Ok(response) if response.status().is_success() => {
                    break response
                        .json()
                        .await
                        .context("the embedding service returned invalid JSON")?;
                }
                Ok(response) => {
                    let status = response.status();
                    let text = response.text().await.unwrap_or_default();
                    let message = serde_json::from_str::<Value>(&text)
                        .ok()
                        .and_then(|v| {
                            v["error"]
                                .as_str()
                                .map(str::to_owned)
                                .or_else(|| v["error"]["message"].as_str().map(str::to_owned))
                        })
                        .unwrap_or(text);
                    if message.contains("exceeds the context length")
                        || message.contains("maximum context length")
                    {
                        return Err(EmbedError::TooLong {
                            model: self.config.embedding_model.clone(),
                            index: None,
                        }
                        .into());
                    }
                    let message: String = message.chars().take(300).collect();
                    if status.as_u16() == 429 || status.is_server_error() {
                        EmbedError::Unavailable(format!("HTTP {status}: {message}"))
                    } else {
                        return Err(EmbedError::Rejected {
                            status: status.as_u16(),
                            message,
                        }
                        .into());
                    }
                }
                Err(error) => EmbedError::Unavailable(error.to_string()),
            };
            if attempt >= ATTEMPTS {
                return Err(outcome.into());
            }
            tokio::time::sleep(Duration::from_millis(250 * 4u64.pow(attempt - 1))).await;
        };
        let vectors: Vec<Vec<f32>> = match self.config.embedding_provider {
            EmbeddingProvider::Ollama => serde_json::from_value(response["embeddings"].clone())
                .context("the embedding response lacks vectors")?,
            EmbeddingProvider::OpenAi => {
                let mut data: Vec<(usize, Vec<f32>)> = response["data"]
                    .as_array()
                    .context("the embedding response lacks data")?
                    .iter()
                    .enumerate()
                    .map(|(i, item)| {
                        let index = item["index"].as_u64().map_or(i, |n| n as usize);
                        serde_json::from_value(item["embedding"].clone())
                            .map(|v| (index, v))
                            .context("the embedding response has an invalid vector")
                    })
                    .collect::<Result<_>>()?;
                data.sort_by_key(|(index, _)| *index);
                data.into_iter().map(|(_, v)| v).collect()
            }
        };
        ensure!(
            vectors.len() == inputs.len(),
            "the embedding service returned {} vectors for {} inputs",
            vectors.len(),
            inputs.len()
        );
        for vector in &vectors {
            if vector.len() != self.config.embedding_dim {
                bail!(
                    "embedding dimension mismatch: got {}, EMBEDDING_DIM is {}; use a separate collection when changing models",
                    vector.len(),
                    self.config.embedding_dim
                );
            }
            ensure!(
                vector.iter().all(|v| v.is_finite()) && vector.iter().any(|v| *v != 0.0),
                "the embedding service returned an invalid or all-zero vector"
            );
        }
        Ok(vectors)
    }
}

/// Whether an error means the input exceeded the model's context window.
pub fn is_too_long(error: &anyhow::Error) -> bool {
    matches!(
        error.downcast_ref::<EmbedError>(),
        Some(EmbedError::TooLong { .. })
    )
}

/// Which document of an [`Embedder::embed_documents`] call was too long.
pub fn failed_index(error: &anyhow::Error) -> Option<usize> {
    match error.downcast_ref::<EmbedError>() {
        Some(EmbedError::TooLong { index, .. }) => *index,
        _ => None,
    }
}
