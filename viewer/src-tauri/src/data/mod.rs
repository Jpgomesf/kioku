//! Read-only data access behind the commands: configuration, the vaults file,
//! note mapping, visibility previews and the Reflect cache. Nothing here writes.

pub mod counts;
pub mod diff;
pub mod env;
pub mod links;
pub mod notes;
pub mod reflect_cache;
pub mod scope;
pub mod search;
pub mod vaults_file;
pub mod visibility;
