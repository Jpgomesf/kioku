//! Vaults and model locks: which memories one MCP session may see.
//!
//! A vault is everything about one company or one part of life. Its areas are
//! domains. Vaults never see each other, in either direction. A lock limits
//! which model providers may read an area (in `vaults.toml`) or one note (the
//! frontmatter key `lock`).
//!
//! Without a vaults file Kioku runs in compatibility mode: no vault rules at
//! all, only the access profile in [`crate::access`]. With one, each session
//! is placed in at most one vault ([`Session`]), from its repository's git
//! remote or its folder, and declares the provider of its model. A session
//! that isn't placed, or names no provider, sees nothing. A [`Viewer`] is what
//! the application layer filters by; the CLI and evaluation pass none.

mod config;
mod place;

pub use config::{Vaults, expand_home};

use std::fmt;
use std::path::Path;
use std::sync::Arc;

use anyhow::{Result, bail};

use crate::access::{Pattern, Principal};
use crate::error::UserError;
use crate::model::{Note, NoteInput};

/// Who serves the model behind a client, as the client declares it in
/// `MEMORY_PROVIDER` or an access-file entry.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub enum Provider {
    /// A model running on this machine.
    Local,
    Anthropic,
    OpenAi,
    Moonshot,
    DeepSeek,
    Google,
    /// Any other hosted provider.
    Other,
}

impl Provider {
    pub const ALL: [Self; 7] = [
        Self::Local,
        Self::Anthropic,
        Self::OpenAi,
        Self::Moonshot,
        Self::DeepSeek,
        Self::Google,
        Self::Other,
    ];

    pub fn parse(text: &str) -> Result<Self> {
        let wanted = text.trim().to_ascii_lowercase();
        match Self::ALL.into_iter().find(|p| p.as_str() == wanted) {
            Some(provider) => Ok(provider),
            None => bail!(
                "unknown model provider {:?}; use {}",
                text.trim(),
                Self::names()
            ),
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::Anthropic => "anthropic",
            Self::OpenAi => "openai",
            Self::Moonshot => "moonshot",
            Self::DeepSeek => "deepseek",
            Self::Google => "google",
            Self::Other => "other",
        }
    }

    /// Every provider name, for messages.
    pub fn names() -> &'static str {
        "local, anthropic, openai, moonshot, deepseek, google, or other"
    }
}

impl fmt::Display for Provider {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Trace-file label for sessions that were not placed in a vault. Vault names
/// can't start with `_`, so it never names a real vault's file.
pub const UNPLACED_LABEL: &str = "_unplaced";
/// Trace-file label in compatibility mode, where no vault names exist.
pub const OPEN_LABEL: &str = "default";

/// What one MCP session may see, decided before any tool runs: once per
/// process over stdio, once per request over HTTP.
#[derive(Clone, Debug)]
pub enum Session {
    /// No vaults file: compatibility mode. Only the access profile applies.
    Open,
    /// Placed in a vault, with a provider the vault allows.
    Placed(Placement),
    /// Vault mode, but this session gets no memories. The text says why and
    /// how to fix it, for the refused error every tool returns.
    Refused(String),
}

/// A session's vault, its area if any, and its model provider.
#[derive(Clone, Debug)]
pub struct Placement {
    vaults: Arc<Vaults>,
    index: usize,
    area: Option<String>,
    provider: Provider,
}

impl Placement {
    pub fn vault(&self) -> &str {
        &self.vaults.vault(self.index).name
    }

    pub fn area(&self) -> Option<&str> {
        self.area.as_deref()
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    /// The domain a call uses when it names none: the area, else the vault's
    /// `default_domain`.
    pub fn default_domain(&self) -> &str {
        self.area
            .as_deref()
            .unwrap_or(&self.vaults.vault(self.index).default_domain)
    }

    /// True at the vault's root (in no area), where search covers the whole vault.
    pub fn at_root(&self) -> bool {
        self.area.is_none()
    }

    /// Whether `domain` belongs to this vault and its locks admit the provider.
    fn verdict(&self, domain: &str) -> Verdict {
        let owners = self.vaults.owners(domain);
        match owners.as_slice() {
            [only] if *only == self.index => {}
            several if several.len() > 1 && several.contains(&self.index) => {
                return Verdict::Ambiguous(
                    several
                        .iter()
                        .map(|i| self.vaults.vault(*i).name.clone())
                        .collect(),
                );
            }
            _ => return Verdict::OutsideVault,
        }
        if self.vaults.locked(domain, self.provider) {
            Verdict::Locked
        } else {
            Verdict::Visible
        }
    }
}

impl Session {
    /// The session of a stdio process: placed by `folder` (`KIOKU_SESSION_DIR`
    /// or the working directory), with the provider from `MEMORY_PROVIDER`.
    pub fn for_folder(
        vaults: Option<&Arc<Vaults>>,
        provider: Option<&str>,
        folder: Option<&Path>,
    ) -> Self {
        let Some(vaults) = vaults else {
            return Self::Open;
        };
        let provider = match declared_provider(provider) {
            Ok(provider) => provider,
            Err(text) => return Self::Refused(text),
        };
        let Some(folder) = folder else {
            return Self::Refused(
                "Kioku cannot tell which folder this session started in, so it has no memories. Set KIOKU_SESSION_DIR to the project folder in this client's MCP config env".to_owned(),
            );
        };
        let file = vaults.file().display();
        match vaults.place(folder) {
            Err(reason) => Self::Refused(format!(
                "this session started in {}, and {reason}, so it has no memories. Fix {file} so that one vault matches, then restart the client",
                folder.display()
            )),
            Ok(None) => Self::Refused(format!(
                "this session started in {}, which no vault in {file} covers, so it has no memories. Add that folder (or a parent) to a vault's paths, or its git remote to git_remotes, then restart the client. If the client doesn't start Kioku in the project, set KIOKU_SESSION_DIR in its MCP config env",
                folder.display()
            )),
            Ok(Some(spot)) => Self::admit(vaults, spot.vault, spot.area, provider),
        }
    }

    /// The session of an HTTP principal: the vault and provider named in its
    /// access-file entry, at the vault's root.
    pub fn for_principal(vaults: Option<&Arc<Vaults>>, principal: &Principal) -> Self {
        let Some(vaults) = vaults else {
            return Self::Open;
        };
        let file = vaults.file().display();
        let (Some(provider), Some(name)) = (principal.provider, principal.vault.as_deref()) else {
            return Self::Refused(format!(
                "connection {:?} has no provider and vault in the access file, and {file} is in use, so it gets no memories. Add provider = \"...\" and vault = \"...\" to its [[principal]] entry",
                principal.subject
            ));
        };
        match vaults.find(name) {
            Some(index) => Self::admit(vaults, index, None, provider),
            None => Self::Refused(format!(
                "connection {:?} names vault {name:?}, which {file} does not define, so it gets no memories",
                principal.subject
            )),
        }
    }

    fn admit(vaults: &Arc<Vaults>, index: usize, area: Option<String>, provider: Provider) -> Self {
        let vault = vaults.vault(index);
        if !vault.providers.contains(&provider) {
            let allowed: Vec<&str> = vault.providers.iter().map(|p| p.as_str()).collect();
            return Self::Refused(format!(
                "vault {:?} does not allow provider {provider} (it allows {}), so this session has no memories. Add the provider to that vault in {} if this client should see it",
                vault.name,
                allowed.join(", "),
                vaults.file().display()
            ));
        }
        Self::Placed(Placement {
            vaults: Arc::clone(vaults),
            index,
            area,
            provider,
        })
    }

    pub fn placement(&self) -> Option<&Placement> {
        match self {
            Self::Placed(placement) => Some(placement),
            Self::Open | Self::Refused(_) => None,
        }
    }

    /// Why this session gets nothing, if it doesn't.
    pub fn refusal(&self) -> Option<&str> {
        match self {
            Self::Refused(text) => Some(text),
            Self::Open | Self::Placed(_) => None,
        }
    }

    /// The vault's name in trace records: absent in compatibility mode and for
    /// refused sessions.
    pub fn vault_name(&self) -> Option<&str> {
        self.placement().map(Placement::vault)
    }

    /// The label that replaces `{vault}` in `MEMORY_TRACE_FILE`.
    pub fn trace_label(&self) -> &str {
        match self {
            Self::Open => OPEN_LABEL,
            Self::Placed(placement) => placement.vault(),
            Self::Refused(_) => UNPLACED_LABEL,
        }
    }
}

/// `MEMORY_PROVIDER`, or why it can't be used.
fn declared_provider(raw: Option<&str>) -> Result<Provider, String> {
    match raw.map(str::trim).filter(|p| !p.is_empty()) {
        None => Err(format!(
            "MEMORY_PROVIDER is not set for this client, so Kioku shares no memories with it. Set MEMORY_PROVIDER to the provider of its model ({}) in this client's MCP config env, not in .env",
            Provider::names()
        )),
        Some(raw) => Provider::parse(raw).map_err(|_| {
            format!(
                "MEMORY_PROVIDER {raw:?} is not a known model provider, so Kioku shares no memories with this client. Use {} in this client's MCP config env",
                Provider::names()
            )
        }),
    }
}

/// Whether a domain may be seen, and if not, why.
enum Verdict {
    Visible,
    /// Outside the access profile's domain patterns.
    OutsideProfile,
    OutsideVault,
    /// An area lock leaves out this session's provider.
    Locked,
    /// The domain matches this vault and others: a configuration error.
    Ambiguous(Vec<String>),
    /// The session was refused.
    Nothing,
}

/// What the application filters notes by. Built from a principal and its
/// session; the CLI and evaluation pass no viewer and see everything.
#[derive(Clone, Debug)]
pub struct Viewer {
    /// The access profile's domain patterns.
    domains: Vec<Pattern>,
    scope: Scope,
}

#[derive(Clone, Debug)]
enum Scope {
    /// Compatibility mode: the access profile alone decides.
    Open,
    Vault(Placement),
    /// A refused session: nothing at all.
    Nothing,
}

impl Viewer {
    pub fn new(principal: &Principal, session: &Session) -> Self {
        Self {
            domains: principal.domains.clone(),
            scope: match session {
                Session::Open => Scope::Open,
                Session::Placed(placement) => Scope::Vault(placement.clone()),
                Session::Refused(_) => Scope::Nothing,
            },
        }
    }

    fn verdict(&self, domain: &str) -> Verdict {
        if matches!(self.scope, Scope::Nothing) {
            return Verdict::Nothing;
        }
        if !self.domains.iter().any(|pattern| pattern.matches(domain)) {
            return Verdict::OutsideProfile;
        }
        match &self.scope {
            Scope::Open => Verdict::Visible,
            Scope::Vault(placement) => placement.verdict(domain),
            Scope::Nothing => Verdict::Nothing,
        }
    }

    /// Whether this viewer may see `domain`. A domain that matches this
    /// session's vault and another one is a configuration error, reported as
    /// a refused error; a domain of other vaults is simply invisible.
    pub fn sees_domain(&self, domain: &str) -> Result<bool> {
        match self.verdict(domain) {
            Verdict::Visible => Ok(true),
            Verdict::Ambiguous(names) => Err(self.ambiguous(domain, &names)),
            Verdict::OutsideProfile
            | Verdict::OutsideVault
            | Verdict::Locked
            | Verdict::Nothing => Ok(false),
        }
    }

    /// Refuse a domain this viewer may not use, saying why. The access
    /// profile's own message comes from the MCP layer, which checks it first.
    pub fn check_domain(&self, domain: &str) -> Result<()> {
        let text = match (self.verdict(domain), &self.scope) {
            (Verdict::Visible, _) => return Ok(()),
            (Verdict::Ambiguous(names), _) => return Err(self.ambiguous(domain, &names)),
            (Verdict::OutsideVault, Scope::Vault(placement)) => {
                let patterns: Vec<String> = placement
                    .vaults
                    .vault(placement.index)
                    .domains
                    .iter()
                    .map(ToString::to_string)
                    .collect();
                format!(
                    "domain {domain:?} is not in vault {:?}, the only vault this session may use. Its domains match {}. Use one of those, or omit domain",
                    placement.vault(),
                    patterns.join(", ")
                )
            }
            (Verdict::Locked, Scope::Vault(placement)) => format!(
                "domain {domain:?} is locked: models from provider {} may not read or save memories there",
                placement.provider
            ),
            (Verdict::OutsideProfile, _) => {
                format!("domain {domain:?} is outside this connection's domain patterns")
            }
            _ => "this session has no memories".to_owned(),
        };
        Err(UserError::Refused(text).into())
    }

    fn ambiguous(&self, domain: &str, names: &[String]) -> anyhow::Error {
        let file = match &self.scope {
            Scope::Vault(placement) => placement.vaults.file().display().to_string(),
            Scope::Open | Scope::Nothing => "the vaults file".to_owned(),
        };
        UserError::Refused(format!(
            "domain {domain:?} matches the domains of vaults {} in {file}, but each domain must belong to one vault. Ask the user to fix that file",
            names.join(" and ")
        ))
        .into()
    }

    /// Whether this viewer may read a note: its domain is visible and its
    /// note lock, if any, lists the session's provider. Fails closed: a domain
    /// claimed by two vaults hides the note.
    pub fn sees_input(&self, input: &NoteInput) -> bool {
        self.sees_locked(&input.domain, &input.lock)
    }

    /// Whether this viewer may read a note of `domain` with note lock `lock`
    /// (empty for none), as [`Viewer::sees_input`] decides.
    pub fn sees_locked(&self, domain: &str, lock: &[String]) -> bool {
        if !matches!(self.verdict(domain), Verdict::Visible) {
            return false;
        }
        match &self.scope {
            Scope::Vault(placement) => {
                lock.is_empty()
                    || lock
                        .iter()
                        .any(|name| Provider::parse(name).is_ok_and(|p| p == placement.provider))
            }
            Scope::Open => true,
            Scope::Nothing => false,
        }
    }

    pub fn sees(&self, note: &Note) -> bool {
        self.sees_input(&note.input)
    }

    /// True when notes in a visible domain may still be hidden (vault mode),
    /// so callers must filter individual notes and the links between them.
    pub fn restricts_notes(&self) -> bool {
        !matches!(self.scope, Scope::Open)
    }
}

#[cfg(test)]
mod tests;
