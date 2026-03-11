## Backend API and Database Summary

### General

- **Backend**: Flask application in `customize.py`.
- **Port**: `5000` (`app.run(debug=True, port=5000)`).
- **Database folder**: `databases/` (relative to project root).
- **Main DB**: `databases/general.db`.
- **User DBs**: `databases/<account_id>.db`.

### Main Database (`general.db`)

- **accounts** table:
  - `account_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `email_address TEXT UNIQUE`
  - `display_name TEXT`
  - `provider_type TEXT NOT NULL DEFAULT 'imap'`
  - `imap_host TEXT`
  - `imap_port INTEGER`
  - `smtp_host TEXT`
  - `smtp_port INTEGER`
  - `auth_token TEXT`
  - `sync_status BOOLEAN DEFAULT 0`
  - `last_sync_time DATETIME`
  - `language TEXT DEFAULT 'EN'`
  - `theme TEXT DEFAULT 'SYSTEM'`
  - `font TEXT`

### User Database (`<account_id>.db`)

- **emails** table:
  - `local_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `server_uid INTEGER UNIQUE`
  - `uid_validity INTEGER NOT NULL`
  - `message_id TEXT UNIQUE`
  - `in_reply_to TEXT`
  - `sender_from TEXT NOT NULL`
  - `recipient_to TEXT NOT NULL`
  - `recipient_cc TEXT`
  - `recipient_bcc TEXT`
  - `subject TEXT DEFAULT ''`
  - `date_sent DATETIME NOT NULL`
  - `body_text TEXT`
  - `body_html TEXT`
  - `attach_amount INTEGER`
  - `is_read BOOLEAN DEFAULT 0`
  - `is_answered BOOLEAN DEFAULT 0`
  - `is_forwarded BOOLEAN DEFAULT 0`
  - `is_flagged BOOLEAN DEFAULT 0`
  - `user_labels TEXT`
  - `folder_id INTEGER NOT NULL`
  - `sync_status INTEGER DEFAULT 0`

- **attachments** table:
  - `ID INTEGER PRIMARY KEY AUTOINCREMENT`
  - `locale_mail_ID INTEGER NOT NULL`
  - `attachment_num INTEGER NOT NULL`
  - `file_name TEXT NOT NULL`
  - `just_name TEXT NOT NULL`
  - `just_file_extension TEXT NOT NULL`
  - `mime_type TEXT NOT NULL`
  - `file_size INTEGER NOT NULL`
  - `is_downloaded BOOLEAN DEFAULT 0`
  - `file_path TEXT`
  - `content_id TEXT NOT NULL`
  - `is_inline BOOLEAN NOT NULL`
  - `inline_temp_path TEXT`

- **folders** table:
  - `folder_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `path_by_name TEXT UNIQUE NOT NULL`
  - `path_by_id TEXT UNIQUE NOT NULL`
  - `name TEXT NOT NULL`
  - `type TEXT NOT NULL`
  - `unread_count INTEGER DEFAULT 0`
  - `total_count INTEGER DEFAULT 0`
  - `last_sync_uid INTEGER DEFAULT 0`
  - `is_visible BOOLEAN DEFAULT 1`

- **contacts** table:
  - `contact_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `name TEXT`
  - `display_name TEXT`
  - `mail_address TEXT`
  - `phone_numbe_country_code TEXT`
  - `phone_number INTEGER`
  - `fax_number INTEGER`
  - `website TEXT`
  - `last_contact_time DATETIME`

### HTTP API Contract

#### 1. `GET /api/auth/accounts`

- **Purpose**: To list registered accounts (for the login page).
- **Request**: No body.
- **Response (200)**:
  - JSON:
    - `accounts`: List of rows from the `accounts` table.

#### 2. `POST /api/auth/setup`

- **Purpose**: To perform an IMAP authorization test with the form from the login screen.
- **Request**: `application/x-www-form-urlencoded` form fields:
  - `EMAIL_ADDRESS`
  - `DISPLAY_NAME`
  - `IMAP_SERVER`
  - `IMAP_PORT` (optional, defaults to `143`)
  - `SMTP_SERVER`
  - `SMTP_PORT` (optional)
  - `PASSWORD`
  - `SKIP_AUTH` (`true`/`false`, default `false`)

- **Behavior**:
  - If `accounts.email_address = EMAIL_ADDRESS` already exists:
    - **409** and JSON:
      - `status: "already_exists"`
      - `message: "This email address is already registered."` (via i18n)
  - Otherwise:
    - If `SKIP_AUTH == true`:
      - Authorization test is skipped, `success = True`.
    - Otherwise:
      - `imap_client.authorize(IMAP_SERVER, EMAIL_ADDRESS, PASSWORD, IMAP_PORT, verify_ssl=False)` is called.
    - If `success`:
      - If an IMAP session exists, it is closed with `logout()`.
      - **200** and JSON:
        - `status: "success"`
        - `message: "Authorization successful."`
    - If not `success`:
      - **401** and JSON:
        - `status: "failure"`
        - `message`: Error message from the IMAP layer (with i18n).
        - `formData`: Object containing the original form fields returned to the frontend.

#### 3. `POST /api/account/finalize`

- **Purpose**: To save account information and preferences, and create the user DB.
- **Request**: `application/json` body:
  - `account`: Object
    - `email`
    - `displayName`
    - `imapServer`
    - `imapPort`
    - `smtpServer`
    - `smtpPort`
  - `language` (default: `en`)
  - `font` (default: `Arial`)
  - `theme` (default: `SYSTEM`)

- **Behavior**:
  - If a registration with the same `email` exists:
    - Form fields are updated with `UPDATE` in the `accounts` table.
  - Otherwise:
    - A new row is added with `INSERT`.
  - `create_user_db(account_id)` is called with the used `account_id`:
    - If necessary, `databases/<account_id>.db` and the tables within it are created.
  - `theme` is stored in `accounts.theme`.

- **Response (200)**:
  - JSON:
    - `status: "success"`
    - `message: "Account finalized successfully."`
    - `account_id`: The `account_id` value of the created or updated account.
