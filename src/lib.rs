//! Kioku: curated long-term memory for coding agents, served over MCP.

pub mod app;
pub mod config;
pub mod embedding;
pub mod error;
pub mod eval;
pub mod graph;
pub mod lifecycle;
pub mod markdown;
pub mod mcp;
pub mod model;
pub mod rank;
pub mod secrets;
pub mod store;
#[cfg(test)]
mod testing;
pub mod text;
pub mod trace;
pub mod vector;
