## guvercin

Important: This software is licensed under the Apache License 2.0 with a Commons Clause condition. Commercial use, selling, or sub-licensing the software is strictly prohibited.

### Backend (Rust / Axum)

- The backend is now completely written in **Rust** and is located under the `rust-backend` folder.
- Key technologies used:
  - Axum (HTTP server)
  - Tokio (async runtime)
  - SQLx (SQLite access)
  - IMAP (to connect to IMAP servers)

### Desktop App (Single Process UX)

The app is configured as a **single Tauri desktop application**:
- Frontend starts inside Tauri.
- Rust backend starts automatically inside the same desktop app process lifecycle.
- You do **not** need to run backend separately.

#### Run (development)

```bash
npm run app:dev
```

#### Build desktop bundle

```bash
npm run app:build
```

Notes:
- Backend HTTP API is still served internally on `127.0.0.1:5000` by the Tauri-embedded backend thread.
- No separate `cargo run` for backend is required during normal desktop app usage.

#### Database

- Database files are kept under the `databases/` folder at the project root:
  - `general.db`: account and AI configuration tables.
  - `<account_id>.db`: separate email/attachment/folder/reference tables for each user.
- When the Rust backend first runs, it automatically creates the necessary tables (to be compatible with the schema on the Python side).

#### IMAP Authorization

- The `imap_client` module within `rust-backend` tests authorization by connecting to the IMAP server and logging in with the username/password.
- This behavior re-implements the functionality of the previous Python `imap_client.py` using Rust.

### Frontend

- The frontend code is in the `frontend` folder (React/Vite).
- It communicates with the backend over HTTP; having the Rust backend running is sufficient.
