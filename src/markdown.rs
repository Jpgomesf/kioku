//! Parsing focused Markdown notes: YAML frontmatter, title, and labels.
//!
//! Note text is evidence, never executable instructions.
//!
//! A note lock must fail closed: a `lock` key that lists no provider, or a
//! key that looks like a misspelled `lock` (`Lock`, `locks`, `locked`), makes
//! the file fail instead of importing the note unlocked.

use std::collections::BTreeSet;
use std::path::Path;

use anyhow::{Context, Result, bail, ensure};
use serde::Deserialize;

use crate::model::NoteInput;
use crate::vault::Provider;

/// Frontmatter fields Kioku reads. Other fields (Obsidian dates, CSS classes,
/// and so on) are ignored, except near misses of `lock`. Plain YAML scalars
/// such as `2024` are accepted as strings; booleans must be `true` or `false`.
#[derive(Debug, Default, Deserialize)]
#[serde(default)]
struct Frontmatter {
    key: Option<String>,
    id: Option<String>,
    title: Option<String>,
    domain: Option<String>,
    aliases: Option<OneOrMany>,
    alias: Option<OneOrMany>,
    related: Option<OneOrMany>,
    tags: Option<OneOrMany>,
    confidence: Option<f64>,
    pinned: Option<bool>,
    /// Model providers that may read the note, one or a list. `Some` whenever
    /// the key is present, even as `lock:` with no value, so an empty lock is
    /// an error rather than no lock.
    #[serde(deserialize_with = "present")]
    lock: Option<OneOrMany>,
}

/// A field that is `Some` when present, even when its value is null.
fn present<'de, D: serde::Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<OneOrMany>, D::Error> {
    OneOrMany::deserialize(deserializer).map(Some)
}

/// The top-level keys of a frontmatter mapping. Keys that aren't strings
/// (numbers, lists) are left out; none of them can be a near miss of `lock`.
struct TopKeys(Vec<String>);

impl<'de> Deserialize<'de> for TopKeys {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeysVisitor;

        impl<'de> serde::de::Visitor<'de> for KeysVisitor {
            type Value = TopKeys;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a mapping")
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<TopKeys, A::Error> {
                let mut keys = Vec::new();
                while let Some(KeyText(key)) = map.next_key()? {
                    map.next_value::<serde::de::IgnoredAny>()?;
                    keys.extend(key);
                }
                Ok(TopKeys(keys))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<TopKeys, E> {
                Ok(TopKeys(Vec::new()))
            }
        }

        deserializer.deserialize_map(KeysVisitor)
    }
}

/// A mapping key, or `None` for a key that isn't a string.
struct KeyText(Option<String>);

impl<'de> Deserialize<'de> for KeyText {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct KeyVisitor;

        impl<'de> serde::de::Visitor<'de> for KeyVisitor {
            type Value = KeyText;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a mapping key")
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<KeyText, E> {
                Ok(KeyText(Some(v.to_owned())))
            }
            fn visit_bool<E: serde::de::Error>(self, _: bool) -> Result<KeyText, E> {
                Ok(KeyText(None))
            }
            fn visit_i64<E: serde::de::Error>(self, _: i64) -> Result<KeyText, E> {
                Ok(KeyText(None))
            }
            fn visit_u64<E: serde::de::Error>(self, _: u64) -> Result<KeyText, E> {
                Ok(KeyText(None))
            }
            fn visit_f64<E: serde::de::Error>(self, _: f64) -> Result<KeyText, E> {
                Ok(KeyText(None))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<KeyText, E> {
                Ok(KeyText(None))
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<KeyText, A::Error> {
                while seq.next_element::<serde::de::IgnoredAny>()?.is_some() {}
                Ok(KeyText(None))
            }
            fn visit_map<A: serde::de::MapAccess<'de>>(
                self,
                mut map: A,
            ) -> Result<KeyText, A::Error> {
                while map
                    .next_entry::<serde::de::IgnoredAny, serde::de::IgnoredAny>()?
                    .is_some()
                {}
                Ok(KeyText(None))
            }
        }

        deserializer.deserialize_any(KeyVisitor)
    }
}

/// A top-level key that looks like `lock` but isn't, so Kioku would ignore
/// it and leave the note unlocked.
fn misspelled_lock(yaml: &str) -> Option<String> {
    // The frontmatter already parsed, so a key walk that fails can only mean
    // exotic keys; the `lock` key itself has been read either way.
    let TopKeys(keys) = serde_saphyr::from_str(yaml).ok()?;
    keys.into_iter().find(|key| {
        let lower = key.trim().to_lowercase();
        key != "lock" && matches!(lower.as_str(), "lock" | "locks" | "locked")
    })
}

/// A frontmatter list that may also be written as a single value. Plain
/// scalars (`2024`, `true`) are kept as text.
#[derive(Debug)]
struct OneOrMany(Vec<String>);

impl OneOrMany {
    fn into_vec(self) -> Vec<String> {
        self.0
    }
}

/// One scalar written as text.
struct Scalar(String);

struct ScalarVisitor;

impl<'de> serde::de::Visitor<'de> for ScalarVisitor {
    type Value = String;

    fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("a string (quote [[wiki links]] inside lists)")
    }
    fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<String, E> {
        Ok(v.to_owned())
    }
    fn visit_string<E: serde::de::Error>(self, v: String) -> Result<String, E> {
        Ok(v)
    }
    fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<String, E> {
        Ok(v.to_string())
    }
    fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<String, E> {
        Ok(v.to_string())
    }
}

impl<'de> Deserialize<'de> for Scalar {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        deserializer.deserialize_any(ScalarVisitor).map(Scalar)
    }
}

impl<'de> Deserialize<'de> for OneOrMany {
    fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct ListVisitor;

        impl<'de> serde::de::Visitor<'de> for ListVisitor {
            type Value = OneOrMany;

            fn expecting(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
                f.write_str("a string or a list of strings")
            }
            fn visit_seq<A: serde::de::SeqAccess<'de>>(
                self,
                mut seq: A,
            ) -> Result<OneOrMany, A::Error> {
                let mut values = Vec::new();
                while let Some(Scalar(value)) = seq.next_element()? {
                    values.push(value);
                }
                Ok(OneOrMany(values))
            }
            fn visit_unit<E: serde::de::Error>(self) -> Result<OneOrMany, E> {
                Ok(OneOrMany(Vec::new()))
            }
            fn visit_none<E: serde::de::Error>(self) -> Result<OneOrMany, E> {
                Ok(OneOrMany(Vec::new()))
            }
            fn visit_str<E: serde::de::Error>(self, v: &str) -> Result<OneOrMany, E> {
                ScalarVisitor.visit_str(v).map(|s| OneOrMany(vec![s]))
            }
            fn visit_string<E: serde::de::Error>(self, v: String) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v]))
            }
            fn visit_i64<E: serde::de::Error>(self, v: i64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_u64<E: serde::de::Error>(self, v: u64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_f64<E: serde::de::Error>(self, v: f64) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
            fn visit_bool<E: serde::de::Error>(self, v: bool) -> Result<OneOrMany, E> {
                Ok(OneOrMany(vec![v.to_string()]))
            }
        }

        deserializer.deserialize_any(ListVisitor)
    }
}

fn list(values: Option<OneOrMany>) -> Vec<String> {
    values
        .map(OneOrMany::into_vec)
        .unwrap_or_default()
        .into_iter()
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
        .collect()
}

fn text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_owned())
        .filter(|value| !value.is_empty())
}

/// Parse one focused Markdown note. The actual import location supplies provenance.
/// Frontmatter `id` is accepted as a stable textual key, not a database UUID override.
/// A note whose frontmatter names no domain belongs to `default_domain`.
pub fn parse_markdown(text_in: &str, source: &str, default_domain: &str) -> Result<NoteInput> {
    parse(text_in, source, Some(default_domain))
}

/// Like [`parse_markdown`], but the frontmatter must name the note's domain.
/// Vault imports use this: one notes folder serves every vault, so a file
/// that doesn't say where it belongs must not adopt the importer's domain.
pub fn parse_markdown_declared(text_in: &str, source: &str) -> Result<NoteInput> {
    parse(text_in, source, None)
}

fn parse(text_in: &str, source: &str, default_domain: Option<&str>) -> Result<NoteInput> {
    // A BOM and Windows line endings should not prevent frontmatter recognition.
    let normalized = text_in.trim_start_matches('\u{feff}').replace("\r\n", "\n");
    let (frontmatter, body) = split_frontmatter(&normalized)?;
    let meta: Frontmatter = match frontmatter {
        Some(yaml) if !yaml.trim().is_empty() => {
            let meta = serde_saphyr::from_str_with_options(
                yaml,
                serde_saphyr::options! { strict_booleans: true },
            )
            .context("invalid YAML frontmatter (quote [[wiki links]] inside lists, for example related: ['[[Note]]'])")?;
            reject_misspelled_lock(yaml)?;
            meta
        }
        _ => Frontmatter::default(),
    };
    let domain = match (text(meta.domain), default_domain) {
        (Some(domain), _) => domain,
        (None, Some(default)) => default.to_owned(),
        (None, None) => bail!(
            "the frontmatter names no domain; with vaults, every imported file must say which domain it belongs to (domain: ...)"
        ),
    };
    let lock = lock_providers(meta.lock)?;

    let fallback_key = Path::new(source)
        .file_stem()
        .and_then(|s| s.to_str())
        .filter(|s| !s.trim().is_empty())
        .unwrap_or("note");
    let key = text(meta.key)
        .or(text(meta.id))
        .unwrap_or_else(|| fallback_key.to_owned());
    let title = text(meta.title)
        .or_else(|| first_heading(body))
        .unwrap_or_else(|| key.clone());
    let mut aliases = list(meta.aliases);
    aliases.extend(list(meta.alias));
    let note = NoteInput {
        domain,
        key,
        title,
        body: body.trim().to_owned(),
        aliases: deduplicate_strings(aliases),
        related: deduplicate_strings(list(meta.related)),
        tags: deduplicate_strings(list(meta.tags)),
        source: Some(source.to_owned()),
        confidence: meta.confidence.unwrap_or(0.8),
        pinned: meta.pinned.unwrap_or(false),
        lock,
    };
    note.validate()?;
    Ok(note)
}

/// The providers a frontmatter `lock` lists, lowercased. A `lock` key that
/// lists none is an error, never "no lock".
fn lock_providers(lock: Option<OneOrMany>) -> Result<Vec<String>> {
    let Some(providers) = lock else {
        return Ok(Vec::new());
    };
    let lock = list(Some(providers));
    ensure!(
        !lock.is_empty(),
        "lock lists no providers; list at least one ({}), or remove the key",
        Provider::names()
    );
    Ok(deduplicate_strings(
        lock.into_iter().map(|p| p.to_lowercase()).collect(),
    ))
}

fn reject_misspelled_lock(yaml: &str) -> Result<()> {
    if let Some(key) = misspelled_lock(yaml) {
        bail!(
            "frontmatter key {key:?} is not read; write it as `lock` (lowercase) to limit which models may read this note, or rename it"
        );
    }
    Ok(())
}

/// The `lock` of a frontmatter block written in another note format (an OKF
/// concept), under the same fail-closed rules as a Markdown note.
pub(crate) fn frontmatter_lock(yaml: &str) -> Result<Vec<String>> {
    #[derive(Default, Deserialize)]
    #[serde(default)]
    struct LockOnly {
        #[serde(deserialize_with = "present")]
        lock: Option<OneOrMany>,
    }
    let meta: LockOnly =
        serde_saphyr::from_str_with_options(yaml, serde_saphyr::options! { strict_booleans: true })
            .context("invalid YAML frontmatter")?;
    reject_misspelled_lock(yaml)?;
    lock_providers(meta.lock)
}

/// Split `---` frontmatter from a note's text, for readers of other formats.
pub(crate) fn frontmatter(text: &str) -> Result<(Option<&str>, &str)> {
    split_frontmatter(text)
}

/// The first `# ` heading outside fenced code blocks.
pub(crate) fn first_heading(body: &str) -> Option<String> {
    let mut fence: Option<&str> = None;
    for line in body.lines() {
        let trimmed = line.trim_start();
        if let Some(open) = fence {
            if trimmed.starts_with(open) {
                fence = None;
            }
            continue;
        }
        if trimmed.starts_with("```") {
            fence = Some("```");
            continue;
        }
        if trimmed.starts_with("~~~") {
            fence = Some("~~~");
            continue;
        }
        if let Some(heading) = line.strip_prefix("# ") {
            let heading = heading.trim().trim_end_matches('#').trim();
            if !heading.is_empty() {
                return Some(heading.to_owned());
            }
        }
    }
    None
}

/// Split `---` frontmatter from the body. The delimiters must start at the
/// beginning of a line, so indented `---` inside a YAML block scalar is content.
fn split_frontmatter(text: &str) -> Result<(Option<&str>, &str)> {
    let Some(first_newline) = text.find('\n') else {
        if text.trim() == "---" {
            bail!("frontmatter is missing its closing --- delimiter");
        }
        return Ok((None, text));
    };
    if text[..first_newline].trim_end() != "---" {
        return Ok((None, text));
    }
    let yaml_start = first_newline + 1;
    let mut offset = yaml_start;
    for line in text[yaml_start..].split_inclusive('\n') {
        let marker = line.trim_end();
        if marker == "---" || marker == "..." {
            return Ok((
                Some(&text[yaml_start..offset]),
                &text[offset + line.len()..],
            ));
        }
        offset += line.len();
    }
    bail!("frontmatter is missing its closing --- delimiter")
}

fn deduplicate_strings(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    values
        .into_iter()
        .filter(|value| seen.insert(value.to_lowercase()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_portuguese_frontmatter_and_wikilinks() {
        let parsed = parse_markdown(
            "\u{feff}---\r\nid: pagamentos\r\ndomain: demo\r\naliases: [billing, Pagamentos]\r\nalias: billing\r\nrelated: '[[Banco#Esquema|ver banco]]'\r\ntags: produção\r\nconfidence: 0.9\r\npinned: true\r\n---\r\n# Serviço de pagamentos\r\nUsa PostgreSQL.\r\n",
            "docs/billing.md", "local",
        ).unwrap();
        assert_eq!(parsed.key, "pagamentos");
        assert_eq!(parsed.title, "Serviço de pagamentos");
        assert_eq!(parsed.domain, "demo");
        assert_eq!(parsed.aliases, vec!["billing", "Pagamentos"]);
        assert_eq!(parsed.tags, vec!["produção"]);
        assert_eq!(parsed.source.as_deref(), Some("docs/billing.md"));
        assert!(parsed.pinned);
        assert!(parsed.body.contains("Usa PostgreSQL."));
    }

    #[test]
    fn a_lock_names_providers_as_one_value_or_a_list() {
        let one = parse_markdown("---\nlock: Local\n---\nBody.", "n.md", "d").unwrap();
        assert_eq!(one.lock, ["local"]);
        let many = parse_markdown(
            "---\nlock: [local, anthropic, local]\n---\nBody.",
            "n.md",
            "d",
        )
        .unwrap();
        assert_eq!(many.lock, ["local", "anthropic"]);
        assert!(
            parse_markdown("---\n---\nBody.", "n.md", "d")
                .unwrap()
                .lock
                .is_empty()
        );
        let error = parse_markdown("---\nlock: [gpt]\n---\nBody.", "n.md", "d").unwrap_err();
        assert!(error.to_string().contains("lock"), "{error}");
    }

    #[test]
    fn an_empty_lock_fails_instead_of_leaving_the_note_unlocked() {
        for yaml in [
            "lock: []",
            "lock: \"\"",
            "lock:",
            "lock: ~",
            "lock: null",
            "lock: ['', ' ']",
        ] {
            let text = format!("---\nkey: k\n{yaml}\n---\nBody.");
            let error = parse_markdown(&text, "n.md", "d").unwrap_err().to_string();
            assert!(error.contains("lock lists no providers"), "{yaml}: {error}");
        }
        let kept = parse_markdown("---\nlock: [local, '']\n---\nBody.", "n.md", "d").unwrap();
        assert_eq!(kept.lock, ["local"]);
    }

    #[test]
    fn a_misspelled_lock_key_fails_instead_of_being_ignored() {
        for key in ["Lock", "LOCK", "locks", "Locked", "locked", "\"Lock\""] {
            let text = format!("---\nkey: k\n{key}: [local]\n---\nBody.");
            let error = parse_markdown(&text, "n.md", "d").unwrap_err().to_string();
            assert!(error.contains("write it as `lock`"), "{key}: {error}");
        }
        // Keys that merely contain the word, and nested keys, are fine.
        let parsed = parse_markdown(
            "---\nkey: k\nlockfile: yes\nblock: [a]\nmeta:\n  locked: true\n2024: x\n---\nBody.",
            "n.md",
            "d",
        )
        .unwrap();
        assert!(parsed.lock.is_empty());
    }

    #[test]
    fn a_declared_parse_needs_the_domain_in_frontmatter() {
        let named = parse_markdown_declared("---\ndomain: work\n---\nBody.", "n.md").unwrap();
        assert_eq!(named.domain, "work");
        for text in [
            "---\nkey: k\n---\nBody.",
            "---\ndomain: ' '\n---\nBody.",
            "# Title\nBody.",
        ] {
            let error = parse_markdown_declared(text, "n.md")
                .unwrap_err()
                .to_string();
            assert!(error.contains("names no domain"), "{text:?}: {error}");
        }
    }

    #[test]
    fn no_frontmatter_uses_filename_and_heading() {
        let parsed = parse_markdown("# Architecture\nText.", "/notes/system.md", "work").unwrap();
        assert_eq!(parsed.key, "system");
        assert_eq!(parsed.title, "Architecture");
        assert_eq!(parsed.domain, "work");
    }

    #[test]
    fn malformed_notes_are_rejected_instead_of_silently_indexed() {
        for text in [
            "---\nkey: broken\n# Missing delimiter",
            "---\naliases: [unfinished\n---\nbody",
            "---\nconfidence: .nan\n---\nbody",
            "---\nconfidence: 2.0\n---\nbody",
            "---\npinned: yes\n---\nbody",
            "---\nrelated: [[unquoted]]\n---\nbody",
            "---\ntitle: empty\n---\n",
        ] {
            assert!(
                parse_markdown(text, "test.md", "local").is_err(),
                "accepted {text:?}"
            );
        }
    }

    #[test]
    fn plain_yaml_scalars_are_accepted_as_text() {
        let parsed = parse_markdown(
            "---\nkey: release-2024\nid: 20231102\ntitle: 2025\ntags: [rust, 2024]\n---\nBody.",
            "notes/x.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.key, "release-2024");
        assert_eq!(parsed.title, "2025");
        assert_eq!(parsed.tags, vec!["rust", "2024"]);
    }

    #[test]
    fn unknown_frontmatter_fields_are_ignored() {
        let parsed = parse_markdown(
            "---\ntitle: T\ncreated: 2026-01-01\ncssclasses: [wide]\n---\nBody.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "T");
    }

    #[test]
    fn headings_inside_code_blocks_are_not_titles() {
        let parsed = parse_markdown(
            "```sh\n# install deps first\n```\n# Real title\nText.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "Real title");
    }

    #[test]
    fn indented_delimiter_inside_a_block_scalar_does_not_close_frontmatter() {
        let parsed = parse_markdown(
            "---\nkey: k\naliases:\n  - a\nnote: |\n  ---\n  still yaml\ntitle: T\n---\nBody.",
            "n.md",
            "local",
        )
        .unwrap();
        assert_eq!(parsed.title, "T");
        assert_eq!(parsed.body, "Body.");
    }
}
