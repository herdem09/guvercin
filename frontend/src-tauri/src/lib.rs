use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};

/// Shared state that maps window labels → mail data JSON.
/// The new window calls `get_mail_window_data` to consume its entry.
#[derive(Default)]
struct MailWindowStore(Mutex<HashMap<String, String>>);

#[tauri::command]
async fn open_mail_window(
  handle: tauri::AppHandle,
  label: String,
  mail_data_json: String,
) -> Result<(), String> {
  let label = if label.trim().is_empty() {
    "mail".to_string()
  } else {
    label
  };

  if let Some(window) = handle.get_webview_window(&label) {
    window.show().map_err(|e| e.to_string())?;
    let _ = window.set_focus();
    return Ok(());
  }

  // Store the payload in shared app state so the new window can retrieve it
  // via `get_mail_window_data`. We cannot use localStorage (isolated per webview)
  // or URL query parameters (PathBuf strips them on App protocol).
  {
    let store = handle.state::<MailWindowStore>();
    let mut map = store.0.lock().unwrap();
    map.insert(label.clone(), mail_data_json);
  }

  WebviewWindowBuilder::new(
    &handle,
    &label,
    WebviewUrl::App(PathBuf::from("index.html")),
  )
  .title("Guvercin - Mail")
  .visible(true)
  .build()
  .map_err(|e| e.to_string())?;

  Ok(())
}

/// Called by the new window on startup to fetch (and consume) its mail data.
#[tauri::command]
fn get_mail_window_data(
  label: String,
  store: State<'_, MailWindowStore>,
) -> Option<String> {
  let mut map = store.0.lock().unwrap();
  map.remove(&label)
}

#[tauri::command]
fn close_mail_window(handle: tauri::AppHandle, label: String) -> Result<(), String> {
  let label = if label.trim().is_empty() {
    "mail".to_string()
  } else {
    label
  };

  if let Some(window) = handle.get_webview_window(&label) {
    let _ = window.close();
  }
  Ok(())
}


#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .setup(|app| {
      let _app_handle = app.handle().clone();
      
      // Get app data directory for database
      let db_dir = app.path().app_data_dir().ok().map(|path| {
        let db_path = path.join("databases");
        let _ = std::fs::create_dir_all(&db_path);
        db_path
      });

      // Spawn backend in a separate thread
      std::thread::spawn(move || {
        let rt = tokio::runtime::Runtime::new().unwrap();
        rt.block_on(async {
          if let Err(e) = rust_backend::run(db_dir).await {
            eprintln!("Backend error: {}", e);
          }
        });
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_mail_window, get_mail_window_data, close_mail_window])
    .manage(MailWindowStore::default())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
