use std::{
    collections::HashSet,
    fs::{self, File, OpenOptions, TryLockError},
    io::{BufReader, Read, Write},
    os::unix::fs::{MetadataExt, OpenOptionsExt, PermissionsExt},
    path::{Path, PathBuf},
    sync::{Arc, Mutex, MutexGuard},
    time::{SystemTime, UNIX_EPOCH},
};

use image::{ImageFormat, ImageReader, Limits as ImageLimits, imageops::FilterType};
use nix::unistd::geteuid;
use rusqlite::{
    Connection, OptionalExtension, Transaction, params, params_from_iter, types::Value,
};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use thiserror::Error;
use uuid::Uuid;

const DEFAULT_HISTORY_LIMIT: i64 = 500;
const DEFAULT_RETENTION_DAYS: i64 = 30;
const DEFAULT_IMAGE_LIMIT_BYTES: i64 = 256 * 1024 * 1024;
const DEFAULT_PER_IMAGE_LIMIT_BYTES: u64 = 16 * 1024 * 1024;
const MAX_TEXT_BYTES: usize = 1024 * 1024;
const HARD_HISTORY_LIMIT: i64 = 5_000;
const HARD_IMAGE_LIMIT_BYTES: i64 = 1024 * 1024 * 1024;
const HARD_PER_IMAGE_LIMIT_BYTES: u64 = 32 * 1024 * 1024;
const HARD_TEXT_STORAGE_BYTES: i64 = 128 * 1024 * 1024;
const MAX_IMAGE_EDGE: u32 = 16_384;
const MAX_IMAGE_PIXELS: u64 = 64_000_000;
const MAX_THUMB_SOURCE_PIXELS: u64 = 25_000_000;
const MAX_THUMB_DECODE_BYTES: u64 = 128 * 1024 * 1024;
const THUMB_MAX_WIDTH: u32 = 520;
const THUMB_MAX_HEIGHT: u32 = 300;
const MAX_QUERY_CHARS: usize = 256;
const MAX_QUERY_TOKENS: usize = 8;
const MAX_LIST_LIMIT: u32 = 200;
const MAX_PREVIEW_CHARS: usize = 512;
const INBOX_STALE_SECS: u64 = 600;

#[derive(Debug, Error)]
pub enum StoreError {
    #[error("invalid input: {0}")]
    InvalidInput(String),
    #[error("storage limit reached: {0}")]
    LimitReached(String),
    #[error("item not found")]
    NotFound,
    #[error("I/O error: {0}")]
    Io(#[from] std::io::Error),
    #[error("database error: {0}")]
    Database(#[from] rusqlite::Error),
    #[error("image error: {0}")]
    Image(#[from] image::ImageError),
}

pub type StoreResult<T> = Result<T, StoreError>;

#[derive(Clone, Debug)]
pub struct Store {
    root: PathBuf,
    #[cfg(test)]
    database_path: PathBuf,
    blob_dir: PathBuf,
    thumb_dir: PathBuf,
    inbox_dir: PathBuf,
    connection: Arc<Mutex<Connection>>,
    _lock_file: Arc<File>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Item {
    pub id: String,
    pub kind: String,
    pub mime: String,
    pub text: Option<String>,
    pub blob_path: Option<String>,
    pub thumb_path: Option<String>,
    pub source_app: Option<String>,
    pub created_at: i64,
    pub last_used_at: i64,
    pub pinned: bool,
    pub size_bytes: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
pub struct StorageStats {
    pub item_count: i64,
    pub pinned_count: i64,
    pub image_count: i64,
    pub text_bytes: i64,
    pub text_limit_bytes: i64,
    pub image_bytes: i64,
    pub image_limit_bytes: i64,
    pub history_limit: i64,
    pub retention_days: i64,
    pub capture_paused: bool,
}

#[derive(Debug, Clone, Copy)]
struct Limits {
    history_limit: i64,
    retention_days: i64,
    image_limit_bytes: i64,
    per_image_limit_bytes: u64,
}

impl Store {
    pub fn from_environment() -> StoreResult<Self> {
        let profile =
            std::env::var("SIMPLECLIPBOARD_PROFILE").unwrap_or_else(|_| "production".to_string());

        let root = if let Ok(path) = std::env::var("SIMPLECLIPBOARD_DATA_DIR") {
            PathBuf::from(path)
        } else {
            let data_home = std::env::var_os("XDG_DATA_HOME")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".local/share"))
                })
                .ok_or_else(|| {
                    StoreError::InvalidInput("HOME and XDG_DATA_HOME are unavailable".into())
                })?;
            let suffix = if profile == "dev" {
                "simpleclipboard-dev"
            } else {
                "simpleclipboard"
            };
            data_home.join(suffix)
        };

        let runtime_root = std::env::var_os("SIMPLECLIPBOARD_RUNTIME_DIR")
            .map(PathBuf::from)
            .or_else(|| std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from))
            .ok_or_else(|| StoreError::InvalidInput("XDG_RUNTIME_DIR is unavailable".into()))?;

        Self::new(root, runtime_root.join("simpleclipboard").join("inbox"))
    }

    pub fn new(root: PathBuf, inbox_dir: PathBuf) -> StoreResult<Self> {
        create_private_dir(&root)?;
        let lock_file = acquire_directory_lock(&root)?;
        let blob_dir = root.join("blobs");
        let thumb_dir = root.join("thumbs");
        create_private_dir(&blob_dir)?;
        create_private_dir(&thumb_dir)?;
        create_private_dir(&inbox_dir)?;

        let database_path = root.join("history.sqlite3");
        let connection = open_connection(&database_path)?;
        initialize_database(&connection, &database_path)?;

        Ok(Self {
            #[cfg(test)]
            database_path,
            root,
            blob_dir,
            thumb_dir,
            inbox_dir,
            connection: Arc::new(Mutex::new(connection)),
            _lock_file: Arc::new(lock_file),
        })
    }

    pub fn root(&self) -> &Path {
        &self.root
    }

    pub fn inbox_dir(&self) -> &Path {
        &self.inbox_dir
    }

    #[cfg(test)]
    fn connection(&self) -> StoreResult<Connection> {
        open_connection(&self.database_path)
    }

    fn lock_connection(&self) -> MutexGuard<'_, Connection> {
        self.connection
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    pub fn capture_text(&self, text: &str, source_app: Option<&str>) -> StoreResult<Item> {
        let bytes = text.as_bytes();
        if bytes.is_empty() || text.trim().is_empty() {
            return Err(StoreError::InvalidInput(
                "empty text is not recorded".into(),
            ));
        }
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(StoreError::LimitReached("text exceeds 1 MiB".into()));
        }

        let mut connection = self.lock_connection();
        if self.capture_paused_with(&connection)? {
            return Err(StoreError::LimitReached("capture is paused".into()));
        }
        if self.is_app_excluded_with(&connection, source_app)? {
            return Err(StoreError::InvalidInput(
                "source application is excluded".into(),
            ));
        }

        let hash = sha256_bytes(bytes);
        let now = unix_timestamp();
        let transaction = connection.transaction()?;
        let existing_id: Option<String> = transaction
            .query_row(
                "SELECT id FROM items WHERE kind = 'text' AND content_hash = ?1",
                [&hash],
                |row| row.get(0),
            )
            .optional()?;

        let id = if let Some(id) = existing_id {
            transaction.execute(
                "UPDATE items SET created_at = ?1, last_used_at = ?1, source_app = ?2 WHERE id = ?3",
                params![now, sanitize_source(source_app), id],
            )?;
            id
        } else {
            let id = Uuid::new_v4().to_string();
            transaction.execute(
                "INSERT INTO items(id, kind, mime, text, content_hash, source_app, created_at,
                                   last_used_at, pinned, size_bytes)
                 VALUES(?1, 'text', 'text/plain;charset=utf-8', ?2, ?3, ?4, ?5, ?5, 0, ?6)",
                params![
                    id,
                    text,
                    hash,
                    sanitize_source(source_app),
                    now,
                    bytes.len() as i64
                ],
            )?;
            id
        };

        let removed = self.enforce_limits(&transaction, now, Some(&id), true)?;
        transaction.commit()?;
        self.remove_blob_files(removed);
        let item = self.get_item_with(&connection, &id)?;
        drop(connection);
        Ok(item)
    }

    pub fn capture_image(
        &self,
        spool_path: &Path,
        mime: &str,
        source_app: Option<&str>,
    ) -> StoreResult<Item> {
        let mut connection = self.lock_connection();
        let canonical_inbox = self.inbox_dir.canonicalize()?;
        let canonical_spool = spool_path
            .canonicalize()
            .map_err(|_| StoreError::InvalidInput("spool file does not exist".into()))?;
        if !canonical_spool.starts_with(&canonical_inbox) {
            return Err(StoreError::InvalidInput(
                "spool path is outside the private inbox".into(),
            ));
        }

        let metadata = fs::symlink_metadata(&canonical_spool)?;
        if !metadata.file_type().is_file() || metadata.uid() != geteuid().as_raw() {
            return Err(StoreError::InvalidInput(
                "spool file is not a private regular file".into(),
            ));
        }

        if self.capture_paused_with(&connection)? {
            return Err(StoreError::LimitReached("capture is paused".into()));
        }
        if self.is_app_excluded_with(&connection, source_app)? {
            return Err(StoreError::InvalidInput(
                "source application is excluded".into(),
            ));
        }

        let limits = self.limits_with(&connection)?;
        let max_bytes = limits.per_image_limit_bytes.min(HARD_PER_IMAGE_LIMIT_BYTES);
        let expected_format = match mime {
            "image/png" => ImageFormat::Png,
            "image/jpeg" => ImageFormat::Jpeg,
            _ => {
                return Err(StoreError::InvalidInput(
                    "only PNG and JPEG images are supported".into(),
                ));
            }
        };

        let (staged, size, hash) =
            stage_spool_private(&canonical_spool, &self.blob_dir, max_bytes)?;
        let reader = ImageReader::open(staged.path())?.with_guessed_format()?;
        if reader.format() != Some(expected_format) {
            return Err(StoreError::InvalidInput(
                "MIME type does not match image data".into(),
            ));
        }
        let (width, height) = reader.into_dimensions()?;
        if width == 0
            || height == 0
            || width > MAX_IMAGE_EDGE
            || height > MAX_IMAGE_EDGE
            || u64::from(width) * u64::from(height) > MAX_IMAGE_PIXELS
        {
            return Err(StoreError::LimitReached(
                "image dimensions are unsafe".into(),
            ));
        }

        let extension = if expected_format == ImageFormat::Png {
            "png"
        } else {
            "jpg"
        };
        let relative_path = format!("blobs/{hash}.{extension}");
        let final_path = self.root.join(&relative_path);

        let existing: Option<(String, Option<String>)> = connection
            .query_row(
                "SELECT id, blob_path FROM items WHERE kind = 'image' AND content_hash = ?1",
                [&hash],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .optional()?;

        if let Some((existing_id, existing_relative)) = existing {
            let blob_exists = existing_relative
                .as_deref()
                .and_then(|relative| self.managed_blob_path(relative))
                .is_some_and(|path| path.is_file());
            let now = unix_timestamp();
            if blob_exists {
                let transaction = connection.transaction()?;
                transaction.execute(
                    "UPDATE items SET created_at = ?1, last_used_at = ?1, source_app = ?2 WHERE id = ?3",
                    params![now, sanitize_source(source_app), existing_id],
                )?;
                let removed = self.enforce_limits(&transaction, now, Some(&existing_id), false)?;
                transaction.commit()?;
                self.remove_blob_files(removed);
                let item = self.get_item_with(&connection, &existing_id)?;
                drop(connection);
                let _ = fs::remove_file(&canonical_spool);
                return Ok(item);
            }

            let committed_new_blob = staged.persist(&final_path)?;
            let _ = fs::remove_file(&canonical_spool);
            let transaction = connection.transaction()?;
            let update_result = transaction.execute(
                "UPDATE items
                 SET mime = ?1, blob_path = ?2, source_app = ?3, created_at = ?4,
                     last_used_at = ?4, size_bytes = ?5, width = ?6, height = ?7
                 WHERE id = ?8",
                params![
                    mime,
                    relative_path,
                    sanitize_source(source_app),
                    now,
                    size as i64,
                    i64::from(width),
                    i64::from(height),
                    existing_id
                ],
            );
            if let Err(error) = update_result {
                if committed_new_blob {
                    let _ = fs::remove_file(&final_path);
                }
                return Err(error.into());
            }
            let removed = match self.enforce_limits(&transaction, now, Some(&existing_id), true) {
                Ok(removed) => removed,
                Err(error) => {
                    drop(transaction);
                    if committed_new_blob {
                        let _ = fs::remove_file(&final_path);
                    }
                    return Err(error);
                }
            };
            if let Err(error) = transaction.commit() {
                if committed_new_blob {
                    let _ = fs::remove_file(&final_path);
                }
                return Err(error.into());
            }
            self.remove_blob_files(removed);
            let mut item = self.get_item_with(&connection, &existing_id)?;
            drop(connection);
            if let Some(thumb) = self.ensure_thumbnail(&final_path, &hash, width, height) {
                item.thumb_path = Some(thumb.to_string_lossy().into_owned());
            }
            return Ok(item);
        }

        let committed_new_blob = staged.persist(&final_path)?;
        let _ = fs::remove_file(&canonical_spool);

        let id = Uuid::new_v4().to_string();
        let now = unix_timestamp();
        let transaction = connection.transaction()?;
        let insert_result = transaction.execute(
            "INSERT INTO items(id, kind, mime, blob_path, content_hash, source_app, created_at,
                               last_used_at, pinned, size_bytes, width, height)
             VALUES(?1, 'image', ?2, ?3, ?4, ?5, ?6, ?6, 0, ?7, ?8, ?9)",
            params![
                id,
                mime,
                relative_path,
                hash,
                sanitize_source(source_app),
                now,
                size as i64,
                i64::from(width),
                i64::from(height)
            ],
        );
        if let Err(error) = insert_result {
            if committed_new_blob {
                let _ = fs::remove_file(&final_path);
            }
            return Err(error.into());
        }
        let removed = match self.enforce_limits(&transaction, now, Some(&id), true) {
            Ok(removed) => removed,
            Err(error) => {
                drop(transaction);
                if committed_new_blob {
                    let _ = fs::remove_file(&final_path);
                }
                return Err(error);
            }
        };
        if let Err(error) = transaction.commit() {
            if committed_new_blob {
                let _ = fs::remove_file(&final_path);
            }
            return Err(error.into());
        }
        self.remove_blob_files(removed);
        let mut item = self.get_item_with(&connection, &id)?;
        drop(connection);
        if let Some(thumb) = self.ensure_thumbnail(&final_path, &hash, width, height) {
            item.thumb_path = Some(thumb.to_string_lossy().into_owned());
        }
        Ok(item)
    }

    pub fn add_note(&self, text: &str, pinned: bool) -> StoreResult<Item> {
        if text.trim().is_empty() {
            return Err(StoreError::InvalidInput("empty note is not saved".into()));
        }
        if text.len() > MAX_TEXT_BYTES {
            return Err(StoreError::LimitReached("note exceeds 1 MiB".into()));
        }
        let mut connection = self.lock_connection();
        let id = Uuid::new_v4().to_string();
        let now = unix_timestamp();
        let hash = format!("note:{}", Uuid::new_v4());
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                               pinned, size_bytes)
             VALUES(?1, 'note', 'text/plain;charset=utf-8', ?2, ?3, ?4, ?4, ?5, ?6)",
            params![id, text, hash, now, pinned, text.len() as i64],
        )?;
        let removed = self.enforce_limits(&transaction, now, Some(&id), true)?;
        transaction.commit()?;
        self.remove_blob_files(removed);
        let item = self.get_item_with(&connection, &id)?;
        drop(connection);
        Ok(item)
    }

    pub fn update_note(&self, id: &str, text: &str) -> StoreResult<Item> {
        validate_id(id)?;
        if text.trim().is_empty() || text.len() > MAX_TEXT_BYTES {
            return Err(StoreError::InvalidInput(
                "note must contain 1 byte to 1 MiB".into(),
            ));
        }
        let mut connection = self.lock_connection();
        let now = unix_timestamp();
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE items SET text = ?1, size_bytes = ?2, last_used_at = ?3
             WHERE id = ?4 AND kind = 'note'",
            params![text, text.len() as i64, now, id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        let removed = self.enforce_limits(&transaction, now, Some(id), true)?;
        transaction.commit()?;
        self.remove_blob_files(removed);
        let item = self.get_item_with(&connection, id)?;
        drop(connection);
        Ok(item)
    }

    pub fn list_items(
        &self,
        tab: &str,
        query: &str,
        requested_limit: u32,
    ) -> StoreResult<Vec<Item>> {
        self.list_items_page(tab, query, requested_limit, 0)
    }

    pub fn list_items_page(
        &self,
        tab: &str,
        query: &str,
        requested_limit: u32,
        requested_offset: u32,
    ) -> StoreResult<Vec<Item>> {
        let limit = i64::from(requested_limit.clamp(1, MAX_LIST_LIMIT));
        let offset = i64::from(requested_offset).min(HARD_HISTORY_LIMIT);
        let query: String = query.trim().chars().take(MAX_QUERY_CHARS).collect();
        let tokens: Vec<String> = query
            .split_whitespace()
            .take(MAX_QUERY_TOKENS)
            .map(ToOwned::to_owned)
            .collect();

        let connection = self.lock_connection();
        let limits = self.limits_with(&connection)?;
        let expiry = unix_timestamp().saturating_sub(limits.retention_days.saturating_mul(86_400));

        let mut sql = String::from(
            "SELECT id, kind, mime, substr(text, 1, 513), blob_path, source_app, created_at,
                    last_used_at, pinned, size_bytes, width, height
             FROM items
             WHERE (pinned = 1 OR kind = 'note' OR created_at >= ?)",
        );
        let mut values: Vec<Value> = vec![Value::Integer(expiry)];
        match tab {
            "history" => {}
            "images" => {
                sql.push_str(" AND kind = ?");
                values.push(Value::Text("image".into()));
            }
            "notes" => {
                sql.push_str(" AND kind = ?");
                values.push(Value::Text("note".into()));
            }
            "pinned" => {
                sql.push_str(" AND pinned = 1");
            }
            _ => return Err(StoreError::InvalidInput("unknown tab".into())),
        }

        for token in tokens {
            sql.push_str(
                " AND (instr(lower(COALESCE(text, '')), lower(?)) > 0
                       OR instr(lower(COALESCE(source_app, '')), lower(?)) > 0)",
            );
            values.push(Value::Text(token.clone()));
            values.push(Value::Text(token));
        }

        sql.push_str(" ORDER BY created_at DESC, rowid DESC LIMIT ? OFFSET ?");
        values.push(Value::Integer(limit));
        values.push(Value::Integer(offset));

        let mut statement = connection.prepare(&sql)?;
        let mut items = statement
            .query_map(params_from_iter(values), item_from_row)?
            .collect::<Result<Vec<_>, _>>()?;
        drop(statement);
        drop(connection);

        for item in &mut items {
            if let Some(text) = &mut item.text {
                truncate_chars(text, MAX_PREVIEW_CHARS);
            }
        }
        self.expand_blob_paths(&mut items);
        Ok(items)
    }

    pub fn get_item(&self, id: &str) -> StoreResult<Item> {
        validate_id(id)?;
        let connection = self.lock_connection();
        self.get_item_with(&connection, id)
    }

    fn get_item_with(&self, connection: &Connection, id: &str) -> StoreResult<Item> {
        connection
            .query_row(
                "SELECT id, kind, mime, text, blob_path, source_app, created_at, last_used_at,
                        pinned, size_bytes, width, height FROM items WHERE id = ?1",
                [id],
                item_from_row,
            )
            .optional()?
            .ok_or(StoreError::NotFound)
            .map(|mut item| {
                self.expand_blob_paths(std::slice::from_mut(&mut item));
                item
            })
    }

    pub fn toggle_pin(&self, id: &str) -> StoreResult<Item> {
        validate_id(id)?;
        let mut connection = self.lock_connection();
        let transaction = connection.transaction()?;
        let changed = transaction.execute(
            "UPDATE items SET pinned = CASE pinned WHEN 0 THEN 1 ELSE 0 END WHERE id = ?1",
            [id],
        )?;
        if changed == 0 {
            return Err(StoreError::NotFound);
        }
        let mut item = transaction.query_row(
            "SELECT id, kind, mime, text, blob_path, source_app, created_at, last_used_at,
                    pinned, size_bytes, width, height FROM items WHERE id = ?1",
            [id],
            item_from_row,
        )?;
        let removed = if item.pinned {
            Vec::new()
        } else {
            self.enforce_limits(&transaction, unix_timestamp(), None, false)?
        };
        transaction.commit()?;
        self.remove_blob_files(removed);
        drop(connection);
        self.expand_blob_paths(std::slice::from_mut(&mut item));
        Ok(item)
    }

    pub fn record_used(&self, id: &str) -> StoreResult<()> {
        validate_id(id)?;
        let connection = self.lock_connection();
        if connection.execute(
            "UPDATE items SET last_used_at = ?1 WHERE id = ?2",
            params![unix_timestamp(), id],
        )? == 0
        {
            return Err(StoreError::NotFound);
        }
        Ok(())
    }

    pub fn delete_item(&self, id: &str) -> StoreResult<()> {
        validate_id(id)?;
        let mut connection = self.lock_connection();
        let transaction = connection.transaction()?;
        let blob: Option<String> = transaction
            .query_row("SELECT blob_path FROM items WHERE id = ?1", [id], |row| {
                row.get(0)
            })
            .optional()?
            .flatten();
        if transaction.execute("DELETE FROM items WHERE id = ?1", [id])? == 0 {
            return Err(StoreError::NotFound);
        }
        transaction.commit()?;
        self.remove_blob_files(blob.into_iter().collect());
        drop(connection);
        Ok(())
    }

    pub fn clear_unpinned(&self) -> StoreResult<u32> {
        let mut connection = self.lock_connection();
        let transaction = connection.transaction()?;
        let paths = collect_blob_paths(
            &transaction,
            "SELECT blob_path FROM items WHERE pinned = 0 AND kind != 'note' AND blob_path IS NOT NULL",
        )?;
        let count =
            transaction.execute("DELETE FROM items WHERE pinned = 0 AND kind != 'note'", [])?;
        transaction.commit()?;
        self.remove_blob_files(paths);
        drop(connection);
        Ok(count as u32)
    }

    pub fn setting(&self, key: &str) -> StoreResult<String> {
        validate_setting_key(key)?;
        let connection = self.lock_connection();
        connection
            .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                row.get(0)
            })
            .optional()?
            .ok_or(StoreError::NotFound)
    }

    pub fn set_setting(&self, key: &str, value: &str) -> StoreResult<()> {
        let normalized = normalize_setting(key, value)?;
        let mut connection = self.lock_connection();
        let transaction = connection.transaction()?;
        transaction.execute(
            "INSERT INTO settings(key, value) VALUES(?1, ?2)
             ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, normalized],
        )?;
        let removed = self.enforce_limits(&transaction, unix_timestamp(), None, false)?;
        transaction.commit()?;
        self.remove_blob_files(removed);
        drop(connection);
        Ok(())
    }

    pub fn stats(&self) -> StoreResult<StorageStats> {
        let connection = self.lock_connection();
        let limits = self.limits_with(&connection)?;
        let (item_count, pinned_count, image_count, text_bytes, image_bytes) = connection
            .query_row(
                "SELECT COUNT(*), COALESCE(SUM(pinned), 0),
                    COALESCE(SUM(CASE WHEN kind = 'image' THEN 1 ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind != 'image' THEN size_bytes ELSE 0 END), 0),
                    COALESCE(SUM(CASE WHEN kind = 'image' THEN size_bytes ELSE 0 END), 0)
             FROM items",
                [],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )?;
        Ok(StorageStats {
            item_count,
            pinned_count,
            image_count,
            text_bytes,
            text_limit_bytes: HARD_TEXT_STORAGE_BYTES,
            image_bytes,
            image_limit_bytes: limits.image_limit_bytes,
            history_limit: limits.history_limit,
            retention_days: limits.retention_days,
            capture_paused: self.capture_paused_with(&connection)?,
        })
    }

    pub fn reconcile(&self) -> StoreResult<()> {
        let mut connection = self.lock_connection();
        let transaction = connection.transaction()?;
        let missing = collect_blob_paths(
            &transaction,
            "SELECT blob_path FROM items WHERE kind = 'image' AND blob_path IS NOT NULL",
        )?
        .into_iter()
        .filter(|relative| {
            self.managed_blob_path(relative)
                .is_none_or(|path| !path.is_file())
        })
        .collect::<Vec<_>>();
        for relative in missing {
            transaction.execute("DELETE FROM items WHERE blob_path = ?1", [relative])?;
        }
        let removed = self.enforce_limits(&transaction, unix_timestamp(), None, false)?;
        transaction.commit()?;

        let mut statement = connection
            .prepare("SELECT blob_path, width, height FROM items WHERE blob_path IS NOT NULL")?;
        let known_rows: Vec<(String, Option<i64>, Option<i64>)> = statement
            .query_map([], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        drop(statement);

        self.remove_blob_files(removed);

        let known: HashSet<String> = known_rows.iter().map(|(path, _, _)| path.clone()).collect();
        let mut known_thumbs: HashSet<String> = HashSet::new();
        for (relative, _, _) in &known_rows {
            if let Some(hash) = blob_hash_from_relative(relative) {
                known_thumbs.insert(format!("{hash}.png"));
            }
        }

        for entry in fs::read_dir(&self.blob_dir)? {
            let entry = entry?;
            let relative = format!("blobs/{}", entry.file_name().to_string_lossy());
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.file_type()?.is_file()
                && (name.starts_with(".tmp-")
                    || (is_managed_blob_name(&name) && !known.contains(&relative)))
            {
                let _ = fs::remove_file(entry.path());
            }
        }

        for entry in fs::read_dir(&self.thumb_dir)? {
            let entry = entry?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if entry.file_type()?.is_file()
                && (name.starts_with(".tmp-")
                    || (is_managed_thumb_name(&name) && !known_thumbs.contains(name.as_ref())))
            {
                let _ = fs::remove_file(entry.path());
            }
        }

        let _ = connection.execute_batch("PRAGMA wal_checkpoint(PASSIVE);");
        drop(connection);

        for (relative, width, height) in &known_rows {
            if let (Some(hash), Some(blob_path), Some(w), Some(h)) = (
                blob_hash_from_relative(relative),
                self.managed_blob_path(relative),
                width.and_then(|v| u32::try_from(v).ok()),
                height.and_then(|v| u32::try_from(v).ok()),
            ) {
                let _ = self.ensure_thumbnail(&blob_path, hash, w, h);
            }
        }

        self.reconcile_inbox_older_than(INBOX_STALE_SECS)?;
        Ok(())
    }

    fn reconcile_inbox_older_than(&self, min_age_secs: u64) -> StoreResult<()> {
        let current_uid = geteuid().as_raw();
        let now = SystemTime::now();
        for entry in fs::read_dir(&self.inbox_dir)? {
            let entry = entry?;
            let path = entry.path();
            let Ok(metadata) = fs::symlink_metadata(&path) else {
                continue;
            };
            if !metadata.file_type().is_file() || metadata.uid() != current_uid {
                continue;
            }
            let age = metadata
                .modified()
                .ok()
                .and_then(|modified| now.duration_since(modified).ok())
                .map(|duration| duration.as_secs())
                .unwrap_or(0);
            if age >= min_age_secs {
                let _ = fs::remove_file(path);
            }
        }
        Ok(())
    }

    fn limits_with(&self, connection: &Connection) -> StoreResult<Limits> {
        let read_i64 = |key: &str, default: i64| -> StoreResult<i64> {
            Ok(connection
                .query_row("SELECT value FROM settings WHERE key = ?1", [key], |row| {
                    row.get::<_, String>(0)
                })
                .optional()?
                .and_then(|value| value.parse::<i64>().ok())
                .unwrap_or(default))
        };
        let history_limit =
            read_i64("history_limit", DEFAULT_HISTORY_LIMIT)?.clamp(50, HARD_HISTORY_LIMIT);
        let retention_days = read_i64("retention_days", DEFAULT_RETENTION_DAYS)?.clamp(1, 3650);
        let image_limit_bytes =
            read_i64("image_limit_mb", DEFAULT_IMAGE_LIMIT_BYTES / 1024 / 1024)?
                .saturating_mul(1024 * 1024)
                .clamp(32 * 1024 * 1024, HARD_IMAGE_LIMIT_BYTES);
        let per_image_limit_bytes = read_i64(
            "per_image_limit_mb",
            (DEFAULT_PER_IMAGE_LIMIT_BYTES / 1024 / 1024) as i64,
        )?
        .saturating_mul(1024 * 1024)
        .clamp(1024 * 1024, HARD_PER_IMAGE_LIMIT_BYTES as i64)
            as u64;
        Ok(Limits {
            history_limit,
            retention_days,
            image_limit_bytes,
            per_image_limit_bytes,
        })
    }

    fn capture_paused_with(&self, connection: &Connection) -> StoreResult<bool> {
        Ok(connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'capture_paused'",
                [],
                |row| row.get::<_, String>(0),
            )
            .optional()?
            .is_some_and(|value| value == "true"))
    }

    fn is_app_excluded_with(
        &self,
        connection: &Connection,
        source_app: Option<&str>,
    ) -> StoreResult<bool> {
        let Some(source_app) = source_app.filter(|app| !app.is_empty()) else {
            return Ok(false);
        };
        let value: String = connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'excluded_apps'",
                [],
                |row| row.get(0),
            )
            .optional()?
            .unwrap_or_else(|| "[]".into());
        let apps: Vec<String> = serde_json::from_str(&value).unwrap_or_default();
        Ok(apps.iter().any(|app| app.eq_ignore_ascii_case(source_app)))
    }

    fn enforce_limits(
        &self,
        transaction: &Transaction<'_>,
        now: i64,
        protected_id: Option<&str>,
        reject_if_still_over_hard_limit: bool,
    ) -> StoreResult<Vec<String>> {
        let limits = self.limits_with(transaction)?;
        let expiry = now.saturating_sub(limits.retention_days.saturating_mul(86_400));
        let mut removed = collect_blob_paths_with_params(
            transaction,
            "SELECT blob_path FROM items
             WHERE pinned = 0 AND kind != 'note' AND created_at < ?1 AND blob_path IS NOT NULL",
            [expiry],
        )?;
        transaction.execute(
            "DELETE FROM items WHERE pinned = 0 AND kind != 'note' AND created_at < ?1",
            [expiry],
        )?;

        let history_count: i64 = transaction.query_row(
            "SELECT COUNT(*) FROM items WHERE pinned = 0 AND kind != 'note'",
            [],
            |row| row.get(0),
        )?;
        let overflow = history_count.saturating_sub(limits.history_limit.min(HARD_HISTORY_LIMIT));
        if overflow > 0 {
            let protected_id = protected_id.unwrap_or("");
            let sql = "SELECT blob_path FROM items WHERE id IN (
                         SELECT id FROM items
                         WHERE pinned = 0 AND kind != 'note' AND (?2 = '' OR id != ?2)
                         ORDER BY created_at ASC, rowid ASC LIMIT ?1
                       ) AND blob_path IS NOT NULL";
            let mut statement = transaction.prepare(sql)?;
            let paths = statement.query_map(params![overflow, protected_id], |row| {
                row.get::<_, String>(0)
            })?;
            removed.extend(paths.collect::<Result<Vec<_>, _>>()?);
            transaction.execute(
                "DELETE FROM items WHERE id IN (
                    SELECT id FROM items
                    WHERE pinned = 0 AND kind != 'note' AND (?2 = '' OR id != ?2)
                    ORDER BY created_at ASC, rowid ASC LIMIT ?1
                 )",
                params![overflow, protected_id],
            )?;
        }

        let protected_id = protected_id.unwrap_or("");
        let mut text_bytes: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM items WHERE kind != 'image'",
            [],
            |row| row.get(0),
        )?;
        while text_bytes > HARD_TEXT_STORAGE_BYTES {
            let oldest: Option<(String, i64)> = transaction
                .query_row(
                    "SELECT id, size_bytes FROM items
                     WHERE kind = 'text' AND pinned = 0 AND (?1 = '' OR id != ?1)
                     ORDER BY created_at ASC, rowid ASC LIMIT 1",
                    [protected_id],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let Some((id, size)) = oldest else {
                break;
            };
            transaction.execute("DELETE FROM items WHERE id = ?1", [id])?;
            text_bytes = text_bytes.saturating_sub(size);
        }

        let image_limit = limits.image_limit_bytes.min(HARD_IMAGE_LIMIT_BYTES);
        let mut image_bytes: i64 = transaction.query_row(
            "SELECT COALESCE(SUM(size_bytes), 0) FROM items WHERE kind = 'image'",
            [],
            |row| row.get(0),
        )?;
        while image_bytes > image_limit {
            let oldest: Option<(String, Option<String>, i64)> = transaction
                .query_row(
                    "SELECT id, blob_path, size_bytes FROM items
                     WHERE kind = 'image' AND pinned = 0 AND (?1 = '' OR id != ?1)
                     ORDER BY created_at ASC, rowid ASC LIMIT 1",
                    [protected_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((id, path, size)) = oldest else {
                break;
            };
            transaction.execute("DELETE FROM items WHERE id = ?1", [id])?;
            if let Some(path) = path {
                removed.push(path);
            }
            image_bytes = image_bytes.saturating_sub(size);
        }

        let protected_is_image = if protected_id.is_empty() {
            false
        } else {
            transaction.query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE id = ?1 AND kind = 'image')",
                [protected_id],
                |row| row.get(0),
            )?
        };

        let mut hard_count: i64 =
            transaction.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
        let hard_overflow = hard_count.saturating_sub(HARD_HISTORY_LIMIT);
        if hard_overflow > 0 {
            let sql = "SELECT blob_path FROM items WHERE id IN (
                         SELECT id FROM items
                         WHERE pinned = 0 AND kind != 'note' AND (?2 = '' OR id != ?2)
                         ORDER BY created_at ASC, rowid ASC LIMIT ?1
                       ) AND blob_path IS NOT NULL";
            let mut statement = transaction.prepare(sql)?;
            let paths = statement.query_map(params![hard_overflow, protected_id], |row| {
                row.get::<_, String>(0)
            })?;
            removed.extend(paths.collect::<Result<Vec<_>, _>>()?);
            transaction.execute(
                "DELETE FROM items WHERE id IN (
                    SELECT id FROM items
                    WHERE pinned = 0 AND kind != 'note' AND (?2 = '' OR id != ?2)
                    ORDER BY created_at ASC, rowid ASC LIMIT ?1
                 )",
                params![hard_overflow, protected_id],
            )?;
            hard_count =
                transaction.query_row("SELECT COUNT(*) FROM items", [], |row| row.get(0))?;
        }
        if reject_if_still_over_hard_limit && hard_count > HARD_HISTORY_LIMIT {
            return Err(StoreError::LimitReached(
                "pinned items and notes reached the absolute 5,000 item limit".into(),
            ));
        }
        if reject_if_still_over_hard_limit && text_bytes > HARD_TEXT_STORAGE_BYTES {
            return Err(StoreError::LimitReached(
                "pinned text and notes reached the absolute 128 MiB limit".into(),
            ));
        }
        if reject_if_still_over_hard_limit && protected_is_image && image_bytes > image_limit {
            return Err(StoreError::LimitReached(
                "pinned images occupy the configured storage limit".into(),
            ));
        }
        Ok(removed)
    }

    fn remove_blob_files(&self, relative_paths: Vec<String>) {
        for relative in relative_paths {
            if let Some(path) = self.managed_blob_path(&relative) {
                let _ = fs::remove_file(path);
            }
            if let Some(thumb) = self.managed_thumb_path(&relative) {
                let _ = fs::remove_file(thumb);
            }
        }
    }

    fn expand_blob_paths(&self, items: &mut [Item]) {
        for item in items {
            if let Some(relative) = &item.blob_path {
                item.thumb_path = self
                    .managed_thumb_path(relative)
                    .filter(|path| path.is_file())
                    .map(|path| path.to_string_lossy().into_owned());
                item.blob_path = self
                    .managed_blob_path(relative)
                    .map(|path| path.to_string_lossy().into_owned());
            } else {
                item.thumb_path = None;
            }
        }
    }

    fn managed_blob_path(&self, relative: &str) -> Option<PathBuf> {
        let mut components = Path::new(relative).components();
        let directory = components.next()?.as_os_str().to_str()?;
        let name = components.next()?.as_os_str().to_str()?;
        if directory != "blobs" || components.next().is_some() || !is_managed_blob_name(name) {
            return None;
        }
        Some(self.blob_dir.join(name))
    }

    fn managed_thumb_path(&self, relative: &str) -> Option<PathBuf> {
        let hash = blob_hash_from_relative(relative)?;
        Some(self.thumb_dir.join(format!("{hash}.png")))
    }

    fn ensure_thumbnail(
        &self,
        source_blob: &Path,
        hash: &str,
        width: u32,
        height: u32,
    ) -> Option<PathBuf> {
        if (width <= THUMB_MAX_WIDTH && height <= THUMB_MAX_HEIGHT)
            || u64::from(width).saturating_mul(u64::from(height)) > MAX_THUMB_SOURCE_PIXELS
        {
            return None;
        }
        let destination = self.thumb_dir.join(format!("{hash}.png"));
        if destination.is_file() {
            return Some(destination);
        }
        let mut reader = ImageReader::open(source_blob)
            .ok()?
            .with_guessed_format()
            .ok()?;
        let mut limits = ImageLimits::default();
        limits.max_image_width = Some(MAX_IMAGE_EDGE);
        limits.max_image_height = Some(MAX_IMAGE_EDGE);
        limits.max_alloc = Some(MAX_THUMB_DECODE_BYTES);
        reader.limits(limits);
        let decoded = reader.decode().ok()?;
        let thumbnail = decoded.resize(THUMB_MAX_WIDTH, THUMB_MAX_HEIGHT, FilterType::Triangle);

        let temporary = self.thumb_dir.join(format!(".tmp-{}", Uuid::new_v4()));
        let mut file = OpenOptions::new()
            .create_new(true)
            .write(true)
            .mode(0o600)
            .open(&temporary)
            .ok()?;
        if thumbnail.write_to(&mut file, ImageFormat::Png).is_err()
            || file.flush().is_err()
            || file.sync_all().is_err()
        {
            let _ = fs::remove_file(&temporary);
            return None;
        }
        drop(file);
        let connection = self.lock_connection();
        let still_referenced: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM items WHERE kind = 'image' AND content_hash = ?1)",
                [hash],
                |row| row.get(0),
            )
            .unwrap_or(false);
        if !still_referenced {
            let _ = fs::remove_file(&temporary);
            return None;
        }
        if destination.exists() {
            let _ = fs::remove_file(&temporary);
        } else if fs::rename(&temporary, &destination).is_err() {
            let _ = fs::remove_file(&temporary);
            return None;
        }
        drop(connection);
        Some(destination)
    }
}

fn open_connection(database_path: &Path) -> StoreResult<Connection> {
    let connection = Connection::open(database_path)?;
    connection.busy_timeout(std::time::Duration::from_secs(3))?;
    connection.execute_batch(
        "PRAGMA foreign_keys = ON;
         PRAGMA synchronous = NORMAL;",
    )?;
    Ok(connection)
}

fn initialize_database(connection: &Connection, database_path: &Path) -> StoreResult<()> {
    connection.execute_batch(
        "PRAGMA journal_mode = WAL;
         CREATE TABLE IF NOT EXISTS items (
            id TEXT PRIMARY KEY,
            kind TEXT NOT NULL CHECK(kind IN ('text', 'image', 'note')),
            mime TEXT NOT NULL,
            text TEXT,
            blob_path TEXT,
            content_hash TEXT NOT NULL,
            source_app TEXT,
            created_at INTEGER NOT NULL,
            last_used_at INTEGER NOT NULL,
            pinned INTEGER NOT NULL DEFAULT 0 CHECK(pinned IN (0, 1)),
            size_bytes INTEGER NOT NULL DEFAULT 0 CHECK(size_bytes >= 0),
            width INTEGER,
            height INTEGER
         );
         CREATE UNIQUE INDEX IF NOT EXISTS items_history_hash
            ON items(kind, content_hash) WHERE kind IN ('text', 'image');
         CREATE INDEX IF NOT EXISTS items_created ON items(created_at DESC);
         CREATE INDEX IF NOT EXISTS items_kind_created ON items(kind, created_at DESC);
         CREATE INDEX IF NOT EXISTS items_pinned_created ON items(pinned, created_at DESC);
         CREATE TABLE IF NOT EXISTS settings (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
         );
         INSERT OR IGNORE INTO settings(key, value) VALUES
            ('history_limit', '500'),
            ('retention_days', '30'),
            ('image_limit_mb', '256'),
            ('per_image_limit_mb', '16'),
            ('capture_paused', 'false'),
            ('excluded_apps', '[]');
         PRAGMA user_version = 1;",
    )?;
    fs::set_permissions(database_path, fs::Permissions::from_mode(0o600))?;
    Ok(())
}

fn create_private_dir(path: &Path) -> StoreResult<()> {
    fs::create_dir_all(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    Ok(())
}

fn acquire_directory_lock(root: &Path) -> StoreResult<File> {
    let lock_path = root.join(".lock");
    let file = OpenOptions::new()
        .create(true)
        .write(true)
        .truncate(false)
        .mode(0o600)
        .open(&lock_path)?;
    file.set_permissions(fs::Permissions::from_mode(0o600))?;
    match file.try_lock() {
        Ok(()) => Ok(file),
        Err(TryLockError::WouldBlock) => Err(StoreError::LimitReached(
            "another SimpleClipboard daemon is already using this data directory".into(),
        )),
        Err(TryLockError::Error(error)) => Err(StoreError::Io(error)),
    }
}

struct TempBlobGuard {
    path: PathBuf,
    armed: bool,
}

impl TempBlobGuard {
    fn path(&self) -> &Path {
        &self.path
    }

    fn persist(mut self, destination: &Path) -> StoreResult<bool> {
        if destination.exists() {
            let _ = fs::remove_file(&self.path);
            self.armed = false;
            return Ok(false);
        }
        fs::rename(&self.path, destination)?;
        self.armed = false;
        Ok(true)
    }
}

impl Drop for TempBlobGuard {
    fn drop(&mut self) {
        if self.armed {
            let _ = fs::remove_file(&self.path);
        }
    }
}

fn stage_spool_private(
    source: &Path,
    blob_dir: &Path,
    max_bytes: u64,
) -> StoreResult<(TempBlobGuard, u64, String)> {
    let temporary = blob_dir.join(format!(".tmp-{}", Uuid::new_v4()));
    let guard = TempBlobGuard {
        path: temporary.clone(),
        armed: true,
    };
    let input_file = File::open(source)?;
    let input_meta = input_file.metadata()?;
    if !input_meta.file_type().is_file() || input_meta.uid() != geteuid().as_raw() {
        return Err(StoreError::InvalidInput(
            "spool file is not a private regular file".into(),
        ));
    }
    let mut input = BufReader::new(input_file);
    let mut output = OpenOptions::new()
        .create_new(true)
        .write(true)
        .mode(0o600)
        .open(&temporary)?;
    let mut hasher = Sha256::new();
    let mut buffer = [0_u8; 64 * 1024];
    let mut total: u64 = 0;

    loop {
        let read = input.read(&mut buffer)?;
        if read == 0 {
            break;
        }
        total = total.saturating_add(read as u64);
        if total > max_bytes {
            return Err(StoreError::LimitReached(format!(
                "image size must be between 1 byte and {} MiB",
                max_bytes / 1024 / 1024
            )));
        }
        hasher.update(&buffer[..read]);
        output.write_all(&buffer[..read])?;
    }

    if total == 0 {
        return Err(StoreError::LimitReached(format!(
            "image size must be between 1 byte and {} MiB",
            max_bytes / 1024 / 1024
        )));
    }
    output.flush()?;
    output.sync_all()?;
    Ok((guard, total, format!("{:x}", hasher.finalize())))
}

fn sha256_bytes(bytes: &[u8]) -> String {
    format!("{:x}", Sha256::digest(bytes))
}

fn unix_timestamp() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
        .min(i64::MAX as u64) as i64
}

fn sanitize_source(source: Option<&str>) -> Option<String> {
    source
        .map(|value| value.chars().take(255).collect::<String>())
        .filter(|value| !value.is_empty())
}

fn truncate_chars(value: &mut String, maximum: usize) {
    if let Some((index, _)) = value.char_indices().nth(maximum) {
        value.truncate(index);
    }
}

fn validate_id(id: &str) -> StoreResult<()> {
    Uuid::parse_str(id)
        .map(|_| ())
        .map_err(|_| StoreError::InvalidInput("invalid item id".into()))
}

fn validate_setting_key(key: &str) -> StoreResult<()> {
    match key {
        "history_limit" | "retention_days" | "image_limit_mb" | "per_image_limit_mb"
        | "capture_paused" | "excluded_apps" => Ok(()),
        _ => Err(StoreError::InvalidInput("unknown setting".into())),
    }
}

fn normalize_setting(key: &str, value: &str) -> StoreResult<String> {
    validate_setting_key(key)?;
    match key {
        "history_limit" => parse_bounded(value, 50, HARD_HISTORY_LIMIT),
        "retention_days" => parse_bounded(value, 1, 3650),
        "image_limit_mb" => parse_bounded(value, 32, 1024),
        "per_image_limit_mb" => parse_bounded(value, 1, 32),
        "capture_paused" if matches!(value, "true" | "false") => Ok(value.into()),
        "capture_paused" => Err(StoreError::InvalidInput(
            "capture_paused must be true or false".into(),
        )),
        "excluded_apps" => {
            let raw_apps: Vec<String> = serde_json::from_str(value).map_err(|_| {
                StoreError::InvalidInput("excluded_apps must be a JSON string array".into())
            })?;
            if raw_apps.len() > 100 {
                return Err(StoreError::InvalidInput(
                    "excluded_apps exceeds safe limits".into(),
                ));
            }
            let mut apps = Vec::with_capacity(raw_apps.len());
            for app in raw_apps {
                let trimmed = app.trim();
                if trimmed.is_empty() || trimmed.len() > 255 {
                    return Err(StoreError::InvalidInput(
                        "excluded_apps exceeds safe limits".into(),
                    ));
                }
                if !apps
                    .iter()
                    .any(|existing: &String| existing.eq_ignore_ascii_case(trimmed))
                {
                    apps.push(trimmed.to_string());
                }
            }
            serde_json::to_string(&apps)
                .map_err(|_| StoreError::InvalidInput("invalid excluded_apps".into()))
        }
        _ => unreachable!(),
    }
}

fn parse_bounded(value: &str, minimum: i64, maximum: i64) -> StoreResult<String> {
    let parsed = value
        .parse::<i64>()
        .map_err(|_| StoreError::InvalidInput("setting must be an integer".into()))?;
    if !(minimum..=maximum).contains(&parsed) {
        return Err(StoreError::InvalidInput(format!(
            "setting must be between {minimum} and {maximum}"
        )));
    }
    Ok(parsed.to_string())
}

fn item_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<Item> {
    Ok(Item {
        id: row.get(0)?,
        kind: row.get(1)?,
        mime: row.get(2)?,
        text: row.get(3)?,
        blob_path: row.get(4)?,
        thumb_path: None,
        source_app: row.get(5)?,
        created_at: row.get(6)?,
        last_used_at: row.get(7)?,
        pinned: row.get(8)?,
        size_bytes: row.get(9)?,
        width: row.get(10)?,
        height: row.get(11)?,
    })
}

fn collect_blob_paths(connection: &Connection, sql: &str) -> StoreResult<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn collect_blob_paths_with_params(
    connection: &Connection,
    sql: &str,
    parameters: [i64; 1],
) -> StoreResult<Vec<String>> {
    let mut statement = connection.prepare(sql)?;
    let rows = statement.query_map(parameters, |row| row.get::<_, String>(0))?;
    Ok(rows.collect::<Result<Vec<_>, _>>()?)
}

fn is_managed_blob_name(name: &str) -> bool {
    let Some((hash, extension)) = name.rsplit_once('.') else {
        return false;
    };
    is_sha256_hex(hash) && matches!(extension, "png" | "jpg")
}

fn is_managed_thumb_name(name: &str) -> bool {
    let Some((hash, extension)) = name.rsplit_once('.') else {
        return false;
    };
    is_sha256_hex(hash) && extension == "png"
}

fn is_sha256_hex(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn blob_hash_from_relative(relative: &str) -> Option<&str> {
    let mut components = Path::new(relative).components();
    let directory = components.next()?.as_os_str().to_str()?;
    let name = components.next()?.as_os_str().to_str()?;
    if directory != "blobs" || components.next().is_some() || !is_managed_blob_name(name) {
        return None;
    }
    name.rsplit_once('.').map(|(hash, _)| hash)
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageBuffer, Rgba};
    use tempfile::TempDir;

    fn test_store() -> (TempDir, Store) {
        let temp = TempDir::new().expect("temp dir");
        let store =
            Store::new(temp.path().join("data"), temp.path().join("runtime/inbox")).expect("store");
        (temp, store)
    }

    fn seed_image(
        store: &Store,
        id: &str,
        hash: &str,
        created_at: i64,
        size_bytes: i64,
        pinned: bool,
    ) -> PathBuf {
        let relative = format!("blobs/{hash}.png");
        let path = store.root().join(&relative);
        fs::write(&path, b"seed").expect("seed blob");
        store
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO items(id, kind, mime, blob_path, content_hash, created_at,
                                   last_used_at, pinned, size_bytes, width, height)
                 VALUES(?1, 'image', 'image/png', ?2, ?3, ?4, ?4, ?5, ?6, 1, 1)",
                params![id, relative, hash, created_at, pinned, size_bytes],
            )
            .expect("seed image row");
        path
    }

    #[test]
    fn duplicate_text_is_moved_instead_of_duplicated() {
        let (_temp, store) = test_store();
        let first = store.capture_text("same", Some("app.one")).expect("first");
        let second = store.capture_text("same", Some("app.two")).expect("second");
        assert_eq!(first.id, second.id);
        assert_eq!(
            store.list_items("history", "", 100).expect("items").len(),
            1
        );
        assert_eq!(second.source_app.as_deref(), Some("app.two"));
    }

    #[test]
    fn history_limit_removes_oldest_unpinned_items() {
        let (_temp, store) = test_store();
        store.set_setting("history_limit", "50").expect("limit");
        for number in 0..70 {
            store
                .capture_text(&format!("item-{number}"), None)
                .expect("capture");
        }
        assert_eq!(
            store.list_items("history", "", 100).expect("items").len(),
            50
        );
    }

    #[test]
    fn unpinning_reapplies_history_limits() {
        let (_temp, store) = test_store();
        store.set_setting("history_limit", "50").expect("limit");
        let oldest = store.capture_text("item-0", None).expect("oldest");
        for number in 1..50 {
            store
                .capture_text(&format!("item-{number}"), None)
                .expect("capture");
        }
        store.toggle_pin(&oldest.id).expect("pin oldest");
        store.capture_text("item-50", None).expect("extra history");

        let unpinned = store.toggle_pin(&oldest.id).expect("unpin oldest");

        assert!(!unpinned.pinned);
        assert!(matches!(
            store.get_item(&oldest.id),
            Err(StoreError::NotFound)
        ));
        assert_eq!(
            store.list_items("history", "", 100).expect("items").len(),
            50
        );
    }

    #[test]
    fn notes_survive_history_cleanup() {
        let (_temp, store) = test_store();
        let note = store.add_note("keep me", false).expect("note");
        store.set_setting("history_limit", "50").expect("limit");
        for number in 0..60 {
            store
                .capture_text(&format!("clip-{number}"), None)
                .expect("capture");
        }
        assert_eq!(
            store
                .get_item(&note.id)
                .expect("saved note")
                .text
                .as_deref(),
            Some("keep me")
        );
    }

    #[test]
    fn list_returns_bounded_preview_and_get_item_returns_full_text() {
        let (_temp, store) = test_store();
        let text = "あ".repeat(MAX_PREVIEW_CHARS + 100);
        let saved = store.capture_text(&text, None).expect("capture");

        let listed = store.list_items("history", "", 100).expect("list");
        assert_eq!(
            listed[0].text.as_deref().expect("preview").chars().count(),
            MAX_PREVIEW_CHARS
        );
        assert_eq!(
            store
                .get_item(&saved.id)
                .expect("full item")
                .text
                .as_deref(),
            Some(text.as_str())
        );
    }

    #[test]
    fn notes_respect_absolute_count_limit_without_blocking_recovery() {
        let (_temp, store) = test_store();
        let connection = store.connection().expect("connection");
        connection
            .execute_batch(
                "WITH RECURSIVE numbers(value) AS (
                     SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 5000
                 )
                 INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 SELECT printf('00000000-0000-4000-8000-%012d', value), 'note', 'text/plain',
                        'saved note', printf('note:%d', value), 1, 1, 0, 10
                 FROM numbers;",
            )
            .expect("seed notes");

        assert!(matches!(
            store.add_note("one too many", false),
            Err(StoreError::LimitReached(_))
        ));
        assert_eq!(store.stats().expect("stats").item_count, HARD_HISTORY_LIMIT);

        connection
            .execute(
                "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff', 'note', 'text/plain', 'legacy',
                        'note:legacy', 1, 1, 0, 6)",
                [],
            )
            .expect("seed legacy overflow");
        store.reconcile().expect("daemon can start for cleanup");
        store
            .delete_item("ffffffff-ffff-4fff-8fff-ffffffffffff")
            .expect("cleanup remains available");
    }

    #[test]
    fn notes_respect_absolute_text_storage_limit() {
        let (_temp, store) = test_store();
        let connection = store.connection().expect("connection");
        connection
            .execute(
                "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 VALUES('ffffffff-ffff-4fff-8fff-ffffffffffff', 'note', 'text/plain', 'legacy',
                        'note:legacy', 1, 1, 1, ?1)",
                [HARD_TEXT_STORAGE_BYTES],
            )
            .expect("seed full store");

        assert!(matches!(
            store.add_note("one too many", false),
            Err(StoreError::LimitReached(_))
        ));
        assert_eq!(store.stats().expect("stats").item_count, 1);
        store.reconcile().expect("daemon can start for cleanup");
    }

    #[test]
    fn rejects_spool_paths_outside_private_inbox() {
        let (temp, store) = test_store();
        let outside = temp.path().join("outside.png");
        fs::write(&outside, b"not an image").expect("outside");
        let error = store
            .capture_image(&outside, "image/png", None)
            .expect_err("must reject");
        assert!(matches!(error, StoreError::InvalidInput(_)));
    }

    #[test]
    fn captures_and_deletes_valid_png() {
        let (_temp, store) = test_store();
        let spool = store.inbox_dir().join("capture.png");
        let image = ImageBuffer::<Rgba<u8>, _>::from_pixel(8, 6, Rgba([32, 64, 96, 255]));
        image.save(&spool).expect("png");
        let item = store
            .capture_image(&spool, "image/png", Some("screenshot"))
            .expect("capture");
        let blob = PathBuf::from(item.blob_path.as_ref().expect("blob"));
        assert!(blob.is_file());
        assert_eq!((item.width, item.height), (Some(8), Some(6)));
        store.delete_item(&item.id).expect("delete");
        assert!(!blob.exists());
    }

    #[test]
    fn recapturing_an_image_repairs_a_missing_blob() {
        let (_temp, store) = test_store();
        let first_spool = store.inbox_dir().join("first.png");
        let image = ImageBuffer::<Rgba<u8>, _>::from_pixel(8, 6, Rgba([40, 80, 120, 255]));
        image.save(&first_spool).expect("first image");
        let first = store
            .capture_image(&first_spool, "image/png", None)
            .expect("first capture");
        store.toggle_pin(&first.id).expect("pin image");
        let missing_blob = PathBuf::from(first.blob_path.expect("first blob"));
        fs::remove_file(&missing_blob).expect("remove blob");

        let second_spool = store.inbox_dir().join("second.png");
        image.save(&second_spool).expect("second image");
        let repaired = store
            .capture_image(&second_spool, "image/png", None)
            .expect("repair capture");

        assert_eq!(first.id, repaired.id);
        assert!(repaired.pinned);
        assert!(Path::new(repaired.blob_path.as_deref().expect("repaired blob")).is_file());
        assert_eq!(
            store.list_items("images", "", 100).expect("images").len(),
            1
        );
    }

    #[test]
    fn setting_values_are_bounded() {
        let (_temp, store) = test_store();
        assert!(store.set_setting("history_limit", "5001").is_err());
        assert!(store.set_setting("image_limit_mb", "2048").is_err());
        assert!(store.set_setting("capture_paused", "maybe").is_err());
    }

    #[test]
    fn lowering_image_limit_prunes_oldest_unpinned_images() {
        let (_temp, store) = test_store();
        let now = unix_timestamp();
        let oldest = seed_image(
            &store,
            "10000000-0000-4000-8000-000000000001",
            &"a".repeat(64),
            now - 1,
            20 * 1024 * 1024,
            false,
        );
        let newest = seed_image(
            &store,
            "20000000-0000-4000-8000-000000000002",
            &"b".repeat(64),
            now,
            20 * 1024 * 1024,
            false,
        );

        store.set_setting("image_limit_mb", "32").expect("limit");

        assert!(!oldest.exists());
        assert!(newest.exists());
        assert!(matches!(
            store.get_item("10000000-0000-4000-8000-000000000001"),
            Err(StoreError::NotFound)
        ));
        assert_eq!(store.stats().expect("stats").image_bytes, 20 * 1024 * 1024);
    }

    #[test]
    fn failed_image_capture_rolls_back_cleanup() {
        let (_temp, store) = test_store();
        store.set_setting("image_limit_mb", "32").expect("limit");
        let now = unix_timestamp();
        let unpinned = seed_image(
            &store,
            "30000000-0000-4000-8000-000000000003",
            &"c".repeat(64),
            now - 1,
            1,
            false,
        );
        seed_image(
            &store,
            "40000000-0000-4000-8000-000000000004",
            &"d".repeat(64),
            now,
            32 * 1024 * 1024,
            true,
        );
        let spool = store.inbox_dir().join("incoming.png");
        ImageBuffer::<Rgba<u8>, _>::from_pixel(8, 6, Rgba([1, 2, 3, 255]))
            .save(&spool)
            .expect("incoming image");

        assert!(matches!(
            store.capture_image(&spool, "image/png", None),
            Err(StoreError::LimitReached(_))
        ));
        assert!(unpinned.exists());
        assert!(
            store
                .get_item("30000000-0000-4000-8000-000000000003")
                .is_ok()
        );
        assert_eq!(store.stats().expect("stats").image_count, 2);
    }

    #[test]
    fn corrupted_blob_path_cannot_delete_outside_blob_directory() {
        let (temp, store) = test_store();
        let outside = temp.path().join("outside.png");
        fs::write(&outside, b"keep").expect("outside file");
        store
            .connection()
            .expect("connection")
            .execute(
                "INSERT INTO items(id, kind, mime, blob_path, content_hash, created_at,
                                   last_used_at, pinned, size_bytes)
                 VALUES(?1, 'image', 'image/png', 'blobs/../../outside.png', ?2, ?3, ?3, 0, 4)",
                params![
                    "50000000-0000-4000-8000-000000000005",
                    "e".repeat(64),
                    unix_timestamp()
                ],
            )
            .expect("corrupt row");

        store
            .delete_item("50000000-0000-4000-8000-000000000005")
            .expect("delete row");
        assert!(outside.exists());
    }

    #[test]
    fn concurrent_duplicate_images_share_one_safe_blob() {
        let (_temp, store) = test_store();
        let mut workers = Vec::new();
        for index in 0..6 {
            let spool = store.inbox_dir().join(format!("concurrent-{index}.png"));
            ImageBuffer::<Rgba<u8>, _>::from_pixel(8, 6, Rgba([8, 16, 24, 255]))
                .save(&spool)
                .expect("image");
            let worker_store = store.clone();
            workers.push(std::thread::spawn(move || {
                worker_store
                    .capture_image(&spool, "image/png", None)
                    .expect("capture")
            }));
        }
        let items = workers
            .into_iter()
            .map(|worker| worker.join().expect("worker"))
            .collect::<Vec<_>>();

        assert!(items.windows(2).all(|pair| pair[0].id == pair[1].id));
        assert_eq!(
            store.list_items("images", "", 100).expect("images").len(),
            1
        );
        assert!(Path::new(items[0].blob_path.as_deref().expect("blob")).is_file());
    }

    #[test]
    fn multi_word_search_matches_all_tokens_across_text_and_source() {
        let (_temp, store) = test_store();
        store
            .capture_text("Rust clipboard daemon", Some("Alacritty"))
            .expect("first");
        store
            .capture_text("Rust web client", Some("firefox"))
            .expect("second");

        let matches = store
            .list_items("history", "  rust   alacritty ", 50)
            .expect("search");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].text.as_deref(), Some("Rust clipboard daemon"));
    }

    #[test]
    fn same_second_items_preserve_newest_first_order() {
        let (_temp, store) = test_store();
        let connection = store.connection().expect("connection");
        let now = unix_timestamp();
        for (index, label) in ["first", "second", "third"].into_iter().enumerate() {
            connection
                .execute(
                    "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                       pinned, size_bytes)
                     VALUES(?1, 'text', 'text/plain;charset=utf-8', ?2, ?3, ?4, ?4, 0, ?5)",
                    params![
                        format!("60000000-0000-4000-8000-00000000000{}", index + 1),
                        label,
                        sha256_bytes(label.as_bytes()),
                        now,
                        label.len() as i64
                    ],
                )
                .expect("seed item");
        }

        let listed = store.list_items("history", "", 10).expect("list");
        let texts: Vec<_> = listed
            .iter()
            .map(|item| item.text.as_deref().unwrap_or(""))
            .collect();
        assert_eq!(texts, vec!["third", "second", "first"]);
    }

    #[test]
    fn excluded_apps_match_case_insensitively_and_normalize() {
        let (_temp, store) = test_store();
        store
            .set_setting(
                "excluded_apps",
                r#"[" KeePassXC ", "keepassxc", "Bitwarden"]"#,
            )
            .expect("excluded apps");
        assert_eq!(
            store.setting("excluded_apps").expect("read setting"),
            r#"["KeePassXC","Bitwarden"]"#
        );

        assert!(matches!(
            store.capture_text("secret", Some("keepassxc")),
            Err(StoreError::InvalidInput(_))
        ));
        assert!(store.capture_text("public", Some("firefox")).is_ok());
    }

    #[test]
    fn update_note_edits_note_and_rejects_non_note_items() {
        let (_temp, store) = test_store();
        let note = store.add_note("initial", true).expect("note");
        let clip = store.capture_text("clipboard text", None).expect("clip");

        let updated = store.update_note(&note.id, "revised").expect("update");
        assert_eq!(updated.text.as_deref(), Some("revised"));
        assert!(updated.pinned);
        assert!(matches!(
            store.update_note(&clip.id, "hacked"),
            Err(StoreError::NotFound)
        ));
    }

    #[test]
    fn reconcile_cleans_stale_inbox_spool_files_without_removing_active_ones() {
        let (_temp, store) = test_store();
        let active = store.inbox_dir().join("active.png");
        fs::write(&active, b"in-flight").expect("active file");

        store.reconcile().expect("reconcile preserves fresh spool");
        assert!(active.exists());

        store
            .reconcile_inbox_older_than(0)
            .expect("cleanup removes stale spool");
        assert!(!active.exists());
    }

    #[test]
    fn list_items_allows_up_to_200_items() {
        let (_temp, store) = test_store();
        for index in 0..140 {
            store
                .capture_text(&format!("entry-{index}"), None)
                .expect("capture");
        }
        assert_eq!(
            store.list_items("history", "", 200).expect("list").len(),
            140
        );
    }

    #[test]
    fn list_items_page_paginates_without_overlap() {
        let (_temp, store) = test_store();
        for index in 0..10 {
            store
                .capture_text(&format!("page-{index}"), None)
                .expect("capture");
        }
        let first = store.list_items_page("history", "", 4, 0).expect("page 1");
        let second = store.list_items_page("history", "", 4, 4).expect("page 2");
        let third = store.list_items_page("history", "", 4, 8).expect("page 3");
        assert_eq!(first.len(), 4);
        assert_eq!(second.len(), 4);
        assert_eq!(third.len(), 2);
        let texts: Vec<_> = first
            .into_iter()
            .chain(second)
            .chain(third)
            .map(|item| item.text.unwrap_or_default())
            .collect();
        assert_eq!(
            texts,
            (0..10)
                .rev()
                .map(|index| format!("page-{index}"))
                .collect::<Vec<_>>()
        );
    }

    #[test]
    fn large_image_generates_and_cleans_thumbnail() {
        let (_temp, store) = test_store();
        let spool = store.inbox_dir().join("large.png");
        let image = ImageBuffer::<Rgba<u8>, _>::from_pixel(900, 600, Rgba([20, 40, 60, 255]));
        image.save(&spool).expect("png");
        let item = store
            .capture_image(&spool, "image/png", Some("screenshot"))
            .expect("capture");
        let thumb = PathBuf::from(item.thumb_path.as_ref().expect("thumbnail generated"));
        assert!(thumb.is_file());
        let (tw, th) = ImageReader::open(&thumb)
            .expect("open thumb")
            .with_guessed_format()
            .expect("guess thumb")
            .into_dimensions()
            .expect("thumb dims");
        assert!(tw <= THUMB_MAX_WIDTH && th <= THUMB_MAX_HEIGHT);

        let orphan = store.root().join(format!("thumbs/{}.png", "f".repeat(64)));
        fs::write(&orphan, b"orphan").expect("orphan thumb");
        store.reconcile().expect("reconcile");
        assert!(!orphan.exists());
        assert!(thumb.is_file());

        store.delete_item(&item.id).expect("delete");
        assert!(!thumb.exists());
    }

    #[test]
    fn second_store_on_same_directory_is_rejected_by_exclusive_lock() {
        let (temp, _first) = test_store();
        let second = Store::new(temp.path().join("data"), temp.path().join("runtime/inbox"));
        assert!(matches!(second, Err(StoreError::LimitReached(_))));
    }

    #[test]
    fn hard_item_limit_evicts_unpinned_history_even_below_history_limit() {
        let (_temp, store) = test_store();
        let connection = store.connection().expect("connection");
        let now = unix_timestamp();
        connection
            .execute_batch(&format!(
                "WITH RECURSIVE numbers(value) AS (
                     SELECT 1 UNION ALL SELECT value + 1 FROM numbers WHERE value < 4950
                 )
                 INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 SELECT printf('10000000-0000-4000-8000-%012d', value), 'note', 'text/plain',
                        'saved note', printf('note:%d', value), {now}, {now}, 0, 10
                 FROM numbers;"
            ))
            .expect("seed notes");
        for index in 0..50 {
            store
                .capture_text(&format!("clip-{index}"), None)
                .expect("seed clip");
        }
        assert_eq!(store.stats().expect("stats").item_count, HARD_HISTORY_LIMIT);

        let extra = store
            .capture_text("clip-extra", None)
            .expect("must evict oldest unpinned clip instead of failing");
        assert_eq!(extra.text.as_deref(), Some("clip-extra"));
        assert_eq!(store.stats().expect("stats").item_count, HARD_HISTORY_LIMIT);
    }

    #[test]
    fn expired_unpinned_items_are_hidden_from_list_items() {
        let (_temp, store) = test_store();
        let connection = store.connection().expect("connection");
        let expired_ts = unix_timestamp() - 40 * 86_400;
        connection
            .execute(
                "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 VALUES('70000000-0000-4000-8000-000000000001', 'text', 'text/plain', 'old clip',
                        ?1, ?2, ?2, 0, 8)",
                params![sha256_bytes(b"old clip"), expired_ts],
            )
            .expect("seed expired clip");
        connection
            .execute(
                "INSERT INTO items(id, kind, mime, text, content_hash, created_at, last_used_at,
                                   pinned, size_bytes)
                 VALUES('70000000-0000-4000-8000-000000000002', 'text', 'text/plain', 'pinned old',
                        ?1, ?2, ?2, 1, 10)",
                params![sha256_bytes(b"pinned old"), expired_ts],
            )
            .expect("seed expired pinned");

        let listed = store.list_items("history", "", 50).expect("list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].text.as_deref(), Some("pinned old"));
    }
}
