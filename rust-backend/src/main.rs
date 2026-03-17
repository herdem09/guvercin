#[tokio::main]
async fn main() -> anyhow::Result<()> {
    let args: Vec<String> = std::env::args().collect();
    if args.iter().any(|a| a == "--init-keyring") {
        return rust_backend::init_keyring().await;
    }
    if args.iter().any(|a| a == "--check-keyring") {
        return rust_backend::check_keyring().await;
    }

    rust_backend::run(None).await
}
