use rusqlite::Connection;
use serde::Deserialize;
use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum CommandError {
    WindowUnavailable(String),
    WindowOperation(String),
    Configuration(String),
    Credential(String),
    Network(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WindowUnavailable(message)
            | Self::WindowOperation(message)
            | Self::Configuration(message)
            | Self::Credential(message)
            | Self::Network(message) => formatter.write_str(message),
        }
    }
}

const CREDENTIAL_SERVICE: &str = "com.iceagent.desktop";

#[tauri::command(rename = "memory:initialize")]
fn memory_initialize(app: AppHandle) -> Result<(), CommandError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| CommandError::Configuration(error.to_string()))?;
    std::fs::create_dir_all(&directory)
        .map_err(|error| CommandError::Configuration(error.to_string()))?;
    let database = directory.join("memory.sqlite3");
    let connection = Connection::open(database).map_err(|error| {
        CommandError::Configuration(format!("Unable to open memory database: {error}"))
    })?;
    connection.execute_batch("BEGIN; CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS conversations (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER); CREATE TABLE IF NOT EXISTS messages (id TEXT PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES conversations(id), role TEXT NOT NULL CHECK(role IN ('system','user','assistant')), content TEXT NOT NULL, created_at INTEGER NOT NULL, incomplete INTEGER NOT NULL DEFAULT 0, deleted_at INTEGER); CREATE INDEX IF NOT EXISTS messages_conversation_time ON messages(conversation_id, created_at); CREATE TABLE IF NOT EXISTS memories (id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('preference','event','habit')), content TEXT NOT NULL, source_message_id TEXT NOT NULL REFERENCES messages(id), confidence REAL NOT NULL, privacy TEXT NOT NULL CHECK(privacy IN ('private','normal','sensitive')), status TEXT NOT NULL CHECK(status IN ('pending','confirmed','rejected','deleted')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, deleted_at INTEGER, embedding_model TEXT); CREATE TABLE IF NOT EXISTS memory_tags (memory_id TEXT NOT NULL REFERENCES memories(id), tag TEXT NOT NULL, PRIMARY KEY(memory_id, tag)); CREATE TABLE IF NOT EXISTS memory_embeddings (memory_id TEXT PRIMARY KEY REFERENCES memories(id), model_version TEXT NOT NULL, vector_json TEXT NOT NULL, updated_at INTEGER NOT NULL); INSERT OR IGNORE INTO schema_migrations(version, applied_at) VALUES (1, strftime('%s','now') * 1000); COMMIT;").map_err(|error| CommandError::Configuration(format!("Memory migration failed and was rolled back: {error}")))
}

fn credential(key: &str) -> Result<keyring::Entry, CommandError> {
    keyring::Entry::new(CREDENTIAL_SERVICE, key)
        .map_err(|_| CommandError::Credential("Secure credential storage is unavailable.".into()))
}

#[tauri::command(rename = "secure_store_get")]
fn secure_store_get(key: String) -> Result<Option<String>, CommandError> {
    match credential(&key)?.get_password() {
        Ok(value) => Ok(Some(value)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(_) => Err(CommandError::Credential(
            "Unable to read secure credentials.".into(),
        )),
    }
}

#[tauri::command(rename = "secure_store_set")]
fn secure_store_set(key: String, value: String) -> Result<(), CommandError> {
    if value.trim().is_empty() {
        return Err(CommandError::Configuration(
            "API key cannot be empty.".into(),
        ));
    }
    credential(&key)?
        .set_password(&value)
        .map_err(|_| CommandError::Credential("Unable to save secure credentials.".into()))
}

#[tauri::command(rename = "secure_store_remove")]
fn secure_store_remove(key: String) -> Result<(), CommandError> {
    credential(&key)?
        .delete_credential()
        .map_err(|_| CommandError::Credential("Unable to remove secure credentials.".into()))
}

#[derive(Debug, Deserialize)]
struct ConnectionConfig {
    base_url: String,
    model: String,
}

#[derive(Debug, Deserialize)]
struct ChatRequest {
    base_url: String,
    model: String,
    temperature: f32,
    max_output_tokens: u32,
    messages: Vec<serde_json::Value>,
}

#[derive(Debug, Serialize)]
struct BackendChunk {
    delta: String,
    done: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    finish_reason: Option<String>,
}

#[tauri::command(rename = "ai:stream")]
async fn ai_stream(request: ChatRequest) -> Result<Vec<BackendChunk>, CommandError> {
    let key = secure_store_get("deepseek_api_key".into())?.ok_or_else(|| {
        CommandError::Configuration(
            "Configure an API key in Chat Configuration before sending a message.".into(),
        )
    })?;
    let base = request
        .base_url
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions");
    if !(base.starts_with("https://") || base.starts_with("http://"))
        || request.model.trim().is_empty()
    {
        return Err(CommandError::Configuration(
            "Enter a valid base URL and model name.".into(),
        ));
    }
    let response = reqwest::Client::new().post(format!("{base}/chat/completions")).bearer_auth(key).timeout(std::time::Duration::from_secs(30)).json(&serde_json::json!({"model": request.model, "messages": request.messages, "temperature": request.temperature, "max_tokens": request.max_output_tokens, "stream": true})).send().await.map_err(|_| CommandError::Network("Unable to reach the AI service.".into()))?;
    if response.status().as_u16() == 429 {
        return Err(CommandError::Network(
            "The AI service is rate limited. Please try again shortly.".into(),
        ));
    }
    if !response.status().is_success() {
        return Err(CommandError::Network(
            "The AI service rejected the request.".into(),
        ));
    }
    let body = response
        .text()
        .await
        .map_err(|_| CommandError::Network("Unable to read the AI response.".into()))?;
    let mut chunks = Vec::new();
    for line in body.lines().filter(|line| line.starts_with("data:")) {
        let payload = line.trim_start_matches("data:").trim();
        if payload == "[DONE]" {
            chunks.push(BackendChunk {
                delta: String::new(),
                done: true,
                finish_reason: None,
            });
            continue;
        }
        let parsed: serde_json::Value = serde_json::from_str(payload)
            .map_err(|_| CommandError::Network("The AI service returned malformed data.".into()))?;
        let choice = parsed.get("choices").and_then(|value| value.get(0));
        let delta = choice
            .and_then(|value| value.get("delta"))
            .and_then(|value| value.get("content"))
            .and_then(|value| value.as_str())
            .unwrap_or_default()
            .to_owned();
        let finish = choice
            .and_then(|value| value.get("finish_reason"))
            .and_then(|value| value.as_str())
            .map(str::to_owned);
        if !delta.is_empty() || finish.is_some() {
            chunks.push(BackendChunk {
                delta,
                done: finish.is_some(),
                finish_reason: finish,
            });
        }
    }
    Ok(chunks)
}

#[tauri::command(rename = "ai:test_connection")]
async fn ai_test_connection(config: ConnectionConfig) -> Result<(), CommandError> {
    let key = secure_store_get("deepseek_api_key".into())?.ok_or_else(|| {
        CommandError::Configuration("Configure an API key before testing the connection.".into())
    })?;
    let base = config
        .base_url
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions");
    if !(base.starts_with("https://") || base.starts_with("http://"))
        || config.model.trim().is_empty()
    {
        return Err(CommandError::Configuration(
            "Enter a valid base URL and model name.".into(),
        ));
    }
    let response = reqwest::Client::new().post(format!("{base}/chat/completions")).bearer_auth(key).timeout(std::time::Duration::from_secs(15)).json(&serde_json::json!({"model": config.model, "messages": [{"role": "user", "content": "ping"}], "max_tokens": 1})).send().await.map_err(|_| CommandError::Network("Unable to reach the AI service.".into()))?;
    if response.status().is_success() {
        Ok(())
    } else if response.status().as_u16() == 429 {
        Err(CommandError::Network(
            "The AI service is rate limited.".into(),
        ))
    } else {
        Err(CommandError::Network(
            "The AI service rejected the connection test.".into(),
        ))
    }
}

fn main_window(app: &AppHandle) -> Result<WebviewWindow, CommandError> {
    app.get_webview_window(MAIN_WINDOW)
        .ok_or_else(|| CommandError::WindowUnavailable("The main window is unavailable.".into()))
}

#[tauri::command(rename = "window:show")]
fn window_show(app: AppHandle) -> Result<(), CommandError> {
    let window = main_window(&app)?;
    window
        .show()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:hide")]
fn window_hide(app: AppHandle) -> Result<(), CommandError> {
    let window = main_window(&app)?;
    window
        .hide()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:toggle")]
fn window_toggle(app: AppHandle) -> Result<bool, CommandError> {
    let window = main_window(&app)?;
    let visible = window
        .is_visible()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
    if visible {
        window_hide(app)?;
    } else {
        window_show(app)?;
    }
    Ok(!visible)
}

#[tauri::command(rename = "window:close")]
fn window_close(app: AppHandle) -> Result<(), CommandError> {
    let window = main_window(&app)?;
    window
        .close()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:close_current")]
fn window_close_current(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .close()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:minimize")]
fn window_minimize(app: AppHandle) -> Result<(), CommandError> {
    let window = main_window(&app)?;
    window
        .minimize()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:drag")]
fn window_drag(app: AppHandle) -> Result<(), CommandError> {
    let window = main_window(&app)?;
    window
        .start_dragging()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:open_panel")]
async fn window_open_panel(app: AppHandle, panel: String) -> Result<(), CommandError> {
    let (label, title) = match panel.as_str() {
        "chat" => ("panel-chat", "Ice Agent Chat"),
        "settings" => ("panel-settings", "Ice Agent Settings"),
        "chat-config" => ("panel-chat-config", "Chat Configuration"),
        _ => {
            return Err(CommandError::WindowOperation(
                "Unknown panel requested.".into(),
            ));
        }
    };
    if let Some(window) = app.get_webview_window(label) {
        window
            .show()
            .and_then(|()| window.set_focus())
            .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
        return Ok(());
    }
    let app_for_builder = app.clone();
    tauri::async_runtime::spawn_blocking(move || {
        WebviewWindowBuilder::new(
            &app_for_builder,
            label,
            WebviewUrl::App("index.html".into()),
        )
        .title(title)
        .inner_size(440.0, 560.0)
        .min_inner_size(360.0, 420.0)
        .decorations(true)
        .transparent(false)
        .resizable(true)
        .center()
        .build()
    })
    .await
    .map_err(|error| CommandError::WindowOperation(error.to_string()))?
    .map(|_| ())
    .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[derive(Debug, Serialize)]
struct AppInfo {
    version: &'static str,
    environment: &'static str,
    features: [&'static str; 1],
}

#[tauri::command(rename = "app:get_info")]
fn app_get_info() -> AppInfo {
    AppInfo {
        version: env!("CARGO_PKG_VERSION"),
        environment: if cfg!(debug_assertions) {
            "development"
        } else {
            "production"
        },
        features: ["foundation"],
    }
}

pub fn run() {
    tauri::Builder::default()
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                if let Some(monitor) = window.current_monitor()? {
                    let scale_factor = monitor.scale_factor();
                    let logical_height = monitor.size().height as f64 / scale_factor;
                    window.set_min_size(Some(tauri::LogicalSize::new(220.0, 1.0)))?;
                    window.set_size(tauri::LogicalSize::new(
                        280.0,
                        (logical_height * 3.0 / 8.0).round(),
                    ))?;
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            window_show,
            window_hide,
            window_toggle,
            window_close,
            window_close_current,
            window_minimize,
            window_drag,
            window_open_panel,
            app_get_info,
            secure_store_get,
            secure_store_set,
            secure_store_remove,
            ai_test_connection,
            ai_stream,
            memory_initialize
        ])
        .run(tauri::generate_context!())
        .expect("error while running Ice Agent");
}

#[cfg(test)]
mod tests {
    use super::CommandError;

    #[test]
    fn command_errors_are_serializable_and_descriptive() {
        let error = serde_json::to_value(CommandError::WindowUnavailable("missing".into()))
            .expect("command errors should serialize");
        assert_eq!(error["code"], "WindowUnavailable");
        assert_eq!(error["message"], "missing");
    }
}
