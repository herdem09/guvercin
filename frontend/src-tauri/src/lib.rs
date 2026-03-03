#[tauri::command]
fn open_mail_window(handle: tauri::AppHandle) -> Result<String, String> {
  let mail_window = tauri::window::WindowBuilder::new(&handle, "mail", tauri::WindowUrl::App("mail.html".into()))
    .inner_size(800.0, 600.0)
    .resizable(true)
    .build()
    .map_err(|e| e.to_string())?;
  
  Ok(mail_window.label().to_string())
}

#[tauri::command]
fn close_mail_window(handle: tauri::AppHandle) -> Result<(), String> {
  if let Some(window) = handle.get_webview_window("mail") {
    window.close().map_err(|e| e.to_string())?;
  }
  Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  std::thread::spawn(|| {
    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(async {
      if let Err(e) = rust_backend::run().await {
        eprintln!("Backend error: {}", e);
      }
    });
  });

  tauri::Builder::default()
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .invoke_handler(tauri::generate_handler![open_mail_window, close_mail_window])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
