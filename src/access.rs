//! Who may call which tools on which domains.
//!
//! A [`Principal`] is built by the transport, never from tool arguments. Over
//! stdio each client launches its own process, so the principal comes from
//! that process's environment (`MEMORY_PRINCIPAL`, `MEMORY_SCOPES`,
//! `MEMORY_DOMAINS`), which is where the MCP specification says stdio servers
//! take credentials from. Over HTTP it comes from a bearer token listed in an
//! access file. Tools see only the principal, never credentials, so an OAuth
//! verifier can replace the token check later without touching tool code.
//!
//! With a vaults file ([`crate::vault`]), an access-file principal also names
//! its model provider and vault; one without both gets no memories.

use std::collections::BTreeSet;
use std::fmt;

use anyhow::{Context, Result, bail, ensure};
use regex::Regex;
use serde::Deserialize;
use sha2::{Digest, Sha256};

use crate::vault::Provider;

/// What a principal may do. Tools require exactly one scope each.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Scope {
    /// Search and read memories.
    Read,
    /// Save memories and record feedback.
    Write,
    /// Retire, restore, import, and run maintenance.
    Admin,
}

impl Scope {
    pub fn parse(text: &str) -> Result<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "read" => Ok(Self::Read),
            "write" => Ok(Self::Write),
            "admin" => Ok(Self::Admin),
            other => bail!("unknown scope {other:?}; use read, write, or admin"),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
            Self::Admin => "admin",
        }
    }
}

/// The scope a tool needs. Unknown names need admin, so a new tool is closed
/// until someone decides otherwise.
pub fn required_scope(tool: &str) -> Scope {
    match tool {
        "memory_search" | "memory_get" | "memory_inspect" | "memory_stats"
        | "rag_context_query" => Scope::Read,
        "memory_save" | "memory_feedback" => Scope::Write,
        _ => Scope::Admin,
    }
}

/// A domain pattern: a glob (`*` matches any run of characters, `?` one
/// character), or an anchored regular expression written `re:<expr>`. Regexes
/// use the `regex` crate, which matches in linear time, so a pattern can't
/// stall the server.
#[derive(Clone)]
pub struct Pattern {
    source: String,
    regex: Regex,
}

impl Pattern {
    pub fn parse(source: &str) -> Result<Self> {
        let source = source.trim();
        ensure!(!source.is_empty(), "empty domain pattern");
        let expression = match source.strip_prefix("re:") {
            Some(expression) => format!("^(?:{expression})$"),
            None => {
                let mut expression = String::from("^");
                for c in source.chars() {
                    match c {
                        '*' => expression.push_str(".*"),
                        '?' => expression.push('.'),
                        c => expression.push_str(&regex::escape(&c.to_string())),
                    }
                }
                expression.push('$');
                expression
            }
        };
        let regex = Regex::new(&expression)
            .with_context(|| format!("invalid domain pattern {source:?}"))?;
        Ok(Self {
            source: source.to_owned(),
            regex,
        })
    }

    /// `*`, which matches every domain. Built directly so it can't fail.
    fn any() -> Self {
        Self {
            source: "*".to_owned(),
            regex: Regex::new("^.*$").unwrap_or_else(|_| unreachable!("constant pattern")),
        }
    }

    pub fn matches(&self, domain: &str) -> bool {
        self.regex.is_match(domain)
    }
}

impl fmt::Debug for Pattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.source)
    }
}

impl fmt::Display for Pattern {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.source)
    }
}

/// Who is calling, with what they may touch.
#[derive(Clone, Debug)]
pub struct Principal {
    /// `local` for a stdio process, or the name of an access-file entry.
    pub subject: String,
    pub scopes: BTreeSet<Scope>,
    pub domains: Vec<Pattern>,
    /// The model provider an access-file entry declares. Stdio processes
    /// declare theirs in `MEMORY_PROVIDER` instead.
    pub provider: Option<Provider>,
    /// The vault an access-file entry may use. Stdio processes are placed by
    /// their folder instead.
    pub vault: Option<String>,
}

impl Principal {
    /// Everything allowed: the default for a stdio process with no profile.
    pub fn local() -> Self {
        Self {
            subject: "local".to_owned(),
            scopes: [Scope::Read, Scope::Write, Scope::Admin].into(),
            domains: vec![Pattern::any()],
            provider: None,
            vault: None,
        }
    }

    /// No scopes and no domains: what an unauthenticated request gets.
    pub fn nobody() -> Self {
        Self {
            subject: "nobody".to_owned(),
            scopes: BTreeSet::new(),
            domains: Vec::new(),
            provider: None,
            vault: None,
        }
    }

    /// Build a principal from comma-separated scopes and domain patterns.
    pub fn new(subject: &str, scopes: &str, domains: &str) -> Result<Self> {
        let subject = subject.trim();
        ensure!(
            !subject.is_empty() && subject.len() <= 128,
            "principal names must be 1 to 128 characters"
        );
        let scopes = split(scopes)
            .map(Scope::parse)
            .collect::<Result<BTreeSet<_>>>()?;
        ensure!(!scopes.is_empty(), "principal {subject:?} has no scopes");
        let domains = split(domains)
            .map(Pattern::parse)
            .collect::<Result<Vec<_>>>()?;
        ensure!(
            !domains.is_empty(),
            "principal {subject:?} has no domain patterns"
        );
        Ok(Self {
            subject: subject.to_owned(),
            scopes,
            domains,
            provider: None,
            vault: None,
        })
    }

    /// This principal with a declared provider and vault, as an access-file
    /// entry gives them. Both are optional; vault mode needs both.
    pub fn with_vault(mut self, provider: Option<&str>, vault: Option<&str>) -> Result<Self> {
        self.provider = provider
            .map(str::trim)
            .filter(|p| !p.is_empty())
            .map(Provider::parse)
            .transpose()
            .with_context(|| format!("principal {:?}", self.subject))?;
        self.vault = vault
            .map(str::trim)
            .filter(|v| !v.is_empty())
            .map(str::to_owned);
        Ok(self)
    }

    pub fn allows_tool(&self, tool: &str) -> bool {
        self.scopes.contains(&required_scope(tool))
    }

    pub fn allows_domain(&self, domain: &str) -> bool {
        self.domains.iter().any(|pattern| pattern.matches(domain))
    }

    /// The patterns, for error messages.
    pub fn describe_domains(&self) -> String {
        self.domains
            .iter()
            .map(ToString::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    }

    /// Whether this principal may see every domain (it holds `*`).
    pub fn sees_all_domains(&self) -> bool {
        self.domains.iter().any(|p| p.source == "*")
    }
}

fn split(list: &str) -> impl Iterator<Item = &str> {
    list.split(',').map(str::trim).filter(|s| !s.is_empty())
}

/// One entry of the access file used by the HTTP transport.
#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct Entry {
    subject: String,
    /// Hex SHA-256 of the bearer token; the token itself is never stored.
    token_sha256: String,
    scopes: Vec<String>,
    domains: Vec<String>,
    /// The model provider behind this client; needed in vault mode.
    provider: Option<String>,
    /// The vault this client may use; needed in vault mode.
    vault: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AccessFileToml {
    #[serde(default)]
    principal: Vec<Entry>,
}

/// Principals that may connect over HTTP, keyed by token hash.
#[derive(Debug)]
pub struct AccessFile {
    entries: Vec<([u8; 32], Principal)>,
}

impl AccessFile {
    pub fn parse(text: &str) -> Result<Self> {
        let parsed: AccessFileToml = toml::from_str(text).context("invalid access file")?;
        ensure!(
            !parsed.principal.is_empty(),
            "the access file lists no [[principal]] entries, so nobody could connect"
        );
        let mut entries = Vec::new();
        let mut subjects = BTreeSet::new();
        for entry in parsed.principal {
            let hash = decode_hash(&entry.token_sha256)
                .with_context(|| format!("principal {:?}", entry.subject))?;
            ensure!(
                subjects.insert(entry.subject.clone()),
                "principal {:?} is listed twice",
                entry.subject
            );
            ensure!(
                entries.iter().all(|(other, _)| other != &hash),
                "two principals share a token"
            );
            let principal = Principal::new(
                &entry.subject,
                &entry.scopes.join(","),
                &entry.domains.join(","),
            )?
            .with_vault(entry.provider.as_deref(), entry.vault.as_deref())?;
            entries.push((hash, principal));
        }
        Ok(Self { entries })
    }

    pub fn load(path: &std::path::Path) -> Result<Self> {
        let text = std::fs::read_to_string(path)
            .with_context(|| format!("cannot read access file {}", path.display()))?;
        Self::parse(&text).with_context(|| format!("in {}", path.display()))
    }

    /// The principal whose token hashes to `hash`. Every entry is compared
    /// in constant time, so timing reveals nothing about which one matched.
    pub fn find(&self, hash: &[u8; 32]) -> Option<&Principal> {
        let mut found = None;
        for (stored, principal) in &self.entries {
            if constant_time_eq(stored, hash) {
                found = Some(principal);
            }
        }
        found
    }

    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Every principal, in file order.
    pub fn principals(&self) -> impl Iterator<Item = &Principal> {
        self.entries.iter().map(|(_, principal)| principal)
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

/// SHA-256 of a bearer token, as stored in the access file.
pub fn token_hash(token: &str) -> [u8; 32] {
    Sha256::digest(token.as_bytes()).into()
}

pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}

/// A new random bearer token: 244 bits from two v4 UUIDs, which come from the
/// operating system's secure random source.
pub fn new_token() -> String {
    format!(
        "kioku_{}{}",
        uuid::Uuid::new_v4().simple(),
        uuid::Uuid::new_v4().simple()
    )
}

/// The access-file entry for a principal, ready to paste.
pub fn access_entry(principal: &Principal, token: &str) -> String {
    let quote = |items: Vec<String>| {
        items
            .iter()
            .map(|item| format!("{item:?}"))
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut entry = format!(
        "[[principal]]\nsubject = {:?}\ntoken_sha256 = \"{}\"\nscopes = [{}]\ndomains = [{}]\n",
        principal.subject,
        hex(&token_hash(token)),
        quote(
            principal
                .scopes
                .iter()
                .map(|s| s.as_str().to_owned())
                .collect()
        ),
        quote(principal.domains.iter().map(ToString::to_string).collect()),
    );
    if let Some(provider) = principal.provider {
        entry.push_str(&format!("provider = \"{provider}\"\n"));
    }
    if let Some(vault) = &principal.vault {
        entry.push_str(&format!("vault = {vault:?}\n"));
    }
    entry
}

fn decode_hash(hex: &str) -> Result<[u8; 32]> {
    let hex = hex.trim();
    ensure!(
        hex.len() == 64 && hex.bytes().all(|b| b.is_ascii_hexdigit()),
        "token_sha256 must be 64 hex characters (run `kioku token` to create one)"
    );
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)?;
    }
    Ok(out)
}

fn constant_time_eq(a: &[u8; 32], b: &[u8; 32]) -> bool {
    a.iter().zip(b).fold(0u8, |acc, (x, y)| acc | (x ^ y)) == 0
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn globs_and_regexes_match_whole_domains() {
        let glob = Pattern::parse("work-*").unwrap();
        assert!(glob.matches("work-api") && glob.matches("work-"));
        assert!(!glob.matches("homework-api"), "globs are anchored");
        let exact = Pattern::parse("kioku").unwrap();
        assert!(exact.matches("kioku") && !exact.matches("kioku2"));
        let dots = Pattern::parse("a.b").unwrap();
        assert!(!dots.matches("axb"), "glob text is literal");
        let regex = Pattern::parse("re:client-(acme|globex)").unwrap();
        assert!(regex.matches("client-acme") && !regex.matches("client-acme-old"));
        assert!(Pattern::parse("re:(").is_err());
        assert!(Pattern::parse(" ").is_err());
    }

    #[test]
    fn scopes_gate_tools_and_unknown_tools_need_admin() {
        let reader = Principal::new("r", "read", "*").unwrap();
        assert!(reader.allows_tool("memory_search") && reader.allows_tool("memory_get"));
        assert!(!reader.allows_tool("memory_save"));
        assert!(!reader.allows_tool("memory_retire"));
        assert!(!reader.allows_tool("memory_something_new"));
        let writer = Principal::new("w", "read, write", "personal-*").unwrap();
        assert!(writer.allows_tool("memory_save") && !writer.allows_tool("memory_import"));
        assert!(writer.allows_domain("personal-notes") && !writer.allows_domain("work"));
        assert!(Principal::new("x", "read,delete", "*").is_err());
        assert!(Principal::new("x", "", "*").is_err());
        assert!(Principal::new("x", "read", "").is_err());
        assert!(Principal::local().sees_all_domains());
    }

    #[test]
    fn access_file_finds_principals_by_token_hash() {
        let hash = "ab".repeat(32);
        let other = "cd".repeat(32);
        let file = AccessFile::parse(&format!(
            r#"
            [[principal]]
            subject = "kilo-qwen"
            token_sha256 = "{hash}"
            scopes = ["read", "write"]
            domains = ["personal-*", "kioku"]

            [[principal]]
            subject = "reader"
            token_sha256 = "{other}"
            scopes = ["read"]
            domains = ["re:client-(acme|globex)"]
            "#
        ))
        .unwrap();
        assert_eq!(file.len(), 2);
        let found = file.find(&[0xab; 32]).unwrap();
        assert_eq!(found.subject, "kilo-qwen");
        assert!(found.allows_domain("kioku"));
        assert!(file.find(&[0u8; 32]).is_none());
    }

    #[test]
    fn generated_entries_parse_and_match_their_token() {
        let principal = Principal::new("kilo-qwen", "read,write", "personal-*, kioku").unwrap();
        let token = new_token();
        assert!(token.starts_with("kioku_") && token.len() == 70);
        assert_ne!(token, new_token());
        let file = AccessFile::parse(&access_entry(&principal, &token)).unwrap();
        let found = file.find(&token_hash(&token)).unwrap();
        assert_eq!(found.subject, "kilo-qwen");
        assert!(found.allows_domain("personal-x") && found.allows_tool("memory_save"));
        assert!(found.provider.is_none() && found.vault.is_none());
        assert!(file.find(&token_hash("wrong")).is_none());
        let placed = principal
            .with_vault(Some("Local"), Some("personal"))
            .unwrap();
        let entry = access_entry(&placed, &token);
        assert!(
            entry.ends_with("provider = \"local\"\nvault = \"personal\"\n"),
            "{entry}"
        );
        let file = AccessFile::parse(&entry).unwrap();
        let found = file.find(&token_hash(&token)).unwrap();
        assert_eq!(found.provider, Some(Provider::Local));
        assert_eq!(found.vault.as_deref(), Some("personal"));
        assert_eq!(file.principals().count(), 1);
        assert_eq!(
            hex(&token_hash("abc")),
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        );
    }

    #[test]
    fn access_file_rejects_mistakes() {
        let hash = "ab".repeat(32);
        assert!(AccessFile::parse("").is_err(), "no principals");
        assert!(
            AccessFile::parse(&format!(
                "[[principal]]\nsubject = \"a\"\ntoken_sha256 = \"{hash}\"\nscopes = [\"read\"]\ndomains = [\"*\"]\npassword = \"x\"\n"
            ))
            .is_err(),
            "unknown fields"
        );
        assert!(
            AccessFile::parse(
                "[[principal]]\nsubject = \"a\"\ntoken_sha256 = \"abc\"\nscopes = [\"read\"]\ndomains = [\"*\"]\n"
            )
            .is_err(),
            "short hash"
        );
        assert!(
            AccessFile::parse(&format!(
                "[[principal]]\nsubject = \"a\"\ntoken_sha256 = \"{hash}\"\nscopes = [\"read\"]\ndomains = [\"*\"]\nprovider = \"gpt\"\n"
            ))
            .is_err(),
            "unknown provider"
        );
        let twice = format!(
            "[[principal]]\nsubject = \"a\"\ntoken_sha256 = \"{hash}\"\nscopes = [\"read\"]\ndomains = [\"*\"]\n"
        );
        assert!(
            AccessFile::parse(&format!("{twice}{twice}")).is_err(),
            "duplicates"
        );
    }
}
