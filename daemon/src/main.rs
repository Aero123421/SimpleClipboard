use anyhow::Context;
use simpleclipboardd::{service::ClipboardService, store::Store};
use zbus::connection::Builder;

const BUS_NAME: &str = "io.github.sahur.SimpleClipboard1";
const OBJECT_PATH: &str = "/io/github/sahur/SimpleClipboard";

#[tokio::main(flavor = "current_thread")]
async fn main() -> anyhow::Result<()> {
    let store = Store::from_environment().context("initializing SimpleClipboard storage")?;
    store
        .reconcile()
        .context("reconciling SimpleClipboard storage")?;

    let service = ClipboardService::new(store);
    let connection = Builder::session()?
        .name(BUS_NAME)?
        .serve_at(OBJECT_PATH, service)?
        .build()
        .await
        .context("registering the SimpleClipboard D-Bus service")?;

    connection.closed().await;
    Ok(())
}
