//! Tauri commands, one module per area. Names and types mirror `src/api/client.ts`
//! and `src/api/types.ts`; change both sides together.

pub mod app;
pub mod areas;
pub mod graph;
pub mod health;
pub mod notes;
pub mod reflect;
pub mod search;
pub mod vaults;
