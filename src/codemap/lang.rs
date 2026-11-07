//! The languages the code map covers, and what one source file says about
//! itself: its doc comment, its definitions and its imports. Parsing is
//! line-based and deliberately simple: a definition is found by how its line
//! starts, at the top level or one indent level in.

use std::sync::LazyLock;

use regex::Regex;
use serde::{Deserialize, Serialize};

/// Largest file the code map parses, in bytes. Larger files are usually
/// generated, and their outline helps a small model little.
pub const MAX_FILE_BYTES: usize = 512 * 1024;
/// Longest purpose kept, in characters.
pub const MAX_PURPOSE_CHARS: usize = 240;
/// Definitions kept per file.
const MAX_SYMBOLS: usize = 200;
const MAX_SIGNATURE_CHARS: usize = 160;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Language {
    Rust,
    Python,
    TypeScript,
    JavaScript,
    Go,
    Terraform,
    Sql,
    Shell,
}

impl Language {
    pub const ALL: [Self; 8] = [
        Self::Rust,
        Self::Python,
        Self::TypeScript,
        Self::JavaScript,
        Self::Go,
        Self::Terraform,
        Self::Sql,
        Self::Shell,
    ];

    /// The language of a repository path, from its extension.
    pub fn for_path(path: &str) -> Option<Self> {
        let name = path.rsplit('/').next()?;
        let (_, extension) = name.rsplit_once('.')?;
        match extension.to_ascii_lowercase().as_str() {
            "rs" => Some(Self::Rust),
            "py" => Some(Self::Python),
            "ts" | "tsx" | "mts" | "cts" => Some(Self::TypeScript),
            "js" | "jsx" | "mjs" | "cjs" => Some(Self::JavaScript),
            "go" => Some(Self::Go),
            "tf" | "hcl" => Some(Self::Terraform),
            "sql" => Some(Self::Sql),
            "sh" | "bash" => Some(Self::Shell),
            _ => None,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Self::Rust => "rust",
            Self::Python => "python",
            Self::TypeScript => "typescript",
            Self::JavaScript => "javascript",
            Self::Go => "go",
            Self::Terraform => "terraform",
            Self::Sql => "sql",
            Self::Shell => "shell",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        Self::ALL
            .into_iter()
            .find(|language| language.as_str() == name)
    }
}

/// One definition in a file.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Symbol {
    pub name: String,
    /// The language's own word for it: `fn`, `struct`, `class`, `def`, ...
    pub kind: String,
    /// 1-based line number.
    pub line: u32,
    /// The definition's first line, trimmed.
    pub signature: String,
    /// Exported or public, by the language's own rule.
    pub public: bool,
}

/// What a file says about itself.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Parsed {
    /// The first paragraph of its doc comment, as one line.
    pub purpose: Option<String>,
    pub symbols: Vec<Symbol>,
    /// Import specifiers as written, for the resolver.
    pub imports: Vec<String>,
}

pub fn parse(language: Language, text: &str) -> Parsed {
    let lines: Vec<&str> = text.lines().collect();
    let mut parsed = match language {
        Language::Rust => rust(&lines),
        Language::Python => python(&lines),
        Language::TypeScript | Language::JavaScript => script(&lines),
        Language::Go => go(&lines),
        Language::Terraform => terraform(&lines),
        Language::Sql => sql(&lines),
        Language::Shell => shell(&lines),
    };
    parsed.symbols.truncate(MAX_SYMBOLS);
    let mut seen = std::collections::HashSet::new();
    parsed.imports.retain(|import| seen.insert(import.clone()));
    parsed
}

macro_rules! pattern {
    ($name:ident, $source:expr) => {
        static $name: LazyLock<Regex> = LazyLock::new(|| {
            Regex::new($source).unwrap_or_else(|_| unreachable!("constant pattern"))
        });
    };
}

// --- purposes -------------------------------------------------------------------

/// A doc comment's first paragraph as one line, cut to a sentence end within
/// [`MAX_PURPOSE_CHARS`] when it is longer. A license header is no purpose.
pub fn purpose_from(lines: &[String]) -> Option<String> {
    let text = lines
        .iter()
        .flat_map(|line| line.split_whitespace())
        .collect::<Vec<_>>()
        .join(" ");
    let lower = text.to_lowercase();
    if text.is_empty() || lower.contains("copyright") || lower.contains("spdx-license") {
        return None;
    }
    Some(cut(&text, MAX_PURPOSE_CHARS))
}

/// `text` within `limit` characters: whole sentences when one ends past a
/// quarter of the limit, else whole words and an ellipsis.
pub fn cut(text: &str, limit: usize) -> String {
    if text.chars().count() <= limit {
        return text.to_owned();
    }
    let head: String = text.chars().take(limit).collect();
    if let Some(end) = head.rfind(". ").filter(|&end| end >= limit / 4) {
        return head[..=end].to_owned();
    }
    match head.rfind(' ') {
        Some(space) => format!("{}…", &head[..space]),
        None => format!("{head}…"),
    }
}

/// The first paragraph of the comment block that opens a file, after lines
/// `skip` accepts (shebangs, pragmas). Each line keeps what follows `prefix`.
fn leading_comment(lines: &[&str], prefix: &str, skip: impl Fn(&str) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    for line in lines {
        let trimmed = line.trim();
        if out.is_empty() && (trimmed.is_empty() || skip(trimmed)) {
            continue;
        }
        let Some(rest) = trimmed.strip_prefix(prefix) else {
            break;
        };
        let rest = rest.trim();
        if rest.is_empty() {
            if out.is_empty() {
                continue;
            }
            break;
        }
        out.push(rest.to_owned());
    }
    out
}

/// The first paragraph of a `/* ... */` block that opens a file.
fn leading_block(lines: &[&str], opener: &str, skip: impl Fn(&str) -> bool) -> Vec<String> {
    let mut start = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if trimmed.is_empty() || skip(trimmed) {
            continue;
        }
        if trimmed.starts_with(opener) {
            start = Some(index);
        }
        break;
    }
    let Some(start) = start else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for (index, line) in lines[start..].iter().enumerate() {
        let mut text = line.trim();
        if index == 0 {
            text = text.trim_start_matches(opener);
        }
        let closes = text.contains("*/");
        let text = text.split("*/").next().unwrap_or_default();
        let text = text.trim().trim_start_matches('*').trim();
        if text.is_empty() && !out.is_empty() {
            break;
        }
        if !text.is_empty() {
            out.push(text.to_owned());
        }
        if closes {
            break;
        }
    }
    out
}

fn signature(line: &str) -> String {
    let trimmed = line.trim().trim_end_matches('{').trim_end();
    cut(trimmed, MAX_SIGNATURE_CHARS)
}

fn symbol(name: &str, kind: &str, index: usize, line: &str, public: bool) -> Symbol {
    Symbol {
        name: name.to_owned(),
        kind: kind.to_owned(),
        line: u32::try_from(index + 1).unwrap_or(u32::MAX),
        signature: signature(line),
        public,
    }
}

// --- Rust -----------------------------------------------------------------------

pattern!(
    RUST_ITEM,
    r#"^(?P<indent> {0,4})(?P<vis>pub(?:\([^)]*\))?\s+)?(?:(?:const|async|unsafe|extern\s+"[^"]*")\s+)*(?P<kind>fn|struct|enum|trait|type|mod|union|static|const|macro_rules!)\s*(?P<name>[A-Za-z_][A-Za-z0-9_]*)"#
);
pattern!(
    RUST_IMPL,
    r"^(?P<indent> {0,4})(?:unsafe\s+)?impl\b(?:\s*<[^{]*?>)?\s+(?P<name>[^{]+?)\s*(?:\{.*)?$"
);
pattern!(
    RUST_MOD_FILE,
    r"^\s*(?:pub(?:\([^)]*\))?\s+)?mod\s+(?P<name>[A-Za-z_][A-Za-z0-9_]*)\s*;"
);
pattern!(RUST_USE, r"^\s*(?:pub(?:\([^)]*\))?\s+)?use\s+");

fn rust(lines: &[&str]) -> Parsed {
    let mut doc = leading_comment(lines, "//!", |line| line.starts_with("#!["));
    if doc.is_empty() {
        doc = leading_block(lines, "/*!", |line| line.starts_with("#!["));
    }
    let mut parsed = Parsed {
        purpose: purpose_from(&doc),
        ..Parsed::default()
    };
    let mut test_module = false;
    let mut after_cfg_test = false;
    let mut statement: Option<String> = None;
    for (index, line) in lines.iter().enumerate() {
        let trimmed = line.trim();
        if test_module {
            test_module = !line.starts_with('}');
            continue;
        }
        if let Some(mut text) = statement.take() {
            text.push(' ');
            text.push_str(trimmed);
            if trimmed.contains(';') {
                parsed.imports.extend(rust_use_paths(&text));
            } else {
                statement = Some(text);
            }
            continue;
        }
        // Attributes are never items: note `#[cfg(test)]`, which hides the
        // item after it (and any attributes between) from the map.
        if trimmed.starts_with("#[") {
            after_cfg_test |= trimmed.starts_with("#[cfg(test)]");
            continue;
        }
        if std::mem::take(&mut after_cfg_test) {
            // Test-only code: skip the item, and a whole inline test module.
            test_module = trimmed.contains("mod ") && trimmed.ends_with('{');
            continue;
        }
        if let Some(found) = RUST_MOD_FILE.captures(line) {
            parsed.imports.push(format!("mod::{}", &found["name"]));
            continue;
        }
        if RUST_USE.is_match(line) {
            if trimmed.contains(';') {
                parsed.imports.extend(rust_use_paths(trimmed));
            } else {
                statement = Some(trimmed.to_owned());
            }
            continue;
        }
        if let Some(found) = RUST_ITEM.captures(line) {
            let kind = found["kind"].trim_end_matches('!');
            parsed.symbols.push(symbol(
                &found["name"],
                kind,
                index,
                line,
                found.name("vis").is_some(),
            ));
        } else if let Some(found) = RUST_IMPL.captures(line) {
            let name = found["name"]
                .split(" where ")
                .next()
                .unwrap_or_default()
                .trim();
            parsed.symbols.push(symbol(name, "impl", index, line, true));
        }
    }
    parsed
}

/// The paths a `use` statement names inside the crate, one per leaf:
/// `use crate::a::{b, c::d};` gives `crate::a::b` and `crate::a::c::d`.
fn rust_use_paths(statement: &str) -> Vec<String> {
    let body = RUST_USE.replace(statement.trim(), "");
    let body = body.trim().trim_end_matches(';').trim();
    let mut out = Vec::new();
    expand_use("", body, &mut out);
    out.retain(|path| {
        ["crate::", "super::", "self::"]
            .iter()
            .any(|root| path.starts_with(root))
    });
    out
}

fn expand_use(prefix: &str, tree: &str, out: &mut Vec<String>) {
    let tree = tree.trim();
    if let Some(open) = tree.find('{') {
        let head = tree[..open].trim();
        let inner = tree[open + 1..].trim_end().trim_end_matches('}');
        let base = format!("{prefix}{head}");
        for item in split_top_level(inner) {
            expand_use(&base, item, out);
        }
        return;
    }
    let path = tree.split(" as ").next().unwrap_or_default().trim();
    if path.is_empty() || path == "*" {
        if let Some(base) = prefix.strip_suffix("::") {
            out.push(base.to_owned());
        }
        return;
    }
    if path == "self" {
        out.push(prefix.trim_end_matches("::").to_owned());
        return;
    }
    out.push(format!("{prefix}{path}").trim_end_matches("::*").to_owned());
}

/// Comma-separated items of a brace group, ignoring commas in nested groups.
fn split_top_level(inner: &str) -> Vec<&str> {
    let mut items = Vec::new();
    let mut depth = 0usize;
    let mut start = 0;
    for (index, c) in inner.char_indices() {
        match c {
            '{' => depth += 1,
            '}' => depth = depth.saturating_sub(1),
            ',' if depth == 0 => {
                items.push(&inner[start..index]);
                start = index + 1;
            }
            _ => {}
        }
    }
    items.push(&inner[start..]);
    items
        .into_iter()
        .filter(|item| !item.trim().is_empty())
        .collect()
}

// --- Python ---------------------------------------------------------------------

pattern!(
    PY_DEF,
    r"^(?P<indent>(?:    )?)(?:async\s+)?def\s+(?P<name>[A-Za-z_]\w*)\s*\("
);
pattern!(PY_CLASS, r"^class\s+(?P<name>[A-Za-z_]\w*)");
pattern!(
    PY_FROM,
    r"^\s*from\s+(?P<module>\.*[A-Za-z_][\w.]*|\.+)\s+import\s+(?P<names>.*)$"
);
pattern!(
    PY_IMPORT,
    r"^\s*import\s+(?P<modules>[A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)"
);

fn python(lines: &[&str]) -> Parsed {
    let mut parsed = Parsed {
        purpose: purpose_from(&python_docstring(lines)),
        ..Parsed::default()
    };
    let mut in_class = false;
    let mut pending: Option<(String, String)> = None;
    for (index, line) in lines.iter().enumerate() {
        if let Some((module, mut names)) = pending.take() {
            names.push(' ');
            names.push_str(line.trim());
            if line.contains(')') {
                parsed.imports.extend(python_from(&module, &names));
            } else {
                pending = Some((module, names));
            }
            continue;
        }
        if !line.starts_with(' ') && !line.starts_with('\t') && !line.trim().is_empty() {
            // A decorator keeps the current block; a class opens one.
            in_class = PY_CLASS.is_match(line) || (line.starts_with('@') && in_class);
        }
        if let Some(found) = PY_CLASS.captures(line) {
            let name = &found["name"];
            parsed
                .symbols
                .push(symbol(name, "class", index, line, !name.starts_with('_')));
        } else if let Some(found) = PY_DEF.captures(line) {
            let nested = !found["indent"].is_empty();
            if nested && !in_class {
                continue;
            }
            let name = &found["name"];
            let kind = if nested { "method" } else { "def" };
            parsed
                .symbols
                .push(symbol(name, kind, index, line, !name.starts_with('_')));
        } else if let Some(found) = PY_FROM.captures(line) {
            let module = found["module"].to_owned();
            let names = found["names"].to_owned();
            if names.contains('(') && !names.contains(')') {
                pending = Some((module, names));
            } else {
                parsed.imports.extend(python_from(&module, &names));
            }
        } else if let Some(found) = PY_IMPORT.captures(line) {
            parsed
                .imports
                .extend(found["modules"].split(',').map(|m| m.trim().to_owned()));
        }
    }
    parsed
}

/// Modules a `from module import names` line may refer to: the module, and
/// each name as a submodule of it (the resolver keeps those that exist).
fn python_from(module: &str, names: &str) -> Vec<String> {
    let names = names.replace(['(', ')'], " ");
    let names = names.split('#').next().unwrap_or_default();
    let mut out = Vec::new();
    if !module.chars().all(|c| c == '.') {
        out.push(module.to_owned());
    }
    for name in names.split(',') {
        let name = name.split(" as ").next().unwrap_or_default().trim();
        if name.is_empty() || name == "*" || !name.chars().all(|c| c.is_alphanumeric() || c == '_')
        {
            continue;
        }
        let joined = if module.ends_with('.') {
            format!("{module}{name}")
        } else {
            format!("{module}.{name}")
        };
        out.push(joined);
    }
    out
}

/// The module docstring: a string literal as the file's first statement.
fn python_docstring(lines: &[&str]) -> Vec<String> {
    let mut iter = lines
        .iter()
        .map(|line| line.trim())
        .skip_while(|line| line.is_empty() || line.starts_with('#'));
    let Some(first) = iter.next() else {
        return Vec::new();
    };
    let first = first.trim_start_matches(['r', 'u', 'R', 'U']);
    let Some(quote) = ["\"\"\"", "'''", "\"", "'"]
        .into_iter()
        .find(|quote| first.starts_with(quote))
    else {
        return Vec::new();
    };
    let rest = &first[quote.len()..];
    if let Some(end) = rest.find(quote) {
        return vec![rest[..end].trim().to_owned()];
    }
    if quote.len() == 1 {
        return Vec::new();
    }
    let mut out = Vec::new();
    if !rest.trim().is_empty() {
        out.push(rest.trim().to_owned());
    }
    for line in iter {
        let (text, closed) = match line.find(quote) {
            Some(end) => (&line[..end], true),
            None => (line, false),
        };
        if text.trim().is_empty() && !out.is_empty() {
            break;
        }
        if !text.trim().is_empty() {
            out.push(text.trim().to_owned());
        }
        if closed {
            break;
        }
    }
    out
}

// --- TypeScript and JavaScript ------------------------------------------------------

pattern!(
    TS_EXPORT,
    r"^export\s+(?:default\s+)?(?:declare\s+)?(?:async\s+)?(?P<kind>function\*?|abstract\s+class|class|const|let|var|interface|type|enum)\s+(?P<name>[A-Za-z_$][\w$]*)"
);
pattern!(
    TS_LOCAL,
    r"^(?:async\s+)?(?P<kind>function\*?|class)\s+(?P<name>[A-Za-z_$][\w$]*)"
);
pattern!(
    TS_ARROW,
    r"^(?:const|let)\s+(?P<name>[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=>"
);
pattern!(
    TS_IMPORT,
    r#"(?:\bfrom\s*|^\s*import\s*|\bimport\s*\(\s*|\brequire\s*\(\s*)['"](?P<spec>\.{1,2}/[^'"]+)['"]"#
);

fn is_script_pragma(line: &str) -> bool {
    line.starts_with("#!")
        || line.starts_with("\"use ")
        || line.starts_with("'use ")
        || line.starts_with("// @ts-")
        || line.starts_with("// eslint")
        || line.starts_with("/* eslint")
        || line.starts_with("// biome-ignore")
        || line.starts_with("// prettier-ignore")
}

fn script(lines: &[&str]) -> Parsed {
    let mut doc = leading_block(lines, "/**", is_script_pragma);
    if doc.is_empty() {
        doc = leading_comment(lines, "//", is_script_pragma);
    }
    let mut parsed = Parsed {
        purpose: purpose_from(&doc),
        ..Parsed::default()
    };
    for (index, line) in lines.iter().enumerate() {
        for found in TS_IMPORT.captures_iter(line) {
            parsed.imports.push(found["spec"].to_owned());
        }
        if let Some(found) = TS_EXPORT.captures(line) {
            let kind = found["kind"].trim_end_matches('*').replace("abstract ", "");
            parsed
                .symbols
                .push(symbol(&found["name"], kind.trim(), index, line, true));
        } else if line.starts_with("export default function") {
            parsed
                .symbols
                .push(symbol("default", "function", index, line, true));
        } else if let Some(found) = TS_LOCAL.captures(line) {
            let kind = found["kind"].trim_end_matches('*');
            parsed
                .symbols
                .push(symbol(&found["name"], kind, index, line, false));
        } else if let Some(found) = TS_ARROW.captures(line) {
            parsed
                .symbols
                .push(symbol(&found["name"], "function", index, line, false));
        }
    }
    parsed
}

// --- Go -------------------------------------------------------------------------

pattern!(
    GO_FUNC,
    r"^func\s+(?:\((?P<receiver>[^)]*)\)\s*)?(?P<name>[A-Za-z_]\w*)"
);
pattern!(GO_TYPE, r"^type\s+(?P<name>[A-Za-z_]\w*)\s+");

fn go(lines: &[&str]) -> Parsed {
    let package = lines.iter().position(|line| line.starts_with("package "));
    let mut doc = Vec::new();
    if let Some(package) = package {
        let mut start = package;
        while start > 0 && lines[start - 1].trim_start().starts_with("//") {
            start -= 1;
        }
        doc = leading_comment(&lines[start..package], "//", |_| false);
    }
    let mut parsed = Parsed {
        purpose: purpose_from(&doc),
        ..Parsed::default()
    };
    for (index, line) in lines.iter().enumerate() {
        let (found, kind) = if let Some(found) = GO_FUNC.captures(line) {
            let kind = if found.name("receiver").is_some() {
                "method"
            } else {
                "func"
            };
            (found, kind)
        } else if let Some(found) = GO_TYPE.captures(line) {
            (found, "type")
        } else {
            continue;
        };
        let name = &found["name"];
        let public = name.chars().next().is_some_and(char::is_uppercase);
        parsed.symbols.push(symbol(name, kind, index, line, public));
    }
    parsed
}

// --- Terraform and HCL ------------------------------------------------------------

pattern!(
    TF_TYPED,
    r#"^(?P<kind>resource|data)\s+"(?P<type>[^"]+)"\s+"(?P<name>[^"]+)""#
);
pattern!(
    TF_NAMED,
    r#"^(?P<kind>module|variable|output|provider|dependency|include)\s+"(?P<name>[^"]+)""#
);
pattern!(
    TF_BLOCK,
    r"^(?P<kind>locals|terraform|inputs)\s*(?:=\s*)?\{"
);
pattern!(
    TF_SOURCE,
    r#"^\s*(?:source|config_path)\s*=\s*"(?P<path>\.{1,2}/[^"]+)""#
);

fn terraform(lines: &[&str]) -> Parsed {
    let mut doc = leading_comment(lines, "#", |_| false);
    if doc.is_empty() {
        doc = leading_comment(lines, "//", |_| false);
    }
    let mut parsed = Parsed {
        purpose: purpose_from(&doc),
        ..Parsed::default()
    };
    for (index, line) in lines.iter().enumerate() {
        if let Some(found) = TF_SOURCE.captures(line) {
            parsed.imports.push(format!("dir:{}", &found["path"]));
        }
        if let Some(found) = TF_TYPED.captures(line) {
            let name = format!("{}.{}", &found["type"], &found["name"]);
            parsed
                .symbols
                .push(symbol(&name, &found["kind"], index, line, true));
        } else if let Some(found) = TF_NAMED.captures(line) {
            parsed
                .symbols
                .push(symbol(&found["name"], &found["kind"], index, line, true));
        } else if let Some(found) = TF_BLOCK.captures(line) {
            let kind = &found["kind"];
            parsed.symbols.push(symbol(kind, kind, index, line, true));
        }
    }
    parsed
}

// --- SQL --------------------------------------------------------------------------

pattern!(
    SQL_CREATE,
    r#"^\s*CREATE\s+(?:OR\s+REPLACE\s+)?(?:UNIQUE\s+)?(?:MATERIALIZED\s+)?(?P<kind>TABLE|VIEW|FUNCTION|INDEX|TYPE|TRIGGER|PROCEDURE|SCHEMA|SEQUENCE)\s+(?:IF\s+NOT\s+EXISTS\s+)?(?P<name>[\w."]+)"#
);

fn sql(lines: &[&str]) -> Parsed {
    let mut parsed = Parsed {
        purpose: purpose_from(&leading_comment(lines, "--", |_| false)),
        ..Parsed::default()
    };
    for (index, line) in lines.iter().enumerate() {
        // Keywords match in upper case; ASCII case changes keep byte offsets,
        // so the name comes from the original line.
        let upper = line.to_ascii_uppercase();
        if let Some(found) = SQL_CREATE.captures(&upper) {
            let (Some(kind), Some(name)) = (found.name("kind"), found.name("name")) else {
                continue;
            };
            let name = line[name.range()].trim_matches('"');
            let kind = kind.as_str().to_ascii_lowercase();
            parsed.symbols.push(symbol(name, &kind, index, line, true));
        }
    }
    parsed
}

// --- shell ------------------------------------------------------------------------

pattern!(
    SH_FUNCTION,
    r"^(?:function\s+)?(?P<name>[A-Za-z_][\w-]*)\s*\(\)\s*\{?"
);

fn shell(lines: &[&str]) -> Parsed {
    let doc = leading_comment(lines, "#", |line| {
        line.starts_with("#!") || line.starts_with("# shellcheck")
    });
    let mut parsed = Parsed {
        purpose: purpose_from(&doc),
        ..Parsed::default()
    };
    for (index, line) in lines.iter().enumerate() {
        if let Some(found) = SH_FUNCTION.captures(line) {
            parsed
                .symbols
                .push(symbol(&found["name"], "function", index, line, true));
        }
    }
    parsed
}
