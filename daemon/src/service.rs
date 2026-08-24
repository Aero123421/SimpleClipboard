use std::path::Path;

use zbus::fdo;

use crate::store::{Item, StorageStats, Store, StoreError, StoreResult};

pub struct ClipboardService {
    store: Store,
}

impl ClipboardService {
    pub fn new(store: Store) -> Self {
        Self { store }
    }
}

#[zbus::interface(name = "io.github.sahur.SimpleClipboard1")]
impl ClipboardService {
    fn ping(&self) -> &str {
        "simpleclipboardd/0.1.0"
    }

    fn capture_text(&self, text: &str, source_app: &str) -> fdo::Result<String> {
        encode(self.store.capture_text(text, optional(source_app)))
    }

    fn capture_image(&self, spool_path: &str, mime: &str, source_app: &str) -> fdo::Result<String> {
        encode(
            self.store
                .capture_image(Path::new(spool_path), mime, optional(source_app)),
        )
    }

    fn list_items(&self, tab: &str, query: &str, limit: u32) -> fdo::Result<String> {
        encode(self.store.list_items(tab, query, limit))
    }

    fn get_item(&self, id: &str) -> fdo::Result<String> {
        encode(self.store.get_item(id))
    }

    fn add_note(&self, text: &str, pinned: bool) -> fdo::Result<String> {
        encode(self.store.add_note(text, pinned))
    }

    fn update_note(&self, id: &str, text: &str) -> fdo::Result<String> {
        encode(self.store.update_note(id, text))
    }

    fn toggle_pin(&self, id: &str) -> fdo::Result<String> {
        encode(self.store.toggle_pin(id))
    }

    fn record_used(&self, id: &str) -> fdo::Result<()> {
        map_store_error(self.store.record_used(id))
    }

    fn delete_item(&self, id: &str) -> fdo::Result<()> {
        map_store_error(self.store.delete_item(id))
    }

    fn clear_unpinned(&self) -> fdo::Result<u32> {
        map_store_error(self.store.clear_unpinned())
    }

    fn get_setting(&self, key: &str) -> fdo::Result<String> {
        map_store_error(self.store.setting(key))
    }

    fn set_setting(&self, key: &str, value: &str) -> fdo::Result<()> {
        map_store_error(self.store.set_setting(key, value))
    }

    fn get_stats(&self) -> fdo::Result<String> {
        encode(self.store.stats())
    }
}

fn optional(value: &str) -> Option<&str> {
    (!value.is_empty()).then_some(value)
}

fn encode<T: serde::Serialize>(result: StoreResult<T>) -> fdo::Result<String> {
    let value = map_store_error(result)?;
    serde_json::to_string(&value)
        .map_err(|_| fdo::Error::Failed("could not encode response".into()))
}

fn map_store_error<T>(result: StoreResult<T>) -> fdo::Result<T> {
    result.map_err(|error| match error {
        StoreError::InvalidInput(message) => fdo::Error::InvalidArgs(message),
        StoreError::LimitReached(message) => fdo::Error::LimitsExceeded(message),
        StoreError::NotFound => fdo::Error::UnknownObject("item not found".into()),
        internal => {
            eprintln!("simpleclipboardd: {internal}");
            fdo::Error::Failed("storage operation failed".into())
        }
    })
}

#[allow(dead_code)]
fn _assert_serializable(_: (&Item, &StorageStats)) {}
