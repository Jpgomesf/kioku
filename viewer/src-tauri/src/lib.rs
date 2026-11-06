//! Kioku Viewer's Rust side: Tauri commands over the kioku library.

mod commands;
mod data;
mod error;
mod state;

pub use error::{CommandError, CommandResult};
pub use state::AppState;

/// Build and run the app.
pub fn run() {
    let result = tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::areas::list_vaults,
            commands::areas::list_areas,
            commands::notes::list_notes,
            commands::notes::get_note,
            commands::search::search_notes,
            commands::graph::get_graph,
            commands::health::get_stats,
            commands::health::get_service_status,
            commands::reflect::list_reflect_runs,
            commands::reflect::get_reflect_settings,
            commands::reflect::start_reflect,
            commands::reflect::save_reflect_settings,
            commands::reflect::dismiss_finding,
            commands::vaults::get_vaults_config,
            commands::vaults::preview_visibility,
            commands::vaults::apply_visibility,
            commands::vaults::list_access_requests,
            commands::vaults::respond_access_request,
            commands::app::get_app_info,
            commands::app::check_for_updates,
            commands::app::list_release_notes,
        ])
        .run(tauri::generate_context!());
    if let Err(err) = result {
        eprintln!("Kioku Viewer stopped: {err}");
        std::process::exit(1);
    }
}
