//! JSON Schemas for tool inputs, shaped for the widest client and model support.
//!
//! Some clients and tool-call parsers mishandle `$ref`, nullable type unions,
//! `anyOf`, and `format`, or drop `default`, `minimum`, and `maximum`. Every
//! input schema is therefore flat and inlined, gives each property exactly one
//! type, and states ranges and defaults in descriptions as well.

use std::sync::Arc;

use rmcp::model::JsonObject;
use schemars::JsonSchema;
use schemars::generate::SchemaSettings;
use serde_json::{Value, json};

/// The model-facing input schema for `T`.
pub fn input<T: JsonSchema>() -> Arc<JsonObject> {
    let generator = SchemaSettings::draft2020_12()
        .with(|settings| {
            settings.meta_schema = None;
            settings.inline_subschemas = true;
        })
        .into_generator();
    let root = generator.into_root_schema_for::<T>();
    let mut object = match serde_json::to_value(root) {
        Ok(Value::Object(object)) => object,
        _ => JsonObject::new(),
    };
    simplify(&mut object);
    object.remove("description");
    object.insert("type".into(), json!("object"));
    object.entry("properties").or_insert_with(|| json!({}));
    object.insert("additionalProperties".into(), json!(false));
    Arc::new(object)
}

/// Schema for a tool without arguments.
pub fn empty() -> Arc<JsonObject> {
    let mut object = JsonObject::new();
    object.insert("type".into(), json!("object"));
    object.insert("properties".into(), json!({}));
    object.insert("additionalProperties".into(), json!(false));
    Arc::new(object)
}

/// Remove constructs that some clients or models mishandle.
fn simplify(schema: &mut JsonObject) {
    for keyword in ["$schema", "format", "title"] {
        schema.remove(keyword);
    }
    // ["string", "null"] -> "string": optional means "not required", never null.
    if let Some(Value::Array(types)) = schema.get("type") {
        let kept: Vec<Value> = types
            .iter()
            .filter(|t| t.as_str() != Some("null"))
            .cloned()
            .collect();
        if kept.len() == 1 {
            schema.insert("type".into(), kept[0].clone());
        }
    }
    for keyword in ["anyOf", "oneOf"] {
        let Some(Value::Array(options)) = schema.get(keyword) else {
            continue;
        };
        let kept: Vec<Value> = options
            .iter()
            .filter(|o| o.get("type").and_then(Value::as_str) != Some("null"))
            .cloned()
            .collect();
        if let [Value::Object(inner)] = kept.as_slice() {
            let inner = inner.clone();
            schema.remove(keyword);
            for (key, value) in inner {
                schema.entry(key).or_insert(value);
            }
        }
    }
    if let Some(Value::Array(values)) = schema.get_mut("enum") {
        values.retain(|v| !v.is_null());
    }
    if schema.get("default") == Some(&Value::Null) {
        schema.remove("default");
    }
    if let Some(Value::Object(properties)) = schema.get_mut("properties") {
        for property in properties.values_mut() {
            if let Value::Object(property) = property {
                simplify(property);
            }
        }
    }
    if let Some(Value::Object(items)) = schema.get_mut("items") {
        simplify(items);
    }
}

/// Everything in `schema` that breaks the compatibility rules above. Empty
/// means the schema is safe to publish.
#[cfg(test)]
pub fn lint(schema: &JsonObject) -> Vec<String> {
    fn walk(value: &Value, path: &str, problems: &mut Vec<String>, is_property: bool) {
        let Value::Object(map) = value else {
            return;
        };
        for banned in [
            "$ref", "$defs", "anyOf", "oneOf", "allOf", "not", "format", "$schema",
        ] {
            if map.contains_key(banned) {
                problems.push(format!("{path}: uses {banned}"));
            }
        }
        if matches!(map.get("type"), Some(Value::Array(_))) {
            problems.push(format!("{path}: has a type union"));
        }
        if map
            .get("enum")
            .and_then(Value::as_array)
            .is_some_and(|values| values.iter().any(Value::is_null))
        {
            problems.push(format!("{path}: enum contains null"));
        }
        if is_property && !map.contains_key("description") {
            problems.push(format!("{path}: has no description"));
        }
        if let Some(Value::Object(properties)) = map.get("properties") {
            for (name, property) in properties {
                walk(property, &format!("{path}.{name}"), problems, true);
            }
        }
        if let Some(items) = map.get("items") {
            walk(items, &format!("{path}[]"), problems, false);
        }
    }
    let mut problems = Vec::new();
    walk(&Value::Object(schema.clone()), "$", &mut problems, false);
    if schema.get("additionalProperties") != Some(&json!(false)) {
        problems.push("$: must set additionalProperties to false".into());
    }
    problems
}
