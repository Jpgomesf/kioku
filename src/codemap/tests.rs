use std::collections::BTreeSet;

use super::git::parse_name_status;
use super::lang::{cut, purpose_from};
use super::summarize::parse_response;
use super::*;

fn names(parsed: &Parsed) -> Vec<(&str, &str, u32, bool)> {
    parsed
        .symbols
        .iter()
        .map(|s| (s.name.as_str(), s.kind.as_str(), s.line, s.public))
        .collect()
}

fn files(paths: &[&str]) -> FileSet {
    FileSet::new(paths.iter().map(|path| (*path).to_owned()))
}

#[test]
fn languages_come_from_extensions() {
    assert_eq!(Language::for_path("src/a.rs"), Some(Language::Rust));
    assert_eq!(
        Language::for_path("web/App.TSX"),
        Some(Language::TypeScript)
    );
    assert_eq!(
        Language::for_path("infra/main.tf"),
        Some(Language::Terraform)
    );
    assert_eq!(Language::for_path("README.md"), None);
    assert_eq!(Language::for_path("Makefile"), None);
    for language in Language::ALL {
        assert_eq!(Language::parse(language.as_str()), Some(language));
    }
}

#[test]
fn rust_files_give_their_doc_items_and_crate_imports() {
    let text = r#"//! Authoritative storage. Everything else is derived.
//!
//! More detail that is not the purpose.
#![allow(dead_code)]

mod code;
#[cfg(test)]
mod tests;

use std::sync::Arc;
use crate::model::{Edge, Note as N};
use super::{output::ok, schema};
pub use crate::{
    access::Principal,
    vault::{Session, Viewer},
};

pub struct Store {
    pool: Pool,
}

impl<T: Into<String>> Store where T: Clone {
    pub async fn connect(url: &str) -> Result<Self> {
        todo!()
    }
    fn private_helper(&self) {}
}

pub(crate) const LIMIT: usize = 3;
macro_rules! pattern { () => {} }

#[cfg(test)]
mod inline_tests {
    fn not_listed() {}
}

fn after_tests() {}
"#;
    let parsed = parse(Language::Rust, text);
    assert_eq!(
        parsed.purpose.as_deref(),
        Some("Authoritative storage. Everything else is derived.")
    );
    assert_eq!(
        names(&parsed),
        vec![
            ("Store", "struct", 18, true),
            ("Store", "impl", 22, true),
            ("connect", "fn", 23, true),
            ("private_helper", "fn", 26, false),
            ("LIMIT", "const", 29, true),
            ("pattern", "macro_rules", 30, false),
            ("after_tests", "fn", 37, false),
        ]
    );
    assert_eq!(
        parsed.symbols[2].signature,
        "pub async fn connect(url: &str) -> Result<Self>"
    );
    assert_eq!(
        parsed.imports,
        vec![
            "mod::code",
            "crate::model::Edge",
            "crate::model::Note",
            "super::output::ok",
            "super::schema",
            "crate::access::Principal",
            "crate::vault::Session",
            "crate::vault::Viewer",
        ]
    );
}

#[test]
fn python_files_give_their_docstring_definitions_and_imports() {
    let text = r#"#!/usr/bin/env python3
"""Edit the vaults file safely.

It validates a copy first.
"""
from __future__ import annotations
import json, os.path
from . import helpers, models as m
from .store import Store
from pkg.sub import (
    alpha,
    beta,
)

@dataclass
class Vault:
    name: str

    def describe(self):
        def inner():
            pass

    def _hidden(self):
        pass

async def main():
    pass

def _private():
    pass
"#;
    let parsed = parse(Language::Python, text);
    assert_eq!(
        parsed.purpose.as_deref(),
        Some("Edit the vaults file safely.")
    );
    assert_eq!(
        names(&parsed),
        vec![
            ("Vault", "class", 16, true),
            ("describe", "method", 19, true),
            ("_hidden", "method", 23, false),
            ("main", "def", 26, true),
            ("_private", "def", 29, false),
        ]
    );
    assert_eq!(
        parsed.imports,
        vec![
            "__future__",
            "__future__.annotations",
            "json",
            "os.path",
            ".helpers",
            ".models",
            ".store",
            ".store.Store",
            "pkg.sub",
            "pkg.sub.alpha",
            "pkg.sub.beta",
        ]
    );
    assert_eq!(
        parse(Language::Python, "'''One line.'''\nx = 1\n")
            .purpose
            .as_deref(),
        Some("One line.")
    );
    assert_eq!(
        parse(Language::Python, "x = 'not a docstring'\n").purpose,
        None
    );
}

#[test]
fn scripts_give_their_comment_exports_and_relative_imports() {
    let text = r#""use client";
/**
 * Vaults and visibility, and the review step a person confirms.
 *
 * Details.
 */
import { useState } from "react";
import { getVaults } from "../../api";
import "./vaults.css";
export { helper } from './helper.js';
const lazy = () => import("./Lazy");
const legacy = require('../legacy');

export default function VaultsPage() {}
export async function load(): Promise<void> {}
export const LIMIT = 3;
export interface Props { a: string }
export abstract class Base {}
function local() {}
const toggle = async (id: string): Promise<void> => {};
export default function () {}
"#;
    let parsed = parse(Language::TypeScript, text);
    assert_eq!(
        parsed.purpose.as_deref(),
        Some("Vaults and visibility, and the review step a person confirms.")
    );
    assert_eq!(
        names(&parsed),
        vec![
            ("lazy", "function", 11, false),
            ("VaultsPage", "function", 14, true),
            ("load", "function", 15, true),
            ("LIMIT", "const", 16, true),
            ("Props", "interface", 17, true),
            ("Base", "class", 18, true),
            ("local", "function", 19, false),
            ("toggle", "function", 20, false),
            ("default", "function", 21, true),
        ]
    );
    assert_eq!(
        parsed.imports,
        vec![
            "../../api",
            "./vaults.css",
            "./helper.js",
            "./Lazy",
            "../legacy"
        ]
    );
    let line_comment = parse(
        Language::JavaScript,
        "// Builds the bundle.\nexport const x = 1;\n",
    );
    assert_eq!(line_comment.purpose.as_deref(), Some("Builds the bundle."));
}

#[test]
fn go_terraform_sql_and_shell() {
    let go = parse(
        Language::Go,
        "// Package store keeps notes.\npackage store\n\nfunc (s *Store) Save() {}\nfunc helper() {}\ntype Store struct {}\n",
    );
    assert_eq!(go.purpose.as_deref(), Some("Package store keeps notes."));
    assert_eq!(
        names(&go),
        vec![
            ("Save", "method", 4, true),
            ("helper", "func", 5, false),
            ("Store", "type", 6, true),
        ]
    );
    let tf = parse(
        Language::Terraform,
        "# The VPC and its subnets.\n\nresource \"google_compute_network\" \"main\" {\n}\nmodule \"db\" {\n  source = \"../modules/db\"\n}\nvariable \"region\" {}\nlocals {\n}\n",
    );
    assert_eq!(tf.purpose.as_deref(), Some("The VPC and its subnets."));
    assert_eq!(
        names(&tf),
        vec![
            ("google_compute_network.main", "resource", 3, true),
            ("db", "module", 5, true),
            ("region", "variable", 8, true),
            ("locals", "locals", 9, true),
        ]
    );
    assert_eq!(tf.imports, vec!["dir:../modules/db"]);
    let sql = parse(
        Language::Sql,
        "-- Code map tables.\ncreate table if not exists Code_Files (\n);\nCREATE INDEX code_files_imports ON code_files;\n",
    );
    assert_eq!(sql.purpose.as_deref(), Some("Code map tables."));
    assert_eq!(
        names(&sql),
        vec![
            ("Code_Files", "table", 2, true),
            ("code_files_imports", "index", 4, true)
        ]
    );
    let sh = parse(
        Language::Shell,
        "#!/usr/bin/env bash\n# shellcheck disable=SC2086\n# Start the server with this checkout's env.\nset -e\nstart() {\n}\nfunction stop {\n}\n",
    );
    assert_eq!(
        sh.purpose.as_deref(),
        Some("Start the server with this checkout's env.")
    );
    assert_eq!(names(&sh), vec![("start", "function", 5, true)]);
}

#[test]
fn purposes_are_one_line_and_never_a_license() {
    let lines = |text: &str| vec![text.to_owned()];
    assert_eq!(
        purpose_from(&lines("Copyright 2026 Acme. All rights reserved.")),
        None
    );
    assert_eq!(purpose_from(&lines("SPDX-License-Identifier: MIT")), None);
    assert_eq!(purpose_from(&[]), None);
    assert_eq!(
        purpose_from(&["Keeps   notes".to_owned(), "in sync.".to_owned()]).as_deref(),
        Some("Keeps notes in sync.")
    );
    let long = format!(
        "{} Second sentence that runs on and on.",
        "word ".repeat(10).trim()
    );
    assert_eq!(
        cut(&long, 60),
        "word word word word word word word word word word Second…"
    );
    let sentences = format!(
        "First sentence is long enough to keep. {}",
        "more ".repeat(40)
    );
    assert_eq!(
        cut(&sentences, 80),
        "First sentence is long enough to keep."
    );
    assert_eq!(cut("short", 80), "short");
}

#[test]
fn rust_imports_resolve_to_module_files() {
    let set = files(&[
        "src/lib.rs",
        "src/model.rs",
        "src/store/mod.rs",
        "src/store/code.rs",
        "src/mcp/mod.rs",
        "src/mcp/output.rs",
        "src/mcp/core_tools.rs",
        "src/vault/mod.rs",
        "src/vault/place.rs",
    ]);
    let imports = |from: &str, list: &[&str]| {
        set.resolve(
            Language::Rust,
            from,
            &list
                .iter()
                .map(|import| (*import).to_owned())
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        imports("src/store/mod.rs", &["mod::code"]),
        vec!["src/store/code.rs"]
    );
    assert_eq!(
        imports(
            "src/mcp/core_tools.rs",
            &[
                "super::output::ok",
                "crate::model::Note",
                "crate::store::Store"
            ]
        ),
        vec!["src/mcp/output.rs", "src/model.rs", "src/store/mod.rs"]
    );
    // An item of the parent module, defined in its mod.rs.
    assert_eq!(
        imports("src/vault/place.rs", &["super::Vaults"]),
        vec!["src/vault/mod.rs"]
    );
    // Nothing for a module that isn't there, or for the file itself.
    assert!(imports("src/store/mod.rs", &["mod::missing", "self::Store"]).is_empty());
}

#[test]
fn python_imports_resolve_nearest_and_relative() {
    let set = files(&[
        "app/__init__.py",
        "app/utils.py",
        "app/services/billing.py",
        "app/services/__init__.py",
        "tests/utils.py",
        "tools/deep/json.py",
        "src/config.py",
    ]);
    let imports = |from: &str, list: &[&str]| {
        set.resolve(
            Language::Python,
            from,
            &list
                .iter()
                .map(|import| (*import).to_owned())
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        imports("app/services/billing.py", &["..utils"]),
        vec!["app/utils.py"]
    );
    // `from . import x` reads the package itself.
    assert_eq!(
        imports("app/services/billing.py", &["."]),
        vec!["app/services/__init__.py"]
    );
    assert_eq!(
        imports("tests/test_billing.py", &["utils"]),
        vec!["tests/utils.py"]
    );
    assert_eq!(imports("app/main.py", &["app.utils"]), vec!["app/utils.py"]);
    assert_eq!(
        imports("app/main.py", &["services.billing"]),
        vec!["app/services/billing.py"]
    );
    assert_eq!(
        imports("app/main.py", &["app.services"]),
        vec!["app/services/__init__.py"]
    );
    assert_eq!(imports("app/main.py", &["config"]), vec!["src/config.py"]);
    // A standard module never matches a file deep in the tree.
    assert!(imports("app/main.py", &["json", "os.path"]).is_empty());
}

#[test]
fn script_and_terraform_imports_resolve() {
    let set = files(&[
        "web/src/api/index.ts",
        "web/src/api/core.ts",
        "web/src/app/App.tsx",
        "web/src/pages/Vaults.tsx",
        "web/src/legacy.js",
        "infra/modules/db/main.tf",
        "infra/modules/net/vpc.tf",
        "infra/envs/prod/terragrunt.hcl",
        "infra/envs/prod/main.tf",
    ]);
    let imports = |language: Language, from: &str, list: &[&str]| {
        set.resolve(
            language,
            from,
            &list
                .iter()
                .map(|import| (*import).to_owned())
                .collect::<Vec<_>>(),
        )
    };
    assert_eq!(
        imports(
            Language::TypeScript,
            "web/src/pages/Vaults.tsx",
            &[
                "../api",
                "../api/core.js",
                "../app/App",
                "../legacy",
                "./vaults.css",
                "../../../../../x"
            ]
        ),
        vec![
            "web/src/api/index.ts",
            "web/src/api/core.ts",
            "web/src/app/App.tsx",
            "web/src/legacy.js"
        ]
    );
    assert_eq!(
        imports(
            Language::Terraform,
            "infra/envs/prod/main.tf",
            &[
                "dir:../../modules/db",
                "dir:../../modules/net",
                "dir:../../modules/none"
            ]
        ),
        vec!["infra/modules/db/main.tf", "infra/modules/net/vpc.tf"]
    );
    assert!(!set.contains("README.md") && set.len() == 9 && !set.is_empty());
}

#[test]
fn name_status_output_becomes_changes() {
    let out = b"M\0src/a.rs\0A\0src/new file.rs\0D\0old.rs\0T\0link.rs\0";
    assert_eq!(
        parse_name_status(out),
        vec![
            Change::Changed("src/a.rs".to_owned()),
            Change::Changed("src/new file.rs".to_owned()),
            Change::Deleted("old.rs".to_owned()),
            Change::Changed("link.rs".to_owned()),
        ]
    );
    assert!(parse_name_status(b"").is_empty());
}

#[test]
fn summarizer_purposes_are_checked() {
    let asked: BTreeSet<&str> = ["a.py", "b.py", "c.py"].into_iter().collect();
    // Built at run time, so no token-shaped literal sits in the repository.
    let token = format!("{}{}", "ghp_", "a".repeat(36));
    let output = format!(
        r#"{{"purposes": [
        {{"path": "a.py", "purpose": "Parses the export.\n\nSecond line."}},
        {{"path": "b.py", "purpose": "   "}},
        {{"path": "c.py", "purpose": "Holds the key {token}"}},
        {{"path": "not-asked.py", "purpose": "Anything."}}
    ]}}"#
    );
    let purposes = parse_response(output.as_bytes(), &asked).unwrap();
    assert_eq!(purposes.len(), 1);
    assert_eq!(purposes["a.py"], "Parses the export. Second line.");
    assert!(parse_response(b"not json", &asked).is_err());
}

#[test]
fn main_symbols_prefer_public_ones_in_line_order() {
    let symbol = |name: &str, line: u32, public: bool| Symbol {
        name: name.to_owned(),
        kind: "fn".to_owned(),
        line,
        signature: format!("fn {name}()"),
        public,
    };
    let file = CodeFile {
        path: "a.rs".to_owned(),
        language: Language::Rust,
        digest: digest("x"),
        purpose: None,
        purpose_source: None,
        symbols: vec![
            symbol("private", 1, false),
            symbol("one", 2, true),
            symbol("two", 3, true),
        ],
        imports: Vec::new(),
    };
    let shown: Vec<&str> = file
        .main_symbols(2)
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(shown, vec!["one", "two"]);
    let shown: Vec<&str> = file
        .main_symbols(3)
        .iter()
        .map(|s| s.name.as_str())
        .collect();
    assert_eq!(shown, vec!["private", "one", "two"]);
    assert_eq!(digest("x").len(), 64);
}

#[test]
fn a_rebuilt_entry_keeps_a_model_purpose_but_not_a_stale_doc() {
    let set = files(&["a.py"]);
    let mut old = CodeFile::build("a.py", Language::Python, "x = 1\n", &set, None);
    assert_eq!((old.purpose.clone(), old.purpose_source), (None, None));
    old.purpose = Some("Model line.".to_owned());
    old.purpose_source = Some(PurposeSource::Model);
    let kept = CodeFile::build("a.py", Language::Python, "x = 2\n", &set, Some(&old));
    assert_eq!(kept.purpose.as_deref(), Some("Model line."));
    let documented = CodeFile::build(
        "a.py",
        Language::Python,
        "\"\"\"Doc.\"\"\"\n",
        &set,
        Some(&old),
    );
    assert_eq!(
        (documented.purpose.as_deref(), documented.purpose_source),
        (Some("Doc."), Some(PurposeSource::Doc))
    );
    let mut doc_old = documented.clone();
    doc_old.digest = digest("old");
    let undocumented = CodeFile::build("a.py", Language::Python, "x = 3\n", &set, Some(&doc_old));
    assert_eq!(
        undocumented.purpose, None,
        "a removed doc comment is no purpose"
    );
}
