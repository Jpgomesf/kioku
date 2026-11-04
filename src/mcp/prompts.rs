//! Prompts that clients can offer as slash commands.

use rmcp::handler::server::wrapper::Parameters;
use rmcp::model::{PromptMessage, Role};
use rmcp::{prompt, prompt_router};
use schemars::JsonSchema;
use serde::Deserialize;

use super::MemoryServer;

#[derive(Debug, Deserialize, JsonSchema)]
pub struct RecallArgs {
    /// One word or a quoted phrase to look up. Default: the current task.
    pub topic: Option<String>,
}

#[prompt_router(vis = "pub(super)")]
impl MemoryServer {
    #[prompt(
        name = "recall",
        title = "Recall from Kioku",
        description = "Look up what Kioku already knows about a topic, or about the current task, before starting work."
    )]
    async fn recall(&self, Parameters(args): Parameters<RecallArgs>) -> Vec<PromptMessage> {
        let topic = args
            .topic
            .map(|t| t.trim().to_owned())
            .filter(|t| !t.is_empty())
            .unwrap_or_else(|| "the current task".to_owned());
        vec![PromptMessage::new_text(
            Role::User,
            format!(
                "Before continuing, check Kioku for what this project already knows about {topic}. Call memory_search with a focused query and this project's memory domain, read the 1-2 relevant results with memory_get, then summarize what is stored in 2-5 bullets citing keys or sources. If nothing relevant is stored, say so. Do not save anything."
            ),
        )]
    }

    #[prompt(
        name = "remember",
        title = "Save to Kioku",
        description = "Save this conversation's confirmed decisions, tested fixes, and lasting preferences to Kioku."
    )]
    async fn remember(&self) -> Vec<PromptMessage> {
        vec![PromptMessage::new_text(
            Role::User,
            "Review this conversation for confirmed decisions, tested fixes, verified architecture facts, and lasting user preferences that Kioku does not store yet (at most 3). For each one: call memory_search to find an existing key, then call memory_save once, reusing that key to update. Write 1-3 sentences with the reason and scope, use the project's domain, and include no secrets, guesses, open questions, or transcript text. Then list the keys you saved and anything you chose not to save. If nothing qualifies, say so and save nothing.",
        )]
    }
}
