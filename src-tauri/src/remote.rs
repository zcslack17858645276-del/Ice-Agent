use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

const DEFAULT_PORT: u16 = 8787;

#[derive(Default)]
pub struct RemoteState {
    pub running: Mutex<Option<Arc<AtomicBool>>>,
    pub port: Mutex<u16>,
    pub token: Mutex<String>,
}

fn root() -> PathBuf {
    if let Ok(value) = std::env::var("ICE_AGENT_DATA") {
        let trimmed = value.trim();
        if !trimmed.is_empty() {
            return PathBuf::from(trimmed);
        }
    }
    for drive in ["D:\\", "E:\\", "F:\\"] {
        if Path::new(drive).exists() {
            return PathBuf::from(drive).join("IceAgent");
        }
    }
    PathBuf::from("IceAgent")
}

fn characters_dir() -> PathBuf {
    let dir = root().join("characters");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn now_ms() -> u128 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_millis())
        .unwrap_or_default()
}

fn token() -> String {
    let path = root().join("server.json");
    if let Ok(text) = std::fs::read_to_string(&path) {
        if let Ok(value) = serde_json::from_str::<Value>(&text) {
            if let Some(existing) = value.get("token").and_then(|item| item.as_str()) {
                if !existing.is_empty() {
                    return existing.to_string();
                }
            }
        }
    }
    let generated = format!("{:016x}{:016x}", now_ms(), now_ms() ^ 0x5dee_ce66d);
    let _ = std::fs::create_dir_all(root());
    let _ = std::fs::write(
        path,
        serde_json::to_string_pretty(&json!({ "token": generated, "port": DEFAULT_PORT }))
            .unwrap_or_default(),
    );
    generated
}

fn decode_base64(input: &str) -> Option<Vec<u8>> {
    let mut output = Vec::with_capacity(input.len() * 3 / 4);
    let mut buffer: u32 = 0;
    let mut bits = 0u8;
    for ch in input.bytes() {
        let value = match ch {
            b'A'..=b'Z' => ch - b'A',
            b'a'..=b'z' => ch - b'a' + 26,
            b'0'..=b'9' => ch - b'0' + 52,
            b'+' => 62,
            b'/' => 63,
            b'=' | b'\n' | b'\r' | b' ' => continue,
            _ => return None,
        };
        buffer = (buffer << 6) | u32::from(value);
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            output.push((buffer >> bits) as u8);
        }
    }
    Some(output)
}

fn sanitize(relative: &str) -> Option<PathBuf> {
    let mut path = PathBuf::new();
    for part in relative.replace('\\', "/").split('/') {
        if part.is_empty() || part == "." {
            continue;
        }
        if part == ".." || part.contains(':') {
            return None;
        }
        path.push(part);
    }
    if path.as_os_str().is_empty() {
        None
    } else {
        Some(path)
    }
}

#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct CharacterEntry {
    pub id: String,
    pub name: String,
    pub kind: String,
    pub entry: String,
    pub path: String,
}

fn read_meta(dir: &Path) -> Option<CharacterEntry> {
    let text = std::fs::read_to_string(dir.join("character.json")).ok()?;
    let text = text.trim_start_matches('\u{feff}');
    let value: Value = serde_json::from_str(text).ok()?;
    Some(CharacterEntry {
        id: value.get("id")?.as_str()?.to_string(),
        name: value.get("name")?.as_str()?.to_string(),
        kind: value.get("kind")?.as_str()?.to_string(),
        entry: value.get("entry")?.as_str()?.to_string(),
        path: dir.to_string_lossy().to_string(),
    })
}

#[tauri::command(rename = "character:list")]
pub fn character_list() -> Result<Vec<CharacterEntry>, String> {
    let mut entries = Vec::new();
    let Ok(read) = std::fs::read_dir(characters_dir()) else {
        return Ok(entries);
    };
    for item in read.flatten() {
        if item.path().is_dir() {
            if let Some(entry) = read_meta(&item.path()) {
                entries.push(entry);
            }
        }
    }
    entries.sort_by(|left, right| left.name.to_lowercase().cmp(&right.name.to_lowercase()));
    Ok(entries)
}

#[derive(Deserialize)]
pub struct ImportFile {
    pub path: String,
    pub data: String,
}

#[tauri::command(rename = "character:import")]
pub fn character_import(
    name: String,
    kind: String,
    files: Vec<ImportFile>,
) -> Result<CharacterEntry, String> {
    if files.is_empty() {
        return Err("No files were provided.".into());
    }
    let slug: String = name
        .trim()
        .to_lowercase()
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect();
    let id = format!("{}-{}", slug.trim_matches('-'), now_ms() % 100000);
    let dir = characters_dir().join(&id);
    std::fs::create_dir_all(&dir).map_err(|error| format!("create dir failed: {error}"))?;

    let mut entry_file: Option<String> = None;
    for file in files {
        let Some(relative) = sanitize(&file.path) else {
            continue;
        };
        let Some(bytes) = decode_base64(&file.data) else {
            return Err(format!("Invalid base64 payload for {}", file.path));
        };
        let target = dir.join(&relative);
        if let Some(parent) = target.parent() {
            std::fs::create_dir_all(parent).map_err(|error| format!("mkdir failed: {error}"))?;
        }
        std::fs::write(&target, bytes).map_err(|error| format!("write failed: {error}"))?;
        let lower = relative.to_string_lossy().to_lowercase();
        if lower.ends_with(".model3.json") {
            entry_file = Some(relative.to_string_lossy().replace('\\', "/"));
        } else if entry_file.is_none()
            && (lower.ends_with(".png") || lower.ends_with(".jpg") || lower.ends_with(".webp"))
        {
            entry_file = Some(relative.to_string_lossy().replace('\\', "/"));
        }
    }

    let Some(entry) = entry_file else {
        let _ = std::fs::remove_dir_all(&dir);
        return Err("No image or .model3.json found in the import.".into());
    };

    let meta = json!({ "id": id, "name": name.trim(), "kind": kind, "entry": entry });
    std::fs::write(
        dir.join("character.json"),
        serde_json::to_string_pretty(&meta).unwrap_or_default(),
    )
    .map_err(|error| format!("meta write failed: {error}"))?;

    read_meta(&dir).ok_or_else(|| "import failed".to_string())
}

#[tauri::command(rename = "character:delete")]
pub fn character_delete(id: String) -> Result<(), String> {
    let Some(relative) = sanitize(&id) else {
        return Err("Invalid id".into());
    };
    let dir = characters_dir().join(relative);
    if dir.starts_with(characters_dir()) && dir.exists() {
        std::fs::remove_dir_all(dir).map_err(|error| format!("delete failed: {error}"))?;
    }
    Ok(())
}


// ------------------------------------------------------------ session store

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionMessage {
    pub role: String,
    pub content: String,
    #[serde(default)]
    pub ts: u64,
}

#[derive(Serialize, Deserialize, Clone)]
#[serde(rename_all = "camelCase")]
pub struct SessionFile {
    pub id: String,
    pub title: String,
    pub created_at: u64,
    #[serde(default)]
    pub messages: Vec<SessionMessage>,
}

fn sessions_dir() -> PathBuf {
    let dir = root().join("sessions");
    let _ = std::fs::create_dir_all(&dir);
    dir
}

fn session_path(id: &str) -> Option<PathBuf> {
    let relative = sanitize(id)?;
    if relative.components().count() != 1 {
        return None;
    }
    Some(sessions_dir().join(relative).with_extension("json"))
}

fn read_session(id: &str) -> Option<SessionFile> {
    let path = session_path(id)?;
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(text.trim_start_matches('\u{feff}')).ok()
}

fn write_session(session: &SessionFile) -> Result<(), String> {
    let path = session_path(&session.id).ok_or_else(|| "bad id".to_string())?;
    let text = serde_json::to_string_pretty(session).map_err(|error| error.to_string())?;
    std::fs::write(path, text).map_err(|error| error.to_string())
}

fn list_sessions() -> Vec<SessionFile> {
    let mut sessions = Vec::new();
    let Ok(read) = std::fs::read_dir(sessions_dir()) else {
        return sessions;
    };
    for item in read.flatten() {
        if item.path().extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }
        if let Ok(text) = std::fs::read_to_string(item.path()) {
            if let Ok(session) = serde_json::from_str::<SessionFile>(text.trim_start_matches('\u{feff}')) {
                sessions.push(session);
            }
        }
    }
    sessions.sort_by(|left, right| right.created_at.cmp(&left.created_at));
    sessions
}

fn new_session(title: String) -> SessionFile {
    SessionFile {
        id: format!("s-{}-{}", now_ms(), now_ms() % 1000),
        title,
        created_at: now_ms() as u64,
        messages: Vec::new(),
    }
}

#[tauri::command(rename = "session:list")]
pub fn session_list() -> Result<Vec<SessionFile>, String> {
    Ok(list_sessions())
}

#[tauri::command(rename = "session:create")]
pub fn session_create(title: Option<String>) -> Result<SessionFile, String> {
    let session = new_session(title.unwrap_or_else(|| "新的对话".into()));
    write_session(&session)?;
    Ok(session)
}

#[tauri::command(rename = "session:get")]
pub fn session_get(id: String) -> Result<Option<SessionFile>, String> {
    Ok(read_session(&id))
}

#[tauri::command(rename = "session:append")]
pub fn session_append(id: String, role: String, content: String) -> Result<SessionFile, String> {
    let mut session = read_session(&id).unwrap_or_else(|| new_session("新的对话".into()));
    session.messages.push(SessionMessage {
        role,
        content: content.clone(),
        ts: now_ms() as u64,
    });
    if session.title == "新的对话" && !content.trim().is_empty() {
        let text = content.trim().replace('\n', " ");
        session.title = if text.chars().count() > 18 {
            format!("{}…", text.chars().take(18).collect::<String>())
        } else {
            text
        };
    }
    write_session(&session)?;
    Ok(session)
}

#[tauri::command(rename = "session:delete")]
pub fn session_delete(id: String) -> Result<(), String> {
    if let Some(path) = session_path(&id) {
        let _ = std::fs::remove_file(path);
    }
    Ok(())
}

// --------------------------------------------------------- async HTTP server

struct Request {
    method: String,
    path: String,
    auth: String,
    body: String,
}

async fn read_request(stream: &mut tokio::net::TcpStream) -> Option<Request> {
    let mut buffer = Vec::new();
    let mut chunk = [0u8; 8192];
    let mut header_end: Option<usize> = None;
    loop {
        let read = stream.read(&mut chunk).await.ok()?;
        if read == 0 {
            break;
        }
        buffer.extend_from_slice(&chunk[..read]);
        if header_end.is_none() {
            header_end = buffer
                .windows(4)
                .position(|window| window == b"\r\n\r\n")
                .map(|index| index + 4);
        }
        if let Some(end) = header_end {
            let head = String::from_utf8_lossy(&buffer[..end]).to_lowercase();
            let length = head
                .lines()
                .find_map(|line| line.strip_prefix("content-length:"))
                .and_then(|value| value.trim().parse::<usize>().ok())
                .unwrap_or(0);
            if buffer.len() >= end + length {
                break;
            }
        }
    }
    let end = header_end?;
    let head = String::from_utf8_lossy(&buffer[..end]).to_string();
    let mut lines = head.lines();
    let request_line = lines.next()?.to_string();
    let mut parts = request_line.split_whitespace();
    let method = parts.next()?.to_string();
    let target = parts.next()?.to_string();
    let mut auth = String::new();
    for line in lines {
        if let Some(value) = line.to_lowercase().strip_prefix("authorization:") {
            auth = value.trim().to_string();
        }
    }
    let length = head
        .to_lowercase()
        .lines()
        .find_map(|line| {
            line.strip_prefix("content-length:")
                .map(|value| value.trim().to_string())
        })
        .and_then(|value| value.parse::<usize>().ok())
        .unwrap_or(0);
    let body = buffer
        .get(end..end + length)
        .map(|slice| String::from_utf8_lossy(slice).to_string())
        .unwrap_or_default();
    Some(Request {
        method,
        path: target.split('?').next().unwrap_or("/").to_string(),
        auth,
        body,
    })
}

async fn respond(
    stream: &mut tokio::net::TcpStream,
    status: u16,
    content_type: &str,
    body: &[u8],
) {
    let head = format!(
        "HTTP/1.1 {status} {reason}\r\nContent-Type: {content_type}\r\nContent-Length: {len}\r\nAccess-Control-Allow-Origin: *\r\nAccess-Control-Allow-Headers: authorization, content-type\r\nConnection: close\r\n\r\n",
        reason = if status == 200 { "OK" } else { "ERR" },
        len = body.len()
    );
    let _ = stream.write_all(head.as_bytes()).await;
    let _ = stream.write_all(body).await;
    let _ = stream.flush().await;
}

async fn json_response(stream: &mut tokio::net::TcpStream, status: u16, value: Value) {
    respond(stream, status, "application/json", value.to_string().as_bytes()).await;
}

async fn serve_asset(stream: &mut tokio::net::TcpStream, relative: &str) {
    let Some(path) = sanitize(relative) else {
        return respond(stream, 400, "text/plain", b"bad path").await;
    };
    let full = characters_dir().join(path);
    let Ok(bytes) = std::fs::read(&full) else {
        return respond(stream, 404, "text/plain", b"missing").await;
    };
    let ext = full
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_lowercase();
    let content_type = match ext.as_str() {
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "webp" => "image/webp",
        "json" => "application/json",
        _ => "application/octet-stream",
    };
    respond(stream, 200, content_type, &bytes).await;
}

fn deepseek_key() -> Result<String, String> {
    crate::secure_key("deepseek_api_key")
        .map_err(|error| format!("{error}"))?
        .ok_or_else(|| "missing api key".to_string())
}

async fn proxy_chat(stream: &mut tokio::net::TcpStream, body: &str) -> Result<(), String> {
    let payload: Value = serde_json::from_str(body).map_err(|error| format!("bad json: {error}"))?;
    let stream_once = payload.get("stream").and_then(|value| value.as_bool()) == Some(false);
    let messages = payload
        .get("messages")
        .cloned()
        .ok_or_else(|| "messages missing".to_string())?;
    let model = payload
        .get("model")
        .and_then(|value| value.as_str())
        .unwrap_or("deepseek-chat")
        .to_string();
    let key = deepseek_key()?;
    let client = reqwest::Client::new();

    if stream_once {
        let response = client
            .post("https://api.deepseek.com/chat/completions")
            .bearer_auth(key)
            .timeout(std::time::Duration::from_secs(120))
            .json(&json!({
                "model": model,
                "messages": messages,
                "stream": false,
                "temperature": 0.8,
                "max_tokens": 1200
            }))
            .send()
            .await
            .map_err(|error| format!("upstream error: {error}"))?;
        if !response.status().is_success() {
            return Err(format!("upstream status {}", response.status().as_u16()));
        }
        let value: Value = response
            .json()
            .await
            .map_err(|error| format!("bad upstream body: {error}"))?;
        let content = value
            .get("choices")
            .and_then(|item| item.get(0))
            .and_then(|item| item.get("message"))
            .and_then(|item| item.get("content"))
            .and_then(|item| item.as_str())
            .unwrap_or_default()
            .to_string();
        json_response(stream, 200, json!({ "content": content })).await;
        return Ok(());
    }

    let mut response = client
        .post("https://api.deepseek.com/chat/completions")
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(120))
        .json(&json!({
            "model": model,
            "messages": messages,
            "stream": true,
            "temperature": 0.8,
            "max_tokens": 1200
        }))
        .send()
        .await
        .map_err(|error| format!("upstream error: {error}"))?;
    if !response.status().is_success() {
        return Err(format!("upstream status {}", response.status().as_u16()));
    }

    let head = "HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nCache-Control: no-cache\r\nTransfer-Encoding: chunked\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
    stream
        .write_all(head.as_bytes())
        .await
        .map_err(|error| error.to_string())?;

    while let Ok(Some(bytes)) = response.chunk().await {
        let size = format!("{:x}\r\n", bytes.len());
        if stream.write_all(size.as_bytes()).await.is_err()
            || stream.write_all(&bytes).await.is_err()
            || stream.write_all(b"\r\n").await.is_err()
        {
            break;
        }
        let _ = stream.flush().await;
    }
    let _ = stream.write_all(b"0\r\n\r\n").await;
    let _ = stream.flush().await;
    Ok(())
}

async fn handle(mut stream: tokio::net::TcpStream, expected_token: &str) {
    let Some(request) = read_request(&mut stream).await else {
        return;
    };
    if request.method == "OPTIONS" {
        return respond(&mut stream, 200, "text/plain", b"").await;
    }
    if request.path == "/v1/health" {
        return json_response(&mut stream, 200, json!({ "ok": true, "name": "Ice Agent" })).await;
    }
    if !request.path.starts_with("/v1/") && !request.path.starts_with("/assets/") {
        return respond(&mut stream, 404, "text/plain", b"not found").await;
    }
    if let Some(relative) = request.path.strip_prefix("/assets/") {
        return serve_asset(&mut stream, relative).await;
    }

    let allowed = expected_token.is_empty()
        || request
            .auth
            .trim()
            .eq_ignore_ascii_case(&format!("bearer {expected_token}"));
    if !allowed {
        return json_response(&mut stream, 401, json!({ "error": "unauthorized" })).await;
    }

    if request.path == "/v1/sessions" {
        if request.method == "POST" {
            let payload: Value = serde_json::from_str(if request.body.trim().is_empty() { "{}" } else { &request.body }).unwrap_or(json!({}));
            let title = payload.get("title").and_then(|value| value.as_str()).map(|value| value.to_string());
            return match session_create(title) {
                Ok(session) => json_response(&mut stream, 200, json!(session)).await,
                Err(error) => json_response(&mut stream, 500, json!({ "error": error })).await,
            };
        }
        let sessions: Vec<Value> = list_sessions()
            .into_iter()
            .map(|session| {
                json!({
                    "id": session.id,
                    "title": session.title,
                    "createdAt": session.created_at,
                    "count": session.messages.len(),
                    "last": session.messages.last().map(|item| item.content.chars().take(60).collect::<String>())
                })
            })
            .collect();
        return json_response(&mut stream, 200, json!({ "sessions": sessions })).await;
    }
    if let Some(rest) = request.path.strip_prefix("/v1/sessions/") {
        let mut parts = rest.split('/');
        let id = parts.next().unwrap_or("").to_string();
        let action = parts.next().unwrap_or("");
        if request.method == "DELETE" && action.is_empty() {
            let _ = session_delete(id);
            return json_response(&mut stream, 200, json!({ "ok": true })).await;
        }
        if action == "messages" && request.method == "POST" {
            let payload: Value = serde_json::from_str(&request.body).unwrap_or(json!({}));
            let role = payload.get("role").and_then(|value| value.as_str()).unwrap_or("user").to_string();
            let content = payload.get("content").and_then(|value| value.as_str()).unwrap_or("").to_string();
            return match session_append(id, role, content) {
                Ok(session) => json_response(&mut stream, 200, json!(session)).await,
                Err(error) => json_response(&mut stream, 500, json!({ "error": error })).await,
            };
        }
        if let Some(session) = read_session(&id) {
            return json_response(&mut stream, 200, json!(session)).await;
        }
        return json_response(&mut stream, 404, json!({ "error": "missing" })).await;
    }

    if request.path == "/v1/characters" {
        return match character_list() {
            Ok(list) => json_response(&mut stream, 200, json!({ "characters": list })).await,
            Err(error) => json_response(&mut stream, 500, json!({ "error": error })).await,
        };
    }
    if request.path == "/v1/chat" && request.method == "POST" {
        if let Err(error) = proxy_chat(&mut stream, &request.body).await {
            let _ = json_response(&mut stream, 502, json!({ "error": error })).await;
        }
        return;
    }
    json_response(&mut stream, 404, json!({ "error": "not found" })).await;
}

#[tauri::command(rename = "server:start")]
pub fn server_start(
    state: tauri::State<'_, RemoteState>,
    port: Option<u16>,
) -> Result<Value, String> {
    let mut running = state.running.lock().map_err(|_| "busy".to_string())?;
    if running.is_some() {
        let current = *state.port.lock().map_err(|_| "busy".to_string())?;
        return Ok(json!({ "running": true, "port": current }));
    }
    let chosen = port.unwrap_or(DEFAULT_PORT);
    let token = token();
    if let Ok(mut slot) = state.token.lock() {
        *slot = token.clone();
    }
    if let Ok(mut slot) = state.port.lock() {
        *slot = chosen;
    }

    let flag = Arc::new(AtomicBool::new(true));
    *running = Some(flag.clone());
    drop(running);

    let token_for_loop = token.clone();
    tauri::async_runtime::spawn(async move {
        let listener = match TcpListener::bind(("0.0.0.0", chosen)).await {
            Ok(listener) => listener,
            Err(_) => {
                flag.store(false, Ordering::Relaxed);
                return;
            }
        };
        loop {
            if !flag.load(Ordering::Relaxed) {
                break;
            }
            match listener.accept().await {
                Ok((stream, _)) => {
                    let expected = token_for_loop.clone();
                    tauri::async_runtime::spawn(async move {
                        handle(stream, &expected).await;
                    });
                }
                Err(_) => tokio::time::sleep(std::time::Duration::from_millis(120)).await,
            }
        }
    });

    Ok(json!({ "running": true, "port": chosen, "token": token }))
}

#[tauri::command(rename = "server:stop")]
pub fn server_stop(state: tauri::State<'_, RemoteState>) -> Result<(), String> {
    let flag = state.running.lock().map_err(|_| "busy".to_string())?.take();
    if let Some(flag) = flag {
        flag.store(false, Ordering::Relaxed);
    }
    Ok(())
}

#[tauri::command(rename = "server:status")]
pub fn server_status(state: tauri::State<'_, RemoteState>) -> Result<Value, String> {
    let running = state
        .running
        .lock()
        .map(|slot| slot.is_some())
        .unwrap_or(false);
    let port = *state.port.lock().map_err(|_| "busy".to_string())?;
    let token = state
        .token
        .lock()
        .map(|value| value.clone())
        .unwrap_or_default();
    Ok(json!({ "running": running, "port": port, "token": token, "root": root().to_string_lossy() }))
}


/// Reads the standalone server config so clients can discover base URL + token.
#[tauri::command(rename = "server:local_config")]
pub fn server_local_config() -> Result<Value, String> {
    let path = root().join("config.json");
    let text = std::fs::read_to_string(path).map_err(|error| format!("config missing: {error}"))?;
    let value: Value = serde_json::from_str(text.trim_start_matches('\u{feff}'))
        .map_err(|error| format!("config invalid: {error}"))?;
    let port = value.get("port").and_then(|item| item.as_u64()).unwrap_or(DEFAULT_PORT as u64);
    Ok(json!({
        "base": format!("http://127.0.0.1:{port}"),
        "token": value.get("token").and_then(|item| item.as_str()).unwrap_or_default(),
        "model": value.get("model").and_then(|item| item.as_str()).unwrap_or("deepseek-chat"),
        "persona": value.get("persona").and_then(|item| item.as_str()).unwrap_or_default(),
    }))
}
