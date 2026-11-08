//! Tool arguments: lenient normalization in front of strict types.
//!
//! Models send `"5"` for 5, `"true"` for true, JSON-encoded arrays, and older
//! argument names. Arguments are normalized against the tool's own input
//! schema first, then parsed strictly, so a misspelled field produces an error
//! that names the allowed fields instead of being silently ignored.

use rmcp::model::JsonObject;
use schemars::JsonSchema;
use serde::Deserialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};

/// Older argument names that are still accepted, mapped to current ones.
const RENAMED: [(&str, &str); 4] = [
    ("domain_filter", "domain"),
    ("ids", "keys"),
    ("id", "key"),
    ("token_budget", "max_bytes"),
];

/// Longest error text sent back to the model.
const MAX_ERROR_CHARS: usize = 600;

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ResponseFormat {
    #[default]
    Concise,
    Detailed,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum GraphMode {
    Rerank,
    Off,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SearchArgs {
    /// What you need to know, as a question or keywords, e.g. "webhook retry policy". An exact key, title, or alias also matches.
    pub query: String,
    /// Project memory domain: the one named in AGENTS.md or CLAUDE.md, else the repository folder name, e.g. "relay". Use "local" for notes about this machine. Default: the server's default domain.
    pub domain: Option<String>,
    /// How many results to return, 1-20. Default 5.
    #[schemars(range(min = 1, max = 20))]
    pub limit: Option<i64>,
    /// Also return retired (legacy) memories, marked with status "legacy". Default false; use only for history questions.
    pub include_legacy: Option<bool>,
    /// "concise" (default) returns key, title, snippet, and score; "detailed" adds ids, sources, dates, and ranking signals for debugging.
    pub response_format: Option<ResponseFormat>,
    /// Older argument: "rerank" (default) fills the last result slot from explicitly linked notes, "off" does not.
    #[schemars(skip)]
    pub graph_mode: Option<GraphMode>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct GetArgs {
    /// Keys from memory_search results, e.g. ["webhook-retries"], 1-10 keys. An exact title, alias, or memory id also works.
    #[schemars(length(min = 1, max = 10))]
    pub keys: Vec<String>,
    /// The domain you searched. Default: the server's default domain.
    pub domain: Option<String>,
    /// Size cap for the whole response in bytes (an upper bound on tokens), 256-8000. Default 2000. If the result says truncated, raise it or ask for fewer keys.
    #[schemars(range(min = 256, max = 8000))]
    pub max_bytes: Option<i64>,
    /// Count this read as use, which keeps the memories from aging out. Default true; pass false when you read only to compare, deduplicate, or audit.
    pub count_use: Option<bool>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct SaveArgs {
    /// Stable key in lowercase-kebab-case, e.g. "webhook-dedup-retention". Reusing an existing key updates that memory; a new key creates one.
    pub key: String,
    /// Short, specific title, e.g. "Webhook dedup token retention".
    pub title: String,
    /// The fact or decision with its reason and scope: 1-3 sentences, ideally under 600 characters. No secrets, guesses, or open questions.
    pub body: String,
    /// Project memory domain, the same one you search, e.g. "relay". Use "local" for notes about this machine.
    pub domain: String,
    /// Keys of existing memories this one builds on, e.g. ["webhook-retries"]. On update, omit to keep the current links; [] removes them.
    pub related: Option<Vec<String>>,
    /// Other names people may search for: old names, abbreviations, translations. On update, read the current list with memory_get and send the full list; omit to keep them; [] removes them.
    pub aliases: Option<Vec<String>>,
    /// Topic labels, e.g. ["webhooks"]. On update, omit to keep them; [] removes them.
    pub tags: Option<Vec<String>>,
    /// Code paths this memory governs, as globs relative to the repository root, e.g. ["src/vault/**"]: a decision or convention about that code. Opening a matching file then brings this memory up. On update, omit to keep them; [] removes them.
    pub paths: Option<Vec<String>>,
    /// Where the fact comes from: a URL or document you read, or "user" when the user stated it. Omit to let the server record the client and date. Never invent paths, dates, or session ids.
    pub source: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct KeyArgs {
    /// The memory's key; an exact title, alias, or memory id also works.
    pub key: String,
    /// The memory's domain. Default: the server's default domain.
    pub domain: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct FeedbackArgs {
    /// The memory's key; an exact title, alias, or memory id also works.
    pub key: String,
    /// true if the memory proved correct and helpful; false if it was wrong or outdated.
    pub positive: bool,
    /// The memory's domain. Default: the server's default domain.
    pub domain: Option<String>,
    /// Optional unique id for this feedback event; retries with the same id count once. Default: one vote per memory, verdict, and day.
    pub request_id: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ImportArgs {
    /// File or folder relative to the notes folder, e.g. "relay" or "relay/webhooks.md". Default: the whole notes folder.
    pub path: Option<String>,
    /// Domain the imported notes belong to; a note whose frontmatter names another domain stops the import before anything is written. Default: the server's default domain.
    pub domain: Option<String>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct MaintenanceArgs {
    /// true (default) only previews which memories would move to legacy; false applies the changes.
    pub dry_run: Option<bool>,
}

/// Which lifecycle states `memory_list` returns.
#[derive(Debug, Clone, Copy, Default, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum ListStatus {
    #[default]
    Active,
    Legacy,
    All,
}

/// How a note reached Kioku: saved by an agent, or imported from a file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Deserialize, JsonSchema)]
#[serde(rename_all = "lowercase")]
pub enum NoteOrigin {
    Agent,
    File,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct ListArgs {
    /// Domain to list. At a vault's root without one: every domain of the vault. Default: the server's default domain.
    pub domain: Option<String>,
    /// "active" (default), "legacy", or "all".
    pub status: Option<ListStatus>,
    /// "agent" for notes saved with memory_save, "file" for notes imported from Markdown or a knowledge base. Default: both.
    pub origin: Option<NoteOrigin>,
    /// Only notes with this tag, e.g. "decision".
    pub tag: Option<String>,
    /// Only notes anchored to this file, a path relative to the repository root, e.g. "src/vault/place.rs".
    pub path: Option<String>,
    /// Notes per page, 1-200. Default 50.
    #[schemars(range(min = 1, max = 200))]
    pub limit: Option<i64>,
    /// Notes to skip; pass the previous page's next_offset. Default 0.
    #[schemars(range(min = 0))]
    pub offset: Option<i64>,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct CodeMapArgs {
    /// The source file, absolute or relative to the session's folder, e.g. "src/store/mod.rs".
    pub path: String,
}

#[derive(Debug, Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
pub struct EmptyArgs {}

/// Normalize `raw` against `schema` and parse it into `T`. Errors are short
/// texts for the model that name the problem, the allowed fields, and an example.
pub fn parse<T: DeserializeOwned>(
    tool: &str,
    mut raw: JsonObject,
    schema: &JsonObject,
    hidden: &[&str],
    example: &str,
) -> Result<T, String> {
    let properties = schema
        .get("properties")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let known = |name: &str| properties.contains_key(name) || hidden.contains(&name);
    for (old, new) in RENAMED {
        if !known(new) {
            continue;
        }
        if let Some(value) = raw.remove(old) {
            match raw.get(new) {
                Some(current) if current != &value => {
                    return Err(error(
                        tool,
                        &format!("{old:?} is the old name of {new:?}; send only {new:?}"),
                        example,
                    ));
                }
                _ => {
                    raw.insert(new.to_owned(), value);
                }
            }
        }
    }
    // Absent, null, "null", and "" all mean "not given".
    raw.retain(|_, value| match value {
        Value::Null => false,
        Value::String(s) => !(s.trim().is_empty() || s.trim().eq_ignore_ascii_case("null")),
        _ => true,
    });
    let unknown: Vec<String> = raw.keys().filter(|k| !known(k)).cloned().collect();
    if !unknown.is_empty() {
        let allowed: Vec<&String> = properties.keys().collect();
        return Err(error(
            tool,
            &format!(
                "{tool} does not accept {}. Allowed: {}",
                quoted(&unknown),
                allowed
                    .iter()
                    .map(|s| s.as_str())
                    .collect::<Vec<_>>()
                    .join(", ")
            ),
            example,
        ));
    }
    for (name, value) in raw.iter_mut() {
        if let Some(property) = properties.get(name) {
            coerce(value, property);
        }
    }
    serde_json::from_value(Value::Object(raw))
        .map_err(|e| error(tool, &describe(&e.to_string(), &properties), example))
}

/// Convert common near-misses to the type the schema asks for.
fn coerce(value: &mut Value, property: &Value) {
    let expected = property
        .get("type")
        .and_then(Value::as_str)
        .unwrap_or_default();
    let replacement = match (expected, &*value) {
        ("integer", Value::String(s)) => s
            .trim()
            .parse::<i64>()
            .ok()
            .or_else(|| {
                s.trim()
                    .parse::<f64>()
                    .ok()
                    .filter(|f| f.fract() == 0.0)
                    .map(|f| f as i64)
            })
            .map(|n| json!(n)),
        ("integer", Value::Number(n)) if n.is_f64() => n
            .as_f64()
            .filter(|f| f.fract() == 0.0)
            .map(|f| json!(f as i64)),
        ("number", Value::String(s)) => s.trim().parse::<f64>().ok().map(|f| json!(f)),
        ("boolean", Value::String(s)) => match s.trim().to_ascii_lowercase().as_str() {
            "true" | "1" | "yes" => Some(json!(true)),
            "false" | "0" | "no" => Some(json!(false)),
            _ => None,
        },
        ("boolean", Value::Number(n)) => match n.as_i64() {
            Some(1) => Some(json!(true)),
            Some(0) => Some(json!(false)),
            _ => None,
        },
        ("array", Value::String(s)) => {
            let text = s.trim();
            match serde_json::from_str::<Value>(text) {
                Ok(Value::Array(items)) if text.starts_with('[') => Some(Value::Array(items)),
                // A bare string is one item; commas are not split because titles may contain them.
                _ => Some(json!([text])),
            }
        }
        ("string", Value::Number(n)) => Some(json!(n.to_string())),
        ("string", Value::Bool(b)) => Some(json!(b.to_string())),
        ("string", Value::String(s)) if property.get("enum").is_some() => {
            Some(json!(s.trim().to_ascii_lowercase()))
        }
        _ => None,
    };
    if let Some(replacement) = replacement {
        *value = replacement;
    }
    if expected == "array"
        && let Value::Array(items) = value
    {
        for item in items.iter_mut() {
            let text = match item {
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => continue,
            };
            *item = Value::String(text);
        }
    }
}

/// Rewrite a serde message in the schema's terms.
fn describe(message: &str, properties: &serde_json::Map<String, Value>) -> String {
    let message = message.replace('`', "\"");
    let message = message
        .split(" at line ")
        .next()
        .unwrap_or(&message)
        .to_owned();
    if let Some(field) = message
        .strip_prefix("missing field \"")
        .and_then(|rest| rest.strip_suffix('"'))
    {
        let hint = properties
            .get(field)
            .and_then(|p| p.get("description"))
            .and_then(Value::as_str)
            .map(|d| format!(" ({d})"))
            .unwrap_or_default();
        return format!("missing required field {field:?}{hint}");
    }
    message
}

fn quoted(names: &[String]) -> String {
    names
        .iter()
        .map(|n| format!("{n:?}"))
        .collect::<Vec<_>>()
        .join(", ")
}

/// An `invalid_argument` error with a corrected example.
pub fn error(tool: &str, problem: &str, example: &str) -> String {
    clip(format!(
        "invalid_argument: {problem}. Example: {tool} {example}"
    ))
}

/// Keep error texts short enough to read and cheap to send.
pub fn clip(mut text: String) -> String {
    if text.chars().count() > MAX_ERROR_CHARS {
        text = text.chars().take(MAX_ERROR_CHARS - 1).collect();
        text.push('…');
    }
    text
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::mcp::schema;

    fn obj(value: Value) -> JsonObject {
        match value {
            Value::Object(map) => map,
            _ => JsonObject::new(),
        }
    }

    fn parse_search(value: Value) -> Result<SearchArgs, String> {
        parse(
            "memory_search",
            obj(value),
            &schema::input::<SearchArgs>(),
            &["graph_mode"],
            "{}",
        )
    }

    #[test]
    fn strings_numbers_and_booleans_are_coerced() {
        let parsed = parse_search(json!({"query": "q", "limit": "3", "include_legacy": "false", "response_format": " Detailed "})).unwrap();
        assert_eq!(parsed.limit, Some(3));
        assert_eq!(parsed.include_legacy, Some(false));
        assert_eq!(parsed.response_format, Some(ResponseFormat::Detailed));
        assert_eq!(
            parse_search(json!({"query": "q", "limit": 4.0}))
                .unwrap()
                .limit,
            Some(4)
        );
    }

    #[test]
    fn old_argument_names_still_work() {
        let parsed =
            parse_search(json!({"query": "q", "domain_filter": "relay", "graph_mode": "off"}))
                .unwrap();
        assert_eq!(parsed.domain.as_deref(), Some("relay"));
        assert_eq!(parsed.graph_mode, Some(GraphMode::Off));
        let conflict = parse_search(json!({"query": "q", "domain_filter": "a", "domain": "b"}));
        assert!(conflict.err().unwrap().contains("old name"));
    }

    #[test]
    fn nulls_and_empty_strings_mean_absent() {
        let parsed = parse_search(
            json!({"query": "q", "domain": null, "limit": "", "response_format": "null"}),
        )
        .unwrap();
        assert!(
            parsed.domain.is_none() && parsed.limit.is_none() && parsed.response_format.is_none()
        );
    }

    #[test]
    fn unknown_and_missing_fields_get_actionable_errors() {
        let unknown = parse_search(json!({"query": "q", "project": "relay"}))
            .err()
            .unwrap();
        assert!(unknown.starts_with("invalid_argument:"), "{unknown}");
        assert!(
            unknown.contains("\"project\"") && unknown.contains("Allowed: query, domain"),
            "{unknown}"
        );
        assert!(unknown.contains("Example:"), "{unknown}");
        let missing = parse_search(json!({"limit": 3})).err().unwrap();
        assert!(
            missing.contains("missing required field \"query\""),
            "{missing}"
        );
        let bad_enum = parse_search(json!({"query": "q", "response_format": "short"}))
            .err()
            .unwrap();
        assert!(bad_enum.contains("concise"), "{bad_enum}");
    }

    #[test]
    fn arrays_accept_json_strings_single_values_and_numbers() {
        let schema = schema::input::<GetArgs>();
        let parse_get =
            |value: Value| parse::<GetArgs>("memory_get", obj(value), &schema, &[], "{}");
        assert_eq!(
            parse_get(json!({"keys": "[\"a\", \"b\"]"})).unwrap().keys,
            ["a", "b"]
        );
        assert_eq!(
            parse_get(json!({"keys": "a, with comma"})).unwrap().keys,
            ["a, with comma"]
        );
        assert_eq!(parse_get(json!({"ids": [2024]})).unwrap().keys, ["2024"]);
    }

    #[test]
    fn errors_are_short() {
        let long = parse_search(json!({"query": "q", "x".repeat(2000): 1}))
            .err()
            .unwrap();
        assert!(long.chars().count() <= MAX_ERROR_CHARS);
    }
}
