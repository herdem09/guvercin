## guvercin

Important: This software is licensed under the Apache License 2.0 with a Commons Clause condition. Commercial use, selling, or sub-licensing the software is strictly prohibited.

### Backend (Rust / Axum)

- Backend artık tamamen **Rust** ile yazılmıştır ve `rust-backend` klasörü altında yer alır.
- Kullanılan başlıca teknolojiler:
  - Axum (HTTP server)
  - Tokio (async runtime)
  - SQLx (SQLite erişimi)
  - IMAP (IMAP sunucularına bağlanmak için)

#### Çalıştırma

```bash
cd rust-backend
cargo run
```

- Sunucu varsayılan olarak `0.0.0.0:5000` adresinde ayağa kalkar.
- Frontend, eski Flask backend ile aynı API endpoint’lerini (`/api/auth/accounts`, `/api/auth/setup`, `/api/account/finalize`) kullanmaya devam eder.

#### Veritabanı

- Veritabanı dosyaları proje kökünde `databases/` klasörü altında tutulur:
  - `general.db`: hesap ve AI konfigürasyon tabloları.
  - `<account_id>.db`: her kullanıcı için ayrı e-posta/ek/klasör/referans tabloları.
- Rust backend ilk çalıştığında, gerekli tabloları otomatik olarak oluşturur (Python tarafındaki şema ile uyumlu olacak şekilde).

#### IMAP Yetkilendirmesi

- `rust-backend` içindeki `imap_client` modülü, IMAP sunucusuna bağlanıp kullanıcı adı/şifre ile giriş yaparak yetkilendirmeyi test eder.
- Bu davranış, önceki Python `imap_client.py` fonksiyonelliğini Rust ile yeniden uygular.

### Frontend

- Frontend kodu `frontend` klasöründedir (React/Vite).
- Backend ile HTTP üzerinden konuşur; Rust backend’in ayağa kalkmış olması yeterlidir.

