use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

use tauri::{Manager, State, WebviewUrl, WebviewWindowBuilder};
use serde_json::Value;

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

#[tauri::command]
fn save_export_file_to_path(path: String, bytes: Vec<u8>) -> Result<(), String> {
  let path = PathBuf::from(path);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).map_err(|e| e.to_string())?;
  }

  fs::write(&path, bytes).map_err(|e| e.to_string())?;
  Ok(())
}

fn sanitize_theme_name(input: &str) -> String {
  let mut out = String::new();
  for ch in input.trim().to_lowercase().chars() {
    if ch.is_ascii_alphanumeric() || ch == '-' || ch == '_' {
      out.push(ch);
    } else if ch.is_whitespace() {
      out.push('-');
    }
  }
  while out.contains("--") {
    out = out.replace("--", "-");
  }
  out.trim_matches('-').to_string()
}

fn user_theme_dir(handle: &tauri::AppHandle) -> Result<PathBuf, String> {
  let base = handle
    .path()
    .app_data_dir()
    .map_err(|e| e.to_string())?;
  let dir = base.join("themes").join("user");
  fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
  Ok(dir)
}

fn validate_theme_json(raw: &str) -> Result<Value, String> {
  let mut value: Value = serde_json::from_str(raw).map_err(|e| e.to_string())?;
  let obj = value.as_object_mut().ok_or_else(|| "Theme JSON must be an object".to_string())?;

  let name = obj
    .get("name")
    .and_then(|v| v.as_str())
    .unwrap_or("")
    .trim();
  if name.is_empty() {
    return Err("Theme JSON missing name".to_string());
  }

  let vars = obj
    .get("vars")
    .and_then(|v| v.as_object())
    .ok_or_else(|| "Theme JSON missing vars".to_string())?;
  if vars.is_empty() {
    return Err("Theme JSON vars is empty".to_string());
  }

  for (k, v) in vars.iter() {
    if !k.starts_with("--") {
      return Err("Theme vars keys must start with --".to_string());
    }
    if !v.is_string() {
      return Err("Theme vars values must be strings".to_string());
    }
  }

  Ok(value)
}

#[tauri::command]
fn list_user_themes(handle: tauri::AppHandle) -> Result<Vec<String>, String> {
  let dir = user_theme_dir(&handle)?;
  let mut out: Vec<String> = vec![];
  for entry in fs::read_dir(dir).map_err(|e| e.to_string())? {
    let entry = entry.map_err(|e| e.to_string())?;
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()).unwrap_or("") != "json" {
      continue;
    }
    if let Some(stem) = path.file_stem().and_then(|s| s.to_str()) {
      if !stem.trim().is_empty() {
        out.push(stem.to_string());
      }
    }
  }
  out.sort();
  out.dedup();
  Ok(out)
}

#[tauri::command]
fn read_user_theme(handle: tauri::AppHandle, name: String) -> Result<String, String> {
  let safe = sanitize_theme_name(&name);
  if safe.is_empty() {
    return Err("Invalid theme name".to_string());
  }
  let dir = user_theme_dir(&handle)?;
  let path = dir.join(format!("{safe}.json"));
  fs::read_to_string(path).map_err(|e| e.to_string())
}

#[tauri::command]
fn write_user_theme(handle: tauri::AppHandle, name: String, json: String) -> Result<(), String> {
  let safe = sanitize_theme_name(&name);
  if safe.is_empty() {
    return Err("Invalid theme name".to_string());
  }
  let mut value = validate_theme_json(&json)?;

  if let Some(obj) = value.as_object_mut() {
    obj.insert("name".to_string(), Value::String(safe.clone()));
  }

  let dir = user_theme_dir(&handle)?;
  let path = dir.join(format!("{safe}.json"));
  fs::write(path, serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?)
    .map_err(|e| e.to_string())?;
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_log::Builder::default().build())
    .plugin(tauri_plugin_dialog::init())
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
          use tauri_plugin_dialog::{DialogExt, MessageDialogButtons, MessageDialogKind};
          
          loop {
            match rust_backend::run(db_dir.clone()).await {
              Ok(_) => break,
              Err(rust_backend::error::AppError::KeyringDenied(_)) => {
                let confirmed = _app_handle.dialog()
                  .message("Access to the secure storage was denied. Guvercin needs this access to protect your account data.")
                  .title("Keyring Access Required")
                  .kind(MessageDialogKind::Warning)
                  .buttons(MessageDialogButtons::OkCancelCustom("Retry".to_string(), "Quit".to_string()))
                  .blocking_show();
                
                if confirmed {
                    // Retry selected (OkCustom)
                    continue;
                } else {
                    // Quit selected (CancelCustom)
                    _app_handle.exit(0);
                    break;
                }
              }
              Err(e) => {
                eprintln!("Backend error: {}", e);
                _app_handle.dialog()
                  .message(format!("The backend failed to start: {}", e))
                  .title("Initialization Error")
                  .kind(MessageDialogKind::Error)
                  .blocking_show();
                _app_handle.exit(1);
                break;
              }
            }
          }
        });
      });

      Ok(())
    })
    .invoke_handler(tauri::generate_handler![
      open_mail_window,
      get_mail_window_data,
      close_mail_window,
      save_export_file_to_path,
      list_user_themes,
      read_user_theme,
      write_user_theme
    ])
    .manage(MailWindowStore::default())
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
