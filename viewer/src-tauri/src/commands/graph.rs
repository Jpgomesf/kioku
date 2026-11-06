//! Graph: `get_graph`.

use serde::{Deserialize, Serialize};

use super::notes::{NoteKind, NoteStatus};
use std::collections::{HashMap, HashSet};

use kioku::model::{Edge, Note};
use tauri::State;
use uuid::Uuid;

use crate::data::notes;
use crate::error::{CommandError, CommandResult};
use crate::state::AppState;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphNode {
    pub key: String,
    pub domain: String,
    pub title: String,
    pub kind: NoteKind,
    pub status: NoteStatus,
    pub degree: u32,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphEdge {
    pub source: String,
    pub target: String,
    pub relation: String,
    pub suggested: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphData {
    pub nodes: Vec<GraphNode>,
    pub edges: Vec<GraphEdge>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GraphQuery {
    pub domain: String,
    #[serde(default)]
    pub focus: Option<String>,
    #[serde(default)]
    pub depth: Option<u32>,
}

/// Most hops a focused graph reaches.
const MAX_DEPTH: u32 = 4;

/// The graph of `notes` and `edges`, or with `focus` only the notes within
/// `depth` hops of it, links followed in both directions.
pub(crate) fn build_graph(
    notes: &[Note],
    edges: &[Edge],
    focus: Option<&str>,
    depth: u32,
) -> CommandResult<GraphData> {
    let ids: HashMap<Uuid, &Note> = notes.iter().map(|n| (n.id, n)).collect();
    let edges: Vec<&Edge> = edges
        .iter()
        .filter(|e| {
            e.source != e.target && ids.contains_key(&e.source) && ids.contains_key(&e.target)
        })
        .collect();
    let mut degree: HashMap<Uuid, u32> = HashMap::new();
    for edge in &edges {
        *degree.entry(edge.source).or_default() += 1;
        *degree.entry(edge.target).or_default() += 1;
    }
    let keep: Option<HashSet<Uuid>> = match focus {
        None => None,
        Some(key) => {
            let start = notes
                .iter()
                .find(|n| n.input.key == key)
                .ok_or_else(|| CommandError::not_found(format!("No note {key:?} in this area.")))?
                .id;
            let mut seen = HashSet::from([start]);
            let mut frontier = vec![start];
            for _ in 0..depth {
                let mut next = Vec::new();
                for edge in &edges {
                    for (from, to) in [(edge.source, edge.target), (edge.target, edge.source)] {
                        if frontier.contains(&from) && seen.insert(to) {
                            next.push(to);
                        }
                    }
                }
                if next.is_empty() {
                    break;
                }
                frontier = next;
            }
            Some(seen)
        }
    };
    let kept = |id: &Uuid| keep.as_ref().is_none_or(|k| k.contains(id));
    let nodes = notes
        .iter()
        .filter(|n| kept(&n.id))
        .map(|n| GraphNode {
            key: n.input.key.clone(),
            domain: n.input.domain.clone(),
            title: n.input.title.clone(),
            kind: notes::kind_of(&n.input.tags),
            status: notes::status_of(n.status),
            degree: degree.get(&n.id).copied().unwrap_or(0),
        })
        .collect();
    let edges = edges
        .iter()
        .filter(|e| kept(&e.source) && kept(&e.target))
        .filter_map(|e| {
            Some(GraphEdge {
                source: ids.get(&e.source)?.input.key.clone(),
                target: ids.get(&e.target)?.input.key.clone(),
                relation: e.kind.clone(),
                suggested: false,
            })
        })
        .collect();
    Ok(GraphData { nodes, edges })
}

#[tauri::command]
pub async fn get_graph(state: State<'_, AppState>, query: GraphQuery) -> CommandResult<GraphData> {
    let depth = query.depth.unwrap_or(1);
    if depth == 0 || depth > MAX_DEPTH {
        return Err(CommandError::invalid_argument(format!(
            "depth must be between 1 and {MAX_DEPTH}"
        )));
    }
    let services = state.read_only().await?;
    let domain = Some(query.domain.as_str());
    let all = services.store.notes(domain, true).await?;
    let edges = services.store.edges(domain).await?;
    build_graph(&all, &edges, query.focus.as_deref(), depth)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::data::notes::tests::note;

    fn chain() -> (Vec<Note>, Vec<Edge>) {
        let notes: Vec<Note> = ["a", "b", "c", "d"]
            .iter()
            .map(|k| note("demo", k, &[], None))
            .collect();
        let edge = |s: usize, t: usize| Edge {
            source: notes[s].id,
            target: notes[t].id,
            kind: "related".into(),
            weight: 1.0,
        };
        let edges = vec![edge(0, 1), edge(2, 1), edge(2, 3)];
        (notes, edges)
    }

    #[test]
    fn whole_area_has_every_node_and_degree() -> CommandResult<()> {
        let (notes, edges) = chain();
        let g = build_graph(&notes, &edges, None, 1)?;
        assert_eq!(g.nodes.len(), 4);
        assert_eq!(g.edges.len(), 3);
        assert_eq!(
            g.nodes.iter().find(|n| n.key == "b").map(|n| n.degree),
            Some(2)
        );
        Ok(())
    }

    #[test]
    fn focus_follows_links_both_ways() -> CommandResult<()> {
        let (notes, edges) = chain();
        let keys = |g: &GraphData| {
            let mut k: Vec<String> = g.nodes.iter().map(|n| n.key.clone()).collect();
            k.sort();
            k
        };
        assert_eq!(
            keys(&build_graph(&notes, &edges, Some("a"), 1)?),
            ["a", "b"]
        );
        assert_eq!(
            keys(&build_graph(&notes, &edges, Some("a"), 2)?),
            ["a", "b", "c"]
        );
        let g = build_graph(&notes, &edges, Some("a"), 2)?;
        assert_eq!(g.edges.len(), 2);
        assert!(build_graph(&notes, &edges, Some("zz"), 1).is_err());
        Ok(())
    }
}
