//! Imports resolved to other files of the same repository, so the code map can
//! name a file's neighbours. Approximate by design: an import that names no
//! tracked source file (a package, a standard library module) is dropped.

use std::collections::{BTreeSet, HashMap};

use super::lang::Language;

/// The source files of one repository, indexed for resolving imports.
pub struct FileSet {
    paths: BTreeSet<String>,
    /// Python modules by every dotted suffix of their name: `pkg/a/b.py` is
    /// found as `b`, `a.b` and `pkg.a.b`.
    python: HashMap<String, Vec<String>>,
}

impl FileSet {
    /// The source files among `paths`, which are repository-relative with `/`.
    pub fn new(paths: impl IntoIterator<Item = String>) -> Self {
        let paths: BTreeSet<String> = paths
            .into_iter()
            .filter(|path| Language::for_path(path).is_some())
            .collect();
        let mut python: HashMap<String, Vec<String>> = HashMap::new();
        for path in &paths {
            let Some(stem) = path.strip_suffix(".py") else {
                continue;
            };
            let mut parts: Vec<&str> = stem.split('/').collect();
            if parts.last() == Some(&"__init__") {
                parts.pop();
            }
            for start in 0..parts.len() {
                python
                    .entry(parts[start..].join("."))
                    .or_default()
                    .push(path.clone());
            }
        }
        Self { paths, python }
    }

    pub fn contains(&self, path: &str) -> bool {
        self.paths.contains(path)
    }

    pub fn len(&self) -> usize {
        self.paths.len()
    }

    pub fn is_empty(&self) -> bool {
        self.paths.is_empty()
    }

    pub fn paths(&self) -> impl Iterator<Item = &str> {
        self.paths.iter().map(String::as_str)
    }

    /// The tracked source files that `from`'s imports name, in import order,
    /// without `from` itself or duplicates.
    pub fn resolve(&self, language: Language, from: &str, imports: &[String]) -> Vec<String> {
        let mut out: Vec<String> = Vec::new();
        for import in imports {
            let found = match language {
                Language::Rust => self.rust(from, import),
                Language::Python => self.python(from, import),
                Language::TypeScript | Language::JavaScript => self.script(from, import),
                Language::Terraform => self.terraform(from, import),
                Language::Go | Language::Sql | Language::Shell => None,
            };
            if let Some(found) = found
                && found != from
                && !out.contains(&found)
            {
                out.push(found);
            }
        }
        out
    }

    fn first_existing(&self, candidates: impl IntoIterator<Item = String>) -> Option<String> {
        candidates
            .into_iter()
            .find(|path| self.paths.contains(path))
    }

    // `mod::name`, `crate::a::b`, `super::a`, `self::a`, as the parser writes them.
    fn rust(&self, from: &str, import: &str) -> Option<String> {
        let (root, rest) = import.split_once("::")?;
        let base = match root {
            "mod" | "self" => rust_module_dir(from),
            "super" => parent_dir(&rust_module_dir(from)),
            "crate" => self.rust_crate_root(from)?,
            _ => return None,
        };
        let mut segments: Vec<&str> = rest.split("::").collect();
        let mut base = base;
        // Leading `super::super::...` climbs one module per segment.
        while segments.first() == Some(&"super") {
            segments.remove(0);
            base = parent_dir(&base);
        }
        // The longest prefix of the path that names a module file: the rest
        // are items inside it.
        for len in (1..=segments.len()).rev() {
            let module = join(&base, &segments[..len].join("/"));
            if let Some(found) =
                self.first_existing([format!("{module}.rs"), format!("{module}/mod.rs")])
            {
                return Some(found);
            }
        }
        // An item of the module itself, such as `super::Vaults` defined in
        // the parent's `mod.rs`, or `crate::Error` in `lib.rs`. Only a type
        // or trait name (capitalized) counts: a lowercase path that names no
        // file is more likely a module this map can't see than an item.
        let item = segments
            .first()
            .is_some_and(|name| name.starts_with(|c: char| c.is_ascii_uppercase()));
        if root == "mod" || !item {
            return None;
        }
        self.first_existing([
            join(&base, "mod.rs"),
            format!("{base}.rs"),
            join(&base, "lib.rs"),
            join(&base, "main.rs"),
        ])
    }

    /// The folder holding the crate root (`lib.rs` or `main.rs`) above `from`.
    /// `None` for a target that is its own crate (`src/bin/`, `examples/`,
    /// `benches/`, integration `tests/`), whose `crate::` this map can't place.
    fn rust_crate_root(&self, from: &str) -> Option<String> {
        if from.contains("src/bin/") {
            return None;
        }
        for part in from.split('/') {
            match part {
                "src" => break,
                "examples" | "benches" | "tests" => return None,
                _ => {}
            }
        }
        let mut dir = parent_dir(from);
        loop {
            if ["lib.rs", "main.rs"]
                .iter()
                .any(|root| self.paths.contains(&join(&dir, root)))
            {
                return Some(dir);
            }
            if dir.is_empty() {
                return None;
            }
            dir = parent_dir(&dir);
        }
    }

    fn python(&self, from: &str, import: &str) -> Option<String> {
        let dots = import.chars().take_while(|c| *c == '.').count();
        if dots > 0 {
            let mut base = parent_dir(from);
            for _ in 1..dots {
                base = parent_dir(&base);
            }
            let module = join(&base, &import[dots..].replace('.', "/"));
            return self.first_existing([format!("{module}.py"), format!("{module}/__init__.py")]);
        }
        let candidates = self.python.get(import)?;
        let module = import.replace('.', "/");
        // A module resolves only from a source root: the repository's root,
        // `src`, or a folder above the importing file. So `json` never names
        // `tools/deep/json.py`, and a vendored copy of a package is no
        // neighbour. Of what remains, the file nearest the importer wins.
        candidates
            .iter()
            .filter(|path| {
                let root = path
                    .strip_suffix(&format!("{module}.py"))
                    .or_else(|| path.strip_suffix(&format!("{module}/__init__.py")))
                    .unwrap_or(path)
                    .trim_end_matches('/');
                root.is_empty() || root == "src" || from.starts_with(&format!("{root}/"))
            })
            .max_by_key(|path| (shared_prefix(path, from), std::cmp::Reverse(path.len())))
            .cloned()
    }

    fn script(&self, from: &str, spec: &str) -> Option<String> {
        let target = join(&parent_dir(from), spec);
        let mut candidates = vec![target.clone()];
        for extension in ["ts", "tsx", "js", "jsx", "mjs", "cjs", "mts", "cts", "d.ts"] {
            candidates.push(format!("{target}.{extension}"));
        }
        for index in ["index.ts", "index.tsx", "index.js", "index.jsx"] {
            candidates.push(join(&target, index));
        }
        // TypeScript's ESM style imports `./x.js` for `./x.ts`.
        if let Some(stem) = target
            .strip_suffix(".js")
            .or_else(|| target.strip_suffix(".jsx"))
        {
            candidates.push(format!("{stem}.ts"));
            candidates.push(format!("{stem}.tsx"));
        }
        self.first_existing(candidates)
    }

    /// `dir:../modules/x`: the module folder's `main.tf` or `terragrunt.hcl`,
    /// else its first configuration file.
    fn terraform(&self, from: &str, import: &str) -> Option<String> {
        let dir = join(&parent_dir(from), import.strip_prefix("dir:")?);
        if dir.is_empty() {
            return None;
        }
        if let Some(found) =
            self.first_existing([join(&dir, "main.tf"), join(&dir, "terragrunt.hcl")])
        {
            return Some(found);
        }
        let prefix = format!("{dir}/");
        self.paths
            .range(prefix.clone()..)
            .take_while(|path| path.starts_with(&prefix))
            .find(|path| {
                !path[prefix.len()..].contains('/')
                    && Language::for_path(path) == Some(Language::Terraform)
            })
            .cloned()
    }
}

/// The folder holding a Rust file's child modules: its own folder for
/// `mod.rs`, `lib.rs` and `main.rs`, else a folder named after it.
fn rust_module_dir(path: &str) -> String {
    let dir = parent_dir(path);
    let name = path.rsplit('/').next().unwrap_or(path);
    match name {
        "mod.rs" | "lib.rs" | "main.rs" => dir,
        _ => join(&dir, name.trim_end_matches(".rs")),
    }
}

/// The folder of a repository path; empty at the root.
fn parent_dir(path: &str) -> String {
    path.rsplit_once('/')
        .map(|(dir, _)| dir.to_owned())
        .unwrap_or_default()
}

/// `relative` joined to the folder `dir`, with `.` and `..` resolved. A path
/// that climbs above the repository root is empty, which names no file.
fn join(dir: &str, relative: &str) -> String {
    let mut parts: Vec<&str> = dir.split('/').filter(|part| !part.is_empty()).collect();
    for part in relative.split('/') {
        match part {
            "" | "." => {}
            ".." => {
                if parts.pop().is_none() {
                    return String::new();
                }
            }
            part => parts.push(part),
        }
    }
    parts.join("/")
}

/// How many leading path components two paths share.
fn shared_prefix(a: &str, b: &str) -> usize {
    a.split('/')
        .zip(b.split('/'))
        .take_while(|(x, y)| x == y)
        .count()
}
