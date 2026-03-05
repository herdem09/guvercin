fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_log::Builder::default().build())
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
