//! OKF bundles read on real temporary folders.

use std::path::{Path, PathBuf};

use super::*;

/// A temporary bundle, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kioku-okf-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn write(&self, relative: &str, text: &str) -> &Self {
        let path = self.0.join(relative);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, text).unwrap();
        self
    }

    fn path(&self) -> &Path {
        &self.0
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn bundle() -> Tree {
    let tree = Tree::new();
    tree.write("index.md", "---\nokf_version: \"0.2\"\n---\n# Knowledge bases\n\n* [KB](/kb/) - the KB\n")
        .write("log.md", "# Log\n\n## 2026-11-04\n* **Update**: things\n")
        .write("kb/index.md", "# KB\n\n* [Overview](/kb/overview.md) - start here\n")
        .write(
            "kb/overview.md",
            "---\ntype: Overview\ntitle: People enrichment overview\ndescription: Where the project stands.\nstatus: stable\nowner: João\ntags: [people-data]\nstale_after: 2026-11-10T19:55:00-03:00\ngenerated: { by: \"human:joao\", at: 2026-11-03T21:30:00-03:00 }\n---\n# State\n\nThe router is decided in [DEC-350](/kb/decisions/DEC-350-links.md); see also [the old rule](decisions/DEC-276-old.md#why) and [a missing note](/kb/decisions/DEC-999.md).\n\nIndex: [all decisions](/kb/decisions/) and [the log](/kb/log.md). Docs: [OKF](https://example.com/okf).\n\n```md\n[not a link](/kb/decisions/DEC-350-links.md)\n```\n",
        )
        .write(
            "kb/decisions/DEC-350-links.md",
            "---\ntype: Decision\nid: DEC-350\ntitle: Fundable links come from sources\nstatus: stable\ndecision_status: active\ndecided_by: TJ\nlinear: 'FUN-628 (15:49 contract)'\nprojects:\n- People Data\nsupersedes:\n- DEC-276\nverified: { by: \"human:joao\", at: 2026-11-04T10:00:00-03:00 }\nsources:\n- id: src\n  resource: https://slack.example/p1\n  title: TJ, #devs\n---\n# Decision\nFacts carry the rows that asked for the fetch.[^src]\n\n# Related\n* Supersedes: [DEC-276: Each batch links unlinked rows](/kb/decisions/DEC-276-old.md)\n* Items: [Overview](/kb/overview.md), [DEC-276: old](/kb/decisions/DEC-276-old.md), [Q-1: a question](/kb/questions/Q-001.md)\n\n[^src]: TJ, #devs, 27 Oct 13:52\n",
        )
        .write(
            "kb/decisions/DEC-276-old.md",
            "---\ntype: Decision\nid: DEC-276\ntitle: Each batch links unlinked rows\nstatus: deprecated\nsuperseded_by: [DEC-350]\nverified:\n  - { by: \"process:nightly\", at: 2026-11-01T00:00:00Z }\n---\n# Why\nIt was simpler.\n",
        )
        .write(
            "kb/questions/Q-001.md",
            "---\ntype: Question\nid: Q-001\ntitle: A question\nstatus: draft\n---\nWho decides?\n",
        )
        .write(".hidden/secret.md", "---\ntype: Note\n---\nnot part of the bundle\n");
    tree
}

fn note<'a>(conversion: &'a Conversion, key: &str) -> &'a OkfNote {
    conversion
        .notes
        .iter()
        .find(|n| n.input.key == key)
        .unwrap_or_else(|| {
            panic!(
                "no note {key}: {:?}",
                conversion
                    .notes
                    .iter()
                    .map(|n| &n.input.key)
                    .collect::<Vec<_>>()
            )
        })
}

#[test]
fn a_bundle_is_recognized_by_its_root_index() {
    let tree = bundle();
    assert_eq!(bundle_version(tree.path()).unwrap().as_deref(), Some("0.2"));
    let unquoted = Tree::new();
    unquoted.write("index.md", "---\nokf_version: 0.2\n---\n# KBs\n");
    assert_eq!(
        bundle_version(unquoted.path()).unwrap().as_deref(),
        Some("0.2")
    );
    let plain = Tree::new();
    plain
        .write("index.md", "# Just an index\n")
        .write("a.md", "# A\n");
    assert_eq!(bundle_version(plain.path()).unwrap(), None);
    assert_eq!(bundle_version(&plain.path().join("a.md")).unwrap(), None);
}

#[test]
fn concepts_are_keyed_by_concept_id_and_reserved_and_hidden_files_are_skipped() {
    let tree = bundle();
    let bundle = Bundle::read(tree.path()).unwrap();
    let paths: Vec<&str> = bundle.paths().collect();
    assert_eq!(
        paths,
        [
            "kb/decisions/DEC-276-old.md",
            "kb/decisions/DEC-350-links.md",
            "kb/overview.md",
            "kb/questions/Q-001.md"
        ]
    );
    let conversion = convert(&bundle, "fundable");
    assert!(conversion.failed.is_empty(), "{:?}", conversion.failed);
    let decision = note(&conversion, "kb/decisions/DEC-350-links");
    assert_eq!(decision.input.domain, "fundable");
    assert_eq!(decision.input.title, "Fundable links come from sources");
    assert_eq!(decision.input.aliases, ["DEC-350"]);
    assert_eq!(decision.input.tags, ["decision"]);
    assert_eq!(
        decision.input.source.as_deref(),
        Some(
            tree.path()
                .join("kb/decisions/DEC-350-links.md")
                .to_str()
                .unwrap()
        )
    );
    assert!(!decision.deprecated);
    assert!(note(&conversion, "kb/decisions/DEC-276-old").deprecated);
    assert_eq!(conversion.summary.concepts, 4);
    assert_eq!(conversion.summary.deprecated, 1);
    assert_eq!(conversion.summary.okf_version.as_deref(), Some("0.2"));
}

#[test]
fn links_become_related_keys_and_keep_their_words() {
    let tree = bundle();
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    let overview = note(&conversion, "kb/overview");
    assert_eq!(
        overview.input.related,
        ["kb/decisions/DEC-350-links", "kb/decisions/DEC-276-old"]
    );
    let body = &overview.input.body;
    // The label already names the id; a label that doesn't gets it added.
    assert!(body.contains("decided in DEC-350;"), "{body}");
    assert!(
        body.contains("see also the old rule (DEC-276) and a missing note."),
        "{body}"
    );
    // Navigation links keep only their words; external links and code stay as written.
    assert!(body.contains("Index: all decisions and the log."), "{body}");
    assert!(body.contains("[OKF](https://example.com/okf)"), "{body}");
    assert!(
        body.contains("[not a link](/kb/decisions/DEC-350-links.md)"),
        "{body}"
    );
    assert_eq!(conversion.summary.broken_links, 1);
}

#[test]
fn a_list_of_links_becomes_a_list_of_ids() {
    let tree = bundle();
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    let body = &note(&conversion, "kb/decisions/DEC-350-links").input.body;
    assert!(
        body.contains("* Items: People enrichment overview, DEC-276, Q-001"),
        "{body}"
    );
    // One link is not a list: it keeps its words.
    assert!(
        body.contains("* Supersedes: DEC-276: Each batch links unlinked rows"),
        "{body}"
    );
}

#[test]
fn the_facts_line_carries_type_lifecycle_trust_and_producer_fields() {
    let tree = bundle();
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    let decision = note(&conversion, "kb/decisions/DEC-350-links");
    let facts = decision.input.body.lines().next().unwrap();
    assert_eq!(
        facts,
        "Decision DEC-350 · human-reviewed by human:joao on 2026-11-04 · decision status: active · decided by: TJ · linear: FUN-628 (15:49 contract) · projects: People Data · supersedes: DEC-276"
    );
    assert!((decision.input.confidence - 0.95).abs() < 1e-9);

    let old = note(&conversion, "kb/decisions/DEC-276-old");
    assert!(
        old.input.body.starts_with(
            "Decision DEC-276 · deprecated · machine-confirmed · superseded by: DEC-350"
        ),
        "{}",
        old.input.body
    );

    let question = note(&conversion, "kb/questions/Q-001");
    assert!(
        question
            .input
            .body
            .starts_with("Question Q-001 · draft · unverified\n"),
        "{}",
        question.input.body
    );
    assert!(question.input.confidence < 0.7);

    let overview = note(&conversion, "kb/overview");
    let mut lines = overview.input.body.lines();
    assert_eq!(
        lines.next().unwrap(),
        "Overview · unverified · re-read after 2026-11-10 · owner: João · written by human:joao on 2026-11-03"
    );
    assert_eq!(lines.next().unwrap(), "Where the project stands.");
    assert_eq!(overview.input.tags, ["people-data", "overview"]);
}

#[test]
fn a_concept_with_no_frontmatter_is_still_read() {
    let tree = Tree::new();
    tree.write("index.md", "---\nokf_version: \"0.2\"\n---\n")
        .write("notes/plain.md", "# Plain heading\n\nJust text.\n");
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    let plain = note(&conversion, "notes/plain");
    assert_eq!(plain.input.title, "Plain heading");
    assert!(
        plain
            .input
            .body
            .starts_with("Concept · unverified\n\n# Plain heading")
    );
}

#[test]
fn a_bad_lock_or_bad_yaml_fails_only_that_concept() {
    let tree = Tree::new();
    tree.write("index.md", "---\nokf_version: \"0.2\"\n---\n")
        .write(
            "a.md",
            "---\ntype: Note\nlock: local\n---\nOnly local models.\n",
        )
        .write(
            "b.md",
            "---\ntype: Note\nlocked: true\n---\nMisspelled lock.\n",
        )
        .write("c.md", "---\ntype: [unclosed\n---\nBad YAML.\n");
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    assert_eq!(note(&conversion, "a").input.lock, ["local"]);
    let failed: Vec<&str> = conversion.failed.iter().map(|(p, _)| p.as_str()).collect();
    assert_eq!(failed, ["b.md", "c.md"]);
}

fn long_topic() -> String {
    let mut text = String::from(
        "---\ntype: Architecture\nid: ARCH\ntitle: Option D architecture\ndescription: How it fits together.\n---\nShort intro.\n\n# Parts\n\nThe parts, in order.\n\n",
    );
    for part in ["Router", "Workers", "Router"] {
        text.push_str(&format!("## {part}\n\n"));
        for n in 0..12 {
            text.push_str(&format!(
                "The {part} paragraph {n} explains one rule of the pipeline in enough words to take some room in the note. "
            ));
            text.push_str("It links [the decision](/kb/decisions/DEC-350-links.md).\n\n");
        }
    }
    text.push_str("# Data\n\n| Column | Meaning |\n|---|---|\n");
    for n in 0..120 {
        text.push_str(&format!(
            "| col_{n} | what column {n} holds, described at some length |\n"
        ));
    }
    text.push_str(
        "\n# Links\n\nSee [the router](/kb/architecture.md#router) and [workers](#workers).\n",
    );
    text
}

#[test]
fn a_long_concept_becomes_a_hub_and_sections_keyed_by_anchor() {
    let tree = bundle();
    tree.write("kb/architecture.md", &long_topic()).write(
        "kb/pointer.md",
        "---\ntype: Note\n---\nThe [second router section](/kb/architecture.md#router-1) and [data](/kb/architecture.md#data).\n",
    );
    let conversion = convert(&Bundle::read(tree.path()).unwrap(), "d");
    let keys: Vec<&str> = conversion
        .notes
        .iter()
        .map(|n| n.input.key.as_str())
        .filter(|k| k.starts_with("kb/architecture"))
        .collect();
    assert_eq!(keys[0], "kb/architecture");
    for wanted in [
        "kb/architecture#router",
        "kb/architecture#workers",
        "kb/architecture#router-1",
        "kb/architecture#data",
        "kb/architecture#data-part-2",
    ] {
        assert!(keys.contains(&wanted), "{wanted} missing from {keys:?}");
    }
    for note in conversion
        .notes
        .iter()
        .filter(|n| n.file == "kb/architecture.md")
    {
        assert!(
            note.input.body.len() <= NOTE_BYTES,
            "{} is {} bytes",
            note.input.key,
            note.input.body.len()
        );
    }

    let hub = note(&conversion, "kb/architecture");
    assert_eq!(hub.input.aliases, ["ARCH"]);
    assert!(hub.input.body.contains("How it fits together."));
    assert!(
        hub.input.body.contains("- Parts › Router (#router)"),
        "{}",
        hub.input.body
    );
    assert!(
        hub.input
            .related
            .contains(&"kb/architecture#data".to_owned())
    );

    let router = note(&conversion, "kb/architecture#router");
    assert_eq!(router.input.title, "Option D architecture: Parts › Router");
    assert_eq!(router.input.aliases, ["ARCH#router"]);
    assert_eq!(router.input.related[0], "kb/architecture");
    assert!(
        router
            .input
            .related
            .contains(&"kb/decisions/DEC-350-links".to_owned())
    );
    assert!(
        router
            .input
            .body
            .starts_with("Architecture ARCH · section of kb/architecture · unverified\n\n")
    );
    // The short intro and the `# Parts` lead travel with the first section.
    assert!(
        router.input.body.contains("Short intro."),
        "{}",
        router.input.body
    );
    assert!(router.input.body.contains("The parts, in order."));
    assert!(
        router
            .input
            .source
            .as_deref()
            .unwrap()
            .ends_with("kb/architecture.md#router")
    );

    // Every part of a split table repeats its header.
    let data2 = note(&conversion, "kb/architecture#data-part-2");
    assert!(
        data2
            .input
            .body
            .contains("| Column | Meaning |\n|---|---|\n| col_"),
        "{}",
        data2.input.body
    );

    // Links with anchors reach the section holding that heading.
    let pointer = note(&conversion, "kb/pointer");
    assert_eq!(
        pointer.input.related,
        ["kb/architecture#router-1", "kb/architecture#data"]
    );
    let links = note(&conversion, "kb/architecture#links");
    assert!(
        links
            .input
            .related
            .iter()
            .all(|r| !r.starts_with("kb/architecture#")),
        "own sections are not related: {:?}",
        links.input.related
    );
}

#[test]
fn split_respects_the_budget_for_sentences_and_unbroken_text() {
    let measure = |t: &str| t.len();
    let long_sentence = "word ".repeat(400);
    let unbroken = "x".repeat(1_000);
    let body = format!("# A\n\n{long_sentence}\n\n# B\n\n{unbroken}");
    let pieces = split::split(&body, 300, &measure);
    assert!(
        pieces.iter().all(|p| p.text.len() <= 300),
        "{:?}",
        pieces.iter().map(|p| p.text.len()).collect::<Vec<_>>()
    );
    let joined: String = pieces
        .iter()
        .map(|p| p.text.replace(char::is_whitespace, ""))
        .collect();
    assert_eq!(joined.matches('x').count(), 1_000);
    let mut anchors: Vec<&str> = pieces.iter().map(|p| p.anchor.as_str()).collect();
    anchors.dedup();
    assert_eq!(anchors.len(), pieces.len(), "anchors are unique");
}

#[test]
fn anchors_follow_github() {
    assert_eq!(
        split::anchor("Why Option D: the runtime ADR"),
        "why-option-d-the-runtime-adr"
    );
    assert_eq!(
        split::anchor("  Saved answers in `GCS`  "),
        "saved-answers-in-gcs"
    );
    assert_eq!(split::anchor("Ação e reação"), "ação-e-reação");
}

#[test]
fn links_resolve_like_the_spec_says() {
    use links::{Href, resolve};
    let concept = |id: &str, anchor: Option<&str>| Href::Concept {
        id: id.to_owned(),
        anchor: anchor.map(str::to_owned),
    };
    assert_eq!(resolve("kb/a.md", "/kb/b.md"), concept("kb/b", None));
    assert_eq!(
        resolve("kb/x/a.md", "../b.md#Part"),
        concept("kb/b", Some("part"))
    );
    assert_eq!(resolve("kb/a.md", "./c/d.md"), concept("kb/c/d", None));
    assert_eq!(resolve("a.md", "../../escape.md"), Href::Outside);
    assert_eq!(resolve("kb/a.md", "/kb/"), Href::Navigation);
    assert_eq!(resolve("kb/a.md", "/kb/index.md"), Href::Navigation);
    assert_eq!(resolve("kb/a.md", "inventory.csv"), Href::Navigation);
    assert_eq!(resolve("kb/a.md", "#section"), Href::SameConcept);
    assert_eq!(resolve("kb/a.md", "https://x.example/a.md"), Href::External);
}
