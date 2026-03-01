## Backend API ve Veritabanı Özeti

### Genel

- **Backend**: `customize.py` içinde Flask uygulaması.
- **Port**: `5000` (`app.run(debug=True, port=5000)`).
- **Veritabanı klasörü**: `databases/` (proje köküne göre).
- **Ana DB**: `databases/general.db`.
- **Kullanıcı DB’leri**: `databases/<account_id>.db`.

### Ana Veritabanı (`general.db`)

- **accounts** tablosu:
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
  - `theme TEXT DEFAULT 'LIGHT'`
  - `font TEXT`

- **ai** tablosu:
  - `id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `model_name TEXT`
  - `type BOOLEAN`
  - `api_key_server_url TEXT`
  - `base_url_context_window TEXT`

### Kullanıcı Veritabanı (`<account_id>.db`)

- **emails** tablosu:
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

- **attachments** tablosu:
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

- **folders** tablosu:
  - `folder_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `path_by_name TEXT UNIQUE NOT NULL`
  - `path_by_id TEXT UNIQUE NOT NULL`
  - `name TEXT NOT NULL`
  - `type TEXT NOT NULL`
  - `unread_count INTEGER DEFAULT 0`
  - `total_count INTEGER DEFAULT 0`
  - `last_sync_uid INTEGER DEFAULT 0`
  - `is_visible BOOLEAN DEFAULT 1`

- **contacts** tablosu:
  - `contact_id INTEGER PRIMARY KEY AUTOINCREMENT`
  - `name TEXT`
  - `display_name TEXT`
  - `mail_address TEXT`
  - `phone_numbe_country_code TEXT`
  - `phone_number INTEGER`
  - `fax_number INTEGER`
  - `website TEXT`
  - `last_contact_time DATETIME`

### HTTP API Sözleşmesi

#### 1. `GET /api/auth/accounts`

- **Amaç**: Kayıtlı hesapları listelemek (login sayfası için).
- **Request**: Body yok.
- **Response (200)**:
  - JSON:
    - `accounts`: `accounts` tablosundaki satırların listesi.

#### 2. `POST /api/auth/setup`

- **Amaç**: Login ekranından gelen form ile IMAP yetkilendirme testi yapmak.
- **Request**: `application/x-www-form-urlencoded` form alanları:
  - `EMAIL_ADDRESS`
  - `DISPLAY_NAME`
  - `IMAP_SERVER`
  - `IMAP_PORT` (opsiyonel, yoksa `143`)
  - `SMTP_SERVER`
  - `SMTP_PORT` (opsiyonel)
  - `PASSWORD`
  - `SKIP_AUTH` (`true`/`false`, default `false`)

- **Davranış**:
  - Eğer `accounts.email_address = EMAIL_ADDRESS` zaten varsa:
    - **409** ve JSON:
      - `status: "already_exists"`
      - `message: "This email address is already registered."` (i18n üzerinden)
  - Aksi halde:
    - Eğer `SKIP_AUTH == true`:
      - Yetkilendirme testi atlanır, `success = True`.
    - Değilse:
      - `imap_client.authorize(IMAP_SERVER, EMAIL_ADDRESS, PASSWORD, IMAP_PORT, verify_ssl=False)` çağrılır.
    - Eğer `success`:
      - Varsa IMAP oturumu `logout()` ile kapatılır.
      - **200** ve JSON:
        - `status: "success"`
        - `message: "Authorization successful."`
    - Eğer `success` değilse:
      - **401** ve JSON:
        - `status: "failure"`
        - `message`: IMAP katmanından gelen hata mesajı (i18n ile).
        - `formData`: Orijinal form alanlarının frontend’e geri döndüğü nesne.

#### 3. `POST /api/account/finalize`

- **Amaç**: Hesap bilgilerini, dil/font tercihini ve AI konfigürasyonunu kaydedip kullanıcı DB’sini oluşturmak.
- **Request**: `application/json` body:
  - `account`: Nesne
    - `email`
    - `displayName`
    - `imapServer`
    - `imapPort`
    - `smtpServer`
    - `smtpPort`
  - `language` (default: `en`)
  - `font` (default: `Arial`)
  - `ai`: Nesne (opsiyonel)
    - `type`
    - `model_name`
    - `api_key_server_url`
    - `base_url_context_window`

- **Davranış**:
  - Eğer aynı `email` ile kayıt varsa:
    - `accounts` tablosunda `UPDATE` ile alanlar güncellenir.
  - Yoksa:
    - `INSERT` ile yeni satır eklenir.
  - Kullanılan `account_id` ile `create_user_db(account_id)` çağrılır:
    - Gerekirse `databases/<account_id>.db` ve içindeki tablolar oluşturulur.
  - Eğer `ai` alanı doluysa:
    - `ai` tablosuna yeni satır eklenir.

- **Response (200)**:
  - JSON:
    - `status: "success"`
    - `message: "Account finalized successfully."`
    - `account_id`: Oluşturulan veya güncellenen hesabın `account_id` değeri.

