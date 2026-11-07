//! Reading and checking `vaults.toml`.
//!
//! Every rule that can be checked without the store is checked at startup,
//! and any mistake stops the server: a typo must never widen what a session
//! sees. Paths may start with `~`, which stands for `$HOME`.

use std::collections::BTreeSet;
use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::access::Pattern;

use super::Provider;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FileToml {
    #[serde(default)]
    vault: Vec<VaultToml>,
    #[serde(default)]
    area: Vec<AreaToml>,
    #[serde(default)]
    lock: Vec<LockToml>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct VaultToml {
    name: String,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    git_remotes: Vec<String>,
    domains: Vec<String>,
    providers: Vec<String>,
    default_domain: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct AreaToml {
    domain: String,
    paths: Vec<String>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct LockToml {
    domains: Vec<String>,
    providers: Vec<String>,
}

/// The parsed vaults file.
#[derive(Debug)]
pub struct Vaults {
    file: PathBuf,
    /// Where `~/.ssh/config` is looked for, to resolve SSH host aliases in
    /// git remotes.
    pub(super) home: Option<PathBuf>,
    pub(super) vaults: Vec<Vault>,
    pub(super) areas: Vec<Area>,
    locks: Vec<Lock>,
}

#[derive(Debug)]
pub(super) struct Vault {
    pub(super) name: String,
    pub(super) paths: Vec<Folder>,
    /// Matched against the normalized, lowercase remote (`host/owner/repo`).
    pub(super) git_remotes: Vec<Pattern>,
    pub(super) domains: Vec<Pattern>,
    pub(super) providers: BTreeSet<Provider>,
    pub(super) default_domain: String,
}

impl Vault {
    fn owns(&self, domain: &str) -> bool {
        self.domains.iter().any(|pattern| pattern.matches(domain))
    }
}

/// A section of a vault that sessions under its folders search first.
#[derive(Debug)]
pub(super) struct Area {
    pub(super) domain: String,
    /// Index of the vault whose domains include this one.
    pub(super) vault: usize,
    pub(super) paths: Vec<Folder>,
}

/// Areas whose notes only some providers may read.
#[derive(Debug)]
struct Lock {
    domains: Vec<Pattern>,
    providers: BTreeSet<Provider>,
}

/// A configured folder, as written (with `~` expanded) and, when it exists at
/// startup, with symlinks resolved, so either spelling of a session's folder
/// matches it.
#[derive(Clone, Debug)]
pub(super) struct Folder {
    written: PathBuf,
    canonical: Option<PathBuf>,
}

impl Folder {
    fn parse(text: &str, home: Option<&Path>) -> Result<Self> {
        let written = lexical(&expand_home(text, home)?);
        ensure!(
            written.is_absolute(),
            "path {:?} must be absolute or start with ~",
            text.trim()
        );
        let canonical = written.canonicalize().ok().filter(|c| *c != written);
        Ok(Self { written, canonical })
    }

    pub(super) fn forms(&self) -> impl Iterator<Item = &Path> {
        std::iter::once(self.written.as_path()).chain(self.canonical.as_deref())
    }

    /// How many components the longest spelling of this folder has, if it
    /// contains any spelling of the session's folder.
    pub(super) fn depth_containing(&self, session: &[PathBuf]) -> Option<usize> {
        self.forms()
            .filter(|form| session.iter().any(|s| s.starts_with(form)))
            .map(|form| form.components().count())
            .max()
    }

    fn overlaps(&self, other: &Self) -> bool {
        self.forms().any(|a| other.forms().any(|b| a == b))
    }
}

impl std::fmt::Display for Folder {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "{}", self.written.display())
    }
}

/// `~` and `~/...` become `home`.
pub fn expand_home(text: &str, home: Option<&Path>) -> Result<PathBuf> {
    let text = text.trim();
    let home = || home.context("paths starting with ~ need HOME to be set");
    if text == "~" {
        return Ok(home()?.to_path_buf());
    }
    if let Some(rest) = text.strip_prefix("~/") {
        return Ok(home()?.join(rest));
    }
    ensure!(
        !text.starts_with('~'),
        "path {text:?}: only ~ and ~/ are supported, not ~user"
    );
    Ok(PathBuf::from(text))
}

/// `path` without `.` components, and with `..` applied, without touching the
/// file system.
pub(super) fn lexical(path: &Path) -> PathBuf {
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

/// Vault names appear in trace file names, so they stay short and plain.
fn valid_name(name: &str) -> bool {
    let mut chars = name.chars();
    name.len() <= 64
        && chars
            .next()
            .is_some_and(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        && chars.all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' || c == '_')
}

fn providers(list: &[String], what: &str) -> Result<BTreeSet<Provider>> {
    list.iter()
        .map(|name| Provider::parse(name).with_context(|| what.to_owned()))
        .collect()
}

fn patterns(list: &[String], what: &str) -> Result<Vec<Pattern>> {
    list.iter()
        .map(|source| Pattern::parse(source).with_context(|| what.to_owned()))
        .collect()
}

/// Globs match the lowercase remote, so they are lowercased too. A `re:`
/// pattern is kept as written.
fn remote_pattern(source: &str) -> Result<Pattern> {
    let source = source.trim();
    if source.starts_with("re:") {
        Pattern::parse(source)
    } else {
        Pattern::parse(&source.to_lowercase())
    }
}

impl Vault {
    fn parse(entry: VaultToml, home: Option<&Path>) -> Result<Self> {
        let name = entry.name.trim().to_owned();
        ensure!(
            valid_name(&name),
            "vault name {name:?} must be 1 to 64 lowercase letters, digits, - or _, starting with a letter or digit"
        );
        let what = format!("vault {name:?}");
        ensure!(!entry.domains.is_empty(), "{what} lists no domains");
        ensure!(
            !entry.providers.is_empty(),
            "{what} lists no providers, so no client could read it"
        );
        let default_domain = entry.default_domain.trim().to_owned();
        ensure!(
            !default_domain.is_empty(),
            "{what} has an empty default_domain"
        );
        Ok(Self {
            paths: entry
                .paths
                .iter()
                .map(|path| Folder::parse(path, home))
                .collect::<Result<_>>()
                .with_context(|| what.clone())?,
            git_remotes: entry
                .git_remotes
                .iter()
                .map(|source| remote_pattern(source))
                .collect::<Result<_>>()
                .with_context(|| what.clone())?,
            domains: patterns(&entry.domains, &what)?,
            providers: providers(&entry.providers, &what)?,
            default_domain,
            name,
        })
    }
}

impl Vaults {
    /// Read the vaults file. A file that doesn't exist means compatibility
    /// mode (`None`); any other problem is an error.
    pub fn load(path: &Path, home: Option<&Path>) -> Result<Option<Self>> {
        let text = match std::fs::read_to_string(path) {
            Ok(text) => text,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("cannot read vaults file {}", path.display()));
            }
        };
        Self::parse(&text, path, home)
            .with_context(|| format!("in vaults file {}", path.display()))
            .map(Some)
    }

    /// Parse and check vaults-file text. `file` names it in messages.
    pub fn parse(text: &str, file: &Path, home: Option<&Path>) -> Result<Self> {
        let parsed: FileToml = toml::from_str(text).context("invalid vaults file")?;
        ensure!(
            !parsed.vault.is_empty(),
            "the vaults file lists no [[vault]] entries; delete it to run without vaults"
        );
        let vaults = parsed
            .vault
            .into_iter()
            .map(|entry| Vault::parse(entry, home))
            .collect::<Result<Vec<_>>>()?;
        for (i, vault) in vaults.iter().enumerate() {
            ensure!(
                vaults[..i].iter().all(|other| other.name != vault.name),
                "vault {:?} is listed twice",
                vault.name
            );
            ensure!(
                vault.owns(&vault.default_domain),
                "vault {:?}: default_domain {:?} matches none of its domains",
                vault.name,
                vault.default_domain
            );
            for (j, other) in vaults.iter().enumerate().filter(|(j, _)| *j != i) {
                ensure!(
                    !other.owns(&vault.default_domain),
                    "default_domain {:?} of vault {:?} also matches the domains of vault {:?}; each domain must belong to one vault",
                    vault.default_domain,
                    vault.name,
                    other.name
                );
                if j > i {
                    for folder in &vault.paths {
                        ensure!(
                            !other.paths.iter().any(|o| o.overlaps(folder)),
                            "folder {folder} is in the paths of both vault {:?} and vault {:?}",
                            vault.name,
                            other.name
                        );
                    }
                }
            }
        }
        let mut areas: Vec<Area> = Vec::new();
        for entry in parsed.area {
            let domain = entry.domain.trim().to_owned();
            ensure!(!domain.is_empty(), "an [[area]] has an empty domain");
            let owners: Vec<usize> = (0..vaults.len())
                .filter(|i| vaults[*i].owns(&domain))
                .collect();
            let vault = match owners.as_slice() {
                [] => bail!("area {domain:?} matches the domains of no vault"),
                [only] => *only,
                several => bail!(
                    "area {domain:?} matches the domains of vaults {}; each domain must belong to one vault",
                    several
                        .iter()
                        .map(|i| format!("{:?}", vaults[*i].name))
                        .collect::<Vec<_>>()
                        .join(" and ")
                ),
            };
            ensure!(!entry.paths.is_empty(), "area {domain:?} lists no paths");
            let paths = entry
                .paths
                .iter()
                .map(|path| Folder::parse(path, home))
                .collect::<Result<Vec<_>>>()
                .with_context(|| format!("area {domain:?}"))?;
            for other in areas.iter().filter(|a| a.domain != domain) {
                for folder in &paths {
                    ensure!(
                        !other.paths.iter().any(|o| o.overlaps(folder)),
                        "folder {folder} is in the paths of both area {domain:?} and area {:?}",
                        other.domain
                    );
                }
            }
            areas.push(Area {
                domain,
                vault,
                paths,
            });
        }
        let locks = parsed
            .lock
            .into_iter()
            .map(|entry| {
                ensure!(!entry.domains.is_empty(), "a [[lock]] lists no domains");
                Ok(Lock {
                    domains: patterns(&entry.domains, "a [[lock]]")?,
                    providers: providers(&entry.providers, "a [[lock]]")?,
                })
            })
            .collect::<Result<_>>()?;
        Ok(Self {
            file: file.to_path_buf(),
            home: home.map(Path::to_path_buf),
            vaults,
            areas,
            locks,
        })
    }

    /// The vaults file, for messages.
    pub fn file(&self) -> &Path {
        &self.file
    }

    pub(super) fn vault(&self, index: usize) -> &Vault {
        &self.vaults[index]
    }

    /// The vault named `name`.
    pub fn find(&self, name: &str) -> Option<usize> {
        self.vaults.iter().position(|vault| vault.name == name)
    }

    /// Indexes of the vaults whose domain patterns match `domain`.
    pub(super) fn owners(&self, domain: &str) -> Vec<usize> {
        (0..self.vaults.len())
            .filter(|i| self.vaults[*i].owns(domain))
            .collect()
    }

    /// Whether `provider` may read the notes of `domain`: exactly one vault
    /// owns it, that vault lists the provider, and no area lock leaves it out.
    pub fn admits(&self, domain: &str, provider: Provider) -> bool {
        matches!(self.owners(domain).as_slice(), [only] if self.vaults[*only].providers.contains(&provider))
            && !self.locked(domain, provider)
    }

    /// Whether a lock covering `domain` leaves out `provider`.
    pub(super) fn locked(&self, domain: &str, provider: Provider) -> bool {
        self.locks.iter().any(|lock| {
            lock.domains.iter().any(|pattern| pattern.matches(domain))
                && !lock.providers.contains(&provider)
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const HOME: &str = "/home/me";

    fn parse(text: &str) -> Result<Vaults> {
        Vaults::parse(text, Path::new("/cfg/vaults.toml"), Some(Path::new(HOME)))
    }

    const TWO: &str = r#"
        [[vault]]
        name = "personal"
        paths = ["~"]
        domains = ["personal", "personal/*", "kioku", "local"]
        providers = ["local", "anthropic"]
        default_domain = "personal"

        [[vault]]
        name = "acme"
        paths = ["~/work/acme"]
        git_remotes = ["github.com/Acme-Corp/*"]
        domains = ["acme", "acme/*"]
        providers = ["local", "anthropic", "openai"]
        default_domain = "acme"

        [[area]]
        domain = "personal/kioku"
        paths = ["~/projects/personal/mcp/kioku"]

        [[lock]]
        domains = ["personal/citizenship"]
        providers = ["local"]
    "#;

    #[test]
    fn parses_vaults_areas_and_locks() {
        let vaults = parse(TWO).unwrap();
        assert_eq!(vaults.vaults.len(), 2);
        assert_eq!(vaults.find("acme"), Some(1));
        assert_eq!(vaults.find("work"), None);
        let personal = vaults.vault(0);
        assert_eq!(personal.paths[0].written, PathBuf::from(HOME));
        assert_eq!(
            personal.providers,
            [Provider::Local, Provider::Anthropic].into()
        );
        assert!(
            vaults.vault(1).git_remotes[0].matches("github.com/acme-corp/api"),
            "remote globs are lowercased"
        );
        assert_eq!(vaults.areas[0].vault, 0);
        assert_eq!(vaults.owners("personal/kioku"), [0]);
        assert_eq!(vaults.owners("acme/api"), [1]);
        assert!(vaults.owners("elsewhere").is_empty());
        assert!(vaults.locked("personal/citizenship", Provider::Anthropic));
        assert!(!vaults.locked("personal/citizenship", Provider::Local));
        assert!(!vaults.locked("personal/kioku", Provider::Anthropic));
    }

    #[test]
    fn rejects_mistakes_instead_of_widening_access() {
        let vault = |extra: &str| {
            format!(
                "[[vault]]\nname = \"a\"\ndomains = [\"a\", \"a/*\"]\nproviders = [\"local\"]\ndefault_domain = \"a\"\n{extra}"
            )
        };
        assert!(parse(&vault("")).is_ok());
        for (label, text) in [
            ("no vaults", String::new()),
            ("unknown field", vault("color = \"red\"\n")),
            (
                "unknown provider",
                vault("").replace("\"local\"", "\"lokal\""),
            ),
            ("no providers", vault("").replace("[\"local\"]", "[]")),
            ("no domains", vault("").replace("[\"a\", \"a/*\"]", "[]")),
            ("bad pattern", vault("").replace("\"a/*\"", "\"re:(\"")),
            ("relative path", vault("paths = [\"projects\"]\n")),
            ("~user path", vault("paths = [\"~other/x\"]\n")),
            (
                "bad name",
                vault("").replace("name = \"a\"", "name = \"A b\""),
            ),
            (
                "reserved name",
                vault("").replace("name = \"a\"", "name = \"_a\""),
            ),
            (
                "default outside the vault",
                vault("").replace("default_domain = \"a\"", "default_domain = \"b\""),
            ),
            ("twice", format!("{}{}", vault(""), vault(""))),
            (
                "area in no vault",
                vault("[[area]]\ndomain = \"b\"\npaths = [\"/x\"]\n"),
            ),
            (
                "area without paths",
                vault("[[area]]\ndomain = \"a/x\"\npaths = []\n"),
            ),
            (
                "lock without domains",
                vault("[[lock]]\ndomains = []\nproviders = []\n"),
            ),
            ("unknown table", vault("[[team]]\nname = \"x\"\n")),
        ] {
            assert!(parse(&text).is_err(), "accepted {label}");
        }
        let b = "[[vault]]\nname = \"b\"\ndomains = [\"b\", \"shared\"]\nproviders = [\"local\"]\ndefault_domain = \"b\"\n";
        let overlapping_default = format!(
            "{}{b}",
            vault("").replace("[\"a\", \"a/*\"]", "[\"a\", \"b\"]")
        );
        assert!(
            parse(&overlapping_default).is_err(),
            "default in two vaults"
        );
        let shared_area = format!(
            "{}{b}[[area]]\ndomain = \"shared\"\npaths = [\"/s\"]\n",
            vault("").replace("[\"a\", \"a/*\"]", "[\"a\", \"shared\"]")
        );
        assert!(parse(&shared_area).is_err(), "area in two vaults");
        let same_folder = format!(
            "{}{}",
            vault("paths = [\"/p\"]\n"),
            b.replace("default_domain", "paths = [\"/p/\"]\ndefault_domain")
        );
        assert!(parse(&same_folder).is_err(), "one folder in two vaults");
        let same_area_folder = vault(
            "[[area]]\ndomain = \"a/x\"\npaths = [\"/p\"]\n[[area]]\ndomain = \"a/y\"\npaths = [\"/p/./\"]\n",
        );
        assert!(parse(&same_area_folder).is_err(), "one folder in two areas");
        let sealed = vault("[[lock]]\ndomains = [\"a/sealed\"]\nproviders = []\n");
        let sealed = parse(&sealed).unwrap();
        assert!(
            sealed.locked("a/sealed", Provider::Local),
            "an empty provider list locks everyone out"
        );
    }

    #[test]
    fn a_missing_file_means_compatibility_mode() {
        let missing = std::env::temp_dir().join(format!(
            "kioku-no-vaults-{}.toml",
            uuid::Uuid::new_v4().simple()
        ));
        assert!(Vaults::load(&missing, None).unwrap().is_none());
        let dir = std::env::temp_dir().join(format!("kioku-vaults-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let broken = dir.join("vaults.toml");
        std::fs::write(&broken, "[[vault]]\nname = 1\n").unwrap();
        let error = format!("{:#}", Vaults::load(&broken, None).unwrap_err());
        assert!(error.contains("vaults.toml"), "{error}");
        assert!(
            Vaults::load(&dir, None).is_err(),
            "a folder is not a vaults file"
        );
        std::fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn home_expansion_and_lexical_paths() {
        let home = Some(Path::new(HOME));
        assert_eq!(expand_home("~", home).unwrap(), PathBuf::from(HOME));
        assert_eq!(
            expand_home(" ~/a/b ", home).unwrap(),
            PathBuf::from("/home/me/a/b")
        );
        assert_eq!(expand_home("/x", None).unwrap(), PathBuf::from("/x"));
        assert!(expand_home("~/x", None).is_err());
        assert_eq!(lexical(Path::new("/a/./b/../c/")), PathBuf::from("/a/c"));
    }
}
