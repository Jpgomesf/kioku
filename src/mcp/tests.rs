//! Contract tests for the model-facing surface. They need no services.

use rmcp::model::JsonObject;
use serde_json::{Value, json};

use super::args::{
    FeedbackArgs, GetArgs, ImportArgs, KeyArgs, MaintenanceArgs, SaveArgs, SearchArgs, parse,
};
use super::resolve::{levenshtein, suggest};
use super::*;

fn profile(spec: &str) -> Vec<rmcp::model::Tool> {
    let selected = select_tools(spec).unwrap();
    MemoryServer::router_for(&selected, true).list_all()
}

fn obj(value: Value) -> JsonObject {
    match value {
        Value::Object(map) => map,
        _ => JsonObject::new(),
    }
}

/// What a client sees for a profile, in a stable, reviewable form.
fn contract(spec: &str) -> Value {
    let selected = select_tools(spec).unwrap();
    let tools: Vec<Value> = profile(spec)
        .into_iter()
        .map(|tool| serde_json::to_value(tool).unwrap())
        .collect();
    json!({"instructions": instructions_for(&selected, &Session::Open), "tools": tools})
}

/// Compare with the committed snapshot; KIOKU_BLESS=1 rewrites it.
fn check_snapshot(name: &str, value: &Value) {
    let path = std::path::Path::new(env!("CARGO_MANIFEST_DIR"))
        .join(format!("tests/snapshots/{name}.json"));
    let rendered = format!("{}\n", serde_json::to_string_pretty(value).unwrap());
    if std::env::var_os("KIOKU_BLESS").is_some() {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, &rendered).unwrap();
        return;
    }
    let committed = std::fs::read_to_string(&path).unwrap_or_default();
    assert!(
        committed == rendered,
        "the model-facing contract changed ({name}); review the diff and run `KIOKU_BLESS=1 cargo test` to accept it"
    );
}

#[test]
fn contract_snapshots() {
    check_snapshot("tools-core", &contract("core"));
    check_snapshot("tools-all", &contract("all"));
}

#[test]
fn profiles_select_the_documented_tools() {
    let names = |spec: &str| -> Vec<String> {
        profile(spec)
            .into_iter()
            .map(|t| t.name.to_string())
            .collect()
    };
    let mut core = CORE_TOOLS.map(str::to_owned).to_vec();
    core.sort();
    assert_eq!(names("core"), core);
    assert_eq!(names("all").len(), ALL_TOOLS.len());
    assert!(names("core,memory_import").contains(&"memory_import".to_owned()));
    assert!(select_tools("core,memory_destroy").is_err());
    let selected = select_tools("all").unwrap();
    let without_notes = MemoryServer::router_for(&selected, false).list_all();
    assert!(without_notes.iter().all(|t| t.name != "memory_import"));
}

#[test]
fn schemas_follow_the_compatibility_rules() {
    for tool in profile("all") {
        let problems = schema::lint(&tool.input_schema);
        assert!(problems.is_empty(), "{}: {problems:?}", tool.name);
        let description = tool.description.as_deref().unwrap_or_default();
        assert!(
            !description.is_empty() && description.len() <= 1000,
            "{} description length",
            tool.name
        );
        let size = serde_json::to_vec(&tool.input_schema).unwrap().len() + description.len();
        assert!(
            size <= 2600,
            "{} schema and description use {size} bytes",
            tool.name
        );
        assert!(
            tool.annotations.is_some(),
            "{} has no annotations",
            tool.name
        );
        assert!(tool.title.is_some(), "{} has no title", tool.name);
    }
    let core_bytes: usize = profile("core")
        .iter()
        .map(|t| serde_json::to_vec(t).unwrap().len())
        .sum();
    assert!(core_bytes <= 6000, "core tools/list is {core_bytes} bytes");
}

#[test]
fn required_fields_come_first_in_property_order() {
    for tool in profile("all") {
        let required: Vec<&str> = tool
            .input_schema
            .get("required")
            .and_then(Value::as_array)
            .map(|r| r.iter().filter_map(Value::as_str).collect())
            .unwrap_or_default();
        let order: Vec<&String> = tool
            .input_schema
            .get("properties")
            .and_then(Value::as_object)
            .map(|p| p.keys().collect())
            .unwrap_or_default();
        let first_optional = order
            .iter()
            .position(|name| !required.contains(&name.as_str()));
        if let Some(cut) = first_optional {
            assert!(
                order[cut..]
                    .iter()
                    .all(|name| !required.contains(&name.as_str())),
                "{}: required fields must come before optional ones: {order:?}",
                tool.name
            );
        }
    }
}

#[test]
fn documented_examples_parse() {
    let check = |tool: &str,
                 schema: &JsonObject,
                 hidden: &[&str],
                 example: &str,
                 parse_as: &dyn Fn(JsonObject) -> Result<(), String>| {
        let value: Value = serde_json::from_str(example).unwrap();
        let _ = (tool, schema, hidden);
        parse_as(obj(value)).unwrap_or_else(|e| panic!("{tool} example does not parse: {e}"));
    };
    check(
        "memory_search",
        &schema::input::<SearchArgs>(),
        &[],
        SEARCH_EXAMPLE,
        &|raw| {
            parse::<SearchArgs>(
                "memory_search",
                raw,
                &schema::input::<SearchArgs>(),
                &["graph_mode"],
                "",
            )
            .map(drop)
        },
    );
    check(
        "memory_get",
        &schema::input::<GetArgs>(),
        &[],
        GET_EXAMPLE,
        &|raw| parse::<GetArgs>("memory_get", raw, &schema::input::<GetArgs>(), &[], "").map(drop),
    );
    check(
        "memory_save",
        &schema::input::<SaveArgs>(),
        &[],
        SAVE_EXAMPLE,
        &|raw| {
            parse::<SaveArgs>("memory_save", raw, &schema::input::<SaveArgs>(), &[], "").map(drop)
        },
    );
    check(
        "memory_inspect",
        &schema::input::<KeyArgs>(),
        &[],
        KEY_EXAMPLE,
        &|raw| {
            parse::<KeyArgs>("memory_inspect", raw, &schema::input::<KeyArgs>(), &[], "").map(drop)
        },
    );
    check(
        "memory_feedback",
        &schema::input::<FeedbackArgs>(),
        &[],
        FEEDBACK_EXAMPLE,
        &|raw| {
            parse::<FeedbackArgs>(
                "memory_feedback",
                raw,
                &schema::input::<FeedbackArgs>(),
                &[],
                "",
            )
            .map(drop)
        },
    );
    check(
        "memory_import",
        &schema::input::<ImportArgs>(),
        &[],
        IMPORT_EXAMPLE,
        &|raw| {
            parse::<ImportArgs>(
                "memory_import",
                raw,
                &schema::input::<ImportArgs>(),
                &[],
                "",
            )
            .map(drop)
        },
    );
    check(
        "memory_maintenance",
        &schema::input::<MaintenanceArgs>(),
        &[],
        MAINTENANCE_EXAMPLE,
        &|raw| {
            parse::<MaintenanceArgs>(
                "memory_maintenance",
                raw,
                &schema::input::<MaintenanceArgs>(),
                &[],
                "",
            )
            .map(drop)
        },
    );
    // The save example in the tool description is the same one.
    let save = profile("core")
        .into_iter()
        .find(|t| t.name == "memory_save")
        .unwrap();
    assert!(
        save.description
            .unwrap()
            .contains("webhook-dedup-retention")
    );
}

#[test]
fn malformed_calls_get_a_useful_answer_never_a_protocol_error() {
    let schema = schema::input::<SearchArgs>();
    let cases = [
        json!({"query": "q", "limit": "3"}),
        json!({"query": "q", "limit": 300}),
        json!({"query": "q", "include_legacy": "no"}),
        json!({"query": 2024}),
        json!({"query": "q", "domain": null}),
        json!({"query": "q", "domain_filter": "relay", "graph_mode": "off"}),
        json!({"query": "q", "project": "relay"}),
        json!({"query": "q", "response_format": "SHORT"}),
        json!({"query": "q", "limit": "three"}),
        json!({}),
    ];
    for case in cases {
        match parse::<SearchArgs>(
            "memory_search",
            obj(case.clone()),
            &schema,
            &["graph_mode"],
            SEARCH_EXAMPLE,
        ) {
            Ok(_) => {}
            Err(text) => {
                assert!(text.starts_with("invalid_argument:"), "{case}: {text}");
                assert!(text.contains("Example:"), "{case}: {text}");
                assert!(text.chars().count() <= 600, "{case}: too long");
            }
        }
    }
}

#[test]
fn legacy_calls_are_upgraded() {
    let mut request = CallToolRequestParams::new("memory_upsert").with_arguments(obj(json!({
        "note": {"key": "k", "title": "T", "body": "B", "domain": "d", "pinned": false, "confidence": 0.9}
    })));
    assert_eq!(upgrade_legacy(&mut request).unwrap(), "memory_upsert");
    assert_eq!(request.name, "memory_save");
    let args = request.arguments.unwrap();
    assert_eq!(args["key"], "k");
    assert!(
        !args.contains_key("pinned")
            && !args.contains_key("confidence")
            && !args.contains_key("note")
    );

    let mut pinned = CallToolRequestParams::new("memory_upsert")
        .with_arguments(obj(json!({"note": {"key": "k", "pinned": true}})));
    assert!(
        upgrade_legacy(&mut pinned)
            .unwrap_err()
            .contains("kioku pin")
    );

    let mut query =
        CallToolRequestParams::new("rag_context").with_arguments(obj(json!({"query": "q"})));
    upgrade_legacy(&mut query).unwrap();
    assert_eq!(query.name, "rag_context_query");

    let mut by_ids = CallToolRequestParams::new("rag_context")
        .with_arguments(obj(json!({"ids": ["a"], "include_legacy": false})));
    upgrade_legacy(&mut by_ids).unwrap();
    assert_eq!(by_ids.name, "memory_get");
    assert!(!by_ids.arguments.unwrap().contains_key("include_legacy"));

    for (old, new) in [
        ("rag_search", "memory_search"),
        ("task_route", "memory_search"),
        ("graph_context", "memory_inspect"),
        ("memory_hydrate", "memory_import"),
    ] {
        let mut request = CallToolRequestParams::new(old);
        upgrade_legacy(&mut request).unwrap();
        assert_eq!(request.name, new);
    }
}

#[test]
fn suggestions_find_near_misses() {
    let keys: Vec<String> = [
        "webhook-retries",
        "webhook-dedup-retention",
        "billing-ledger",
    ]
    .map(str::to_owned)
    .to_vec();
    assert_eq!(
        suggest("webhook-retry", &keys).first().map(String::as_str),
        Some("\"webhook-retries\"")
    );
    assert!(suggest("zzzz", &keys).is_empty());
    assert_eq!(levenshtein("kitten", "sitting"), 3);
}

#[test]
fn instructions_stay_within_client_limits() {
    let core = instructions_for(&select_tools("core").unwrap(), &Session::Open);
    let all = instructions_for(&select_tools("all").unwrap(), &Session::Open);
    assert!(
        all.len() < 4096,
        "Claude Code truncates instructions at 4096 characters"
    );
    // Codex treats the first 512 characters as the summary: they must name the core flow.
    let head: String = core.chars().take(512).collect();
    for needle in ["memory_search", "memory_get", "untrusted"] {
        assert!(
            head.contains(needle),
            "the first 512 characters must mention {needle}"
        );
    }
}

#[test]
fn read_scope_matches_read_only_annotations() {
    use crate::access::{Scope, required_scope};
    for tool in profile("all") {
        let read_only = tool
            .annotations
            .as_ref()
            .and_then(|a| a.read_only_hint)
            .unwrap_or(false);
        assert_eq!(
            required_scope(&tool.name) == Scope::Read,
            read_only,
            "{}: scope and readOnlyHint disagree",
            tool.name
        );
    }
    for legacy in ["rag_search", "task_route", "rag_context", "memory_hydrate"] {
        let mut request = CallToolRequestParams::new(legacy);
        let _ = upgrade_legacy(&mut request);
        assert_ne!(
            request.name.as_ref(),
            legacy,
            "{legacy} is upgraded before the scope check"
        );
    }
}

/// With vaults, a search without a domain covers the session's vault or area,
/// so the policy says to leave the domain out instead of guessing one from
/// the folder name.
#[test]
fn vault_instructions_say_to_search_without_a_domain() {
    let root = std::env::temp_dir().join(format!("kioku-instructions-{}", std::process::id()));
    for dir in ["work/web", "work/api/src"] {
        std::fs::create_dir_all(root.join(dir)).unwrap();
    }
    let text = format!(
        r#"
        [[vault]]
        name = "work"
        paths = ["{0}/work"]
        domains = ["work", "work/*"]
        providers = ["anthropic"]
        default_domain = "work"

        [[area]]
        domain = "work/api"
        paths = ["{0}/work/api"]
        "#,
        root.display()
    );
    let vaults = std::sync::Arc::new(
        crate::vault::Vaults::parse(&text, std::path::Path::new("/cfg/vaults.toml"), None).unwrap(),
    );
    let place =
        |dir: &str| Session::for_folder(Some(&vaults), Some("anthropic"), Some(&root.join(dir)));
    let all = select_tools("all").unwrap();
    let open = instructions_for(&all, &Session::Open);
    let at_root = instructions_for(&all, &place("work/web"));
    let in_area = instructions_for(&all, &place("work/api/src"));
    let refused = instructions_for(&all, &Session::Refused("no vault".into()));
    std::fs::remove_dir_all(&root).unwrap();

    assert!(open.contains("else the repository folder name") && open.contains("\"local\""));
    assert!(
        at_root.contains("call memory_search without a domain: this session is in vault \"work\"")
            && at_root.contains("every domain of the vault")
            && at_root.contains("else \"work\".")
    );
    assert!(
        in_area.contains("in area \"work/api\" of vault \"work\"")
            && in_area.contains("Save with domain \"work/api\".")
    );
    assert!(refused.contains("without a domain"));
    for text in [&at_root, &in_area, &refused] {
        assert!(!text.contains("repository folder name") && !text.contains("\"local\""));
        assert!(
            text.len() < 4096,
            "Claude Code truncates instructions at 4096 characters"
        );
        let head: String = text.chars().take(512).collect();
        assert!(
            head.contains("memory_search")
                && head.contains("memory_get")
                && head.contains("untrusted")
        );
    }
}
