#[tokio::main]
async fn main() -> anyhow::Result<()> {
    rust_backend::run(None).await
}
