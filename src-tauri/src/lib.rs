use rusqlite::Connection;
use serde::Deserialize;
use serde::Serialize;
use std::collections::HashMap;
use std::net::{IpAddr, TcpStream};
use std::process::Command;
use std::sync::Mutex;
use std::time::Duration;
use tauri::{Emitter, AppHandle, Manager, State, WebviewUrl, WebviewWindow, WebviewWindowBuilder};

const MAIN_WINDOW: &str = "main";

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum CommandError {
    WindowUnavailable(String),
    WindowOperation(String),
    Configuration(String),
    Credential(String),
    Network(String),
    Audio(String),
    Recognition(String),
    Synthesis(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WindowUnavailable(message)
            | Self::WindowOperation(message)
            | Self::Configuration(message)
            | Self::Credential(message)
            | Self::Network(message)
            | Self::Audio(message)
            | Self::Recognition(message)
            | Self::Synthesis(message) => formatter.write_str(message),
        }
    }
}

#[derive(Default)]
struct VoiceTranscriptionRequests(Mutex<HashMap<String, tokio::task::AbortHandle>>);

#[derive(Default)]
struct VoiceSynthesisRequests(Mutex<HashMap<String, tokio::task::AbortHandle>>);

#[derive(Debug, Deserialize)]
struct WhisperRequest {
    request_id: String,
    base_url: String,
    model: String,
    content_type: String,
    data: Vec<u8>,
}

#[derive(Debug, Deserialize)]
struct WhisperResponse {
    text: String,
    language: Option<String>,
    segments: Option<Vec<WhisperResponseSegment>>,
}

#[derive(Debug, Deserialize)]
struct WhisperResponseSegment {
    text: String,
    start: f64,
    end: f64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscription {
    text: String,
    language: String,
    confidence: Option<f64>,
    segments: Vec<VoiceTranscriptionSegment>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct VoiceTranscriptionSegment {
    text: String,
    start_ms: u64,
    end_ms: u64,
}

fn whisper_endpoint(base_url: &str) -> Result<reqwest::Url, CommandError> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| {
        CommandError::Configuration("Enter a valid local Whisper service URL.".into())
    })?;
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(CommandError::Configuration(
            "Whisper must use an HTTP service bound to localhost or a loopback address.".into(),
        ));
    }
    url.set_path("/v1/audio/transcriptions");
    Ok(url)
}

fn gpt_sovits_endpoint(base_url: &str) -> Result<reqwest::Url, CommandError> {
    let mut url = reqwest::Url::parse(base_url.trim()).map_err(|_| {
        CommandError::Configuration("Enter a valid local GPT-SoVITS service URL.".into())
    })?;
    let loopback = url.host_str().is_some_and(|host| {
        host.eq_ignore_ascii_case("localhost")
            || host
                .parse::<IpAddr>()
                .is_ok_and(|address| address.is_loopback())
    });
    if url.scheme() != "http"
        || !loopback
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || !matches!(url.path(), "" | "/")
    {
        return Err(CommandError::Configuration(
            "GPT-SoVITS must use an HTTP service bound to localhost or a loopback address.".into(),
        ));
    }
    url.set_path("/tts");
    Ok(url)
}

#[derive(Debug, Deserialize)]
struct GPTSoVITSRequest {
    request_id: String,
    base_url: String,
    text: String,
    text_lang: String,
    ref_audio_path: String,
    prompt_text: String,
    prompt_lang: String,
    batch_size: Option<u32>,
}

async fn send_gpt_sovits_request(request: GPTSoVITSRequest) -> Result<Vec<u8>, CommandError> {
    const MAX_AUDIO_BYTES: usize = 50 * 1024 * 1024;
    if request.text.trim().is_empty()
        || request.text.len() > 5000
        || request.ref_audio_path.trim().is_empty()
        || request.ref_audio_path.len() > 2048
        || request.prompt_text.trim().is_empty()
        || request.prompt_text.len() > 5000
        || !valid_language(&request.text_lang)
        || !valid_language(&request.prompt_lang)
    {
        return Err(CommandError::Configuration(
            "GPT-SoVITS synthesis settings are incomplete or invalid.".into(),
        ));
    }
    let endpoint = gpt_sovits_endpoint(&request.base_url)?;
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|_| CommandError::Network("Unable to initialize GPT-SoVITS networking.".into()))?
        .post(endpoint)
        .json(&serde_json::json!({
            "text": request.text,
            "text_lang": request.text_lang,
            "ref_audio_path": request.ref_audio_path,
            "prompt_text": request.prompt_text,
            "prompt_lang": request.prompt_lang,
            // Speed: the client already splits the reply into sentence chunks,
            // so the server must not re-split it (cut0) and must not insert the
            // default 0.3s silence between fragments.
            "text_split_method": "cut0",
            "fragment_interval": 0.0,
            "batch_size": request.batch_size.unwrap_or(8).clamp(1, 256),
            "batch_threshold": 0.3,
            "parallel_infer": true,
            "use_cuda_graph": true,
            "split_bucket": true,
            "media_type": "wav"
        }))
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                CommandError::Synthesis("GPT-SoVITS synthesis timed out.".into())
            } else {
                CommandError::Network("Unable to reach the local GPT-SoVITS service.".into())
            }
        })?;
    if !response.status().is_success() {
        return Err(CommandError::Synthesis(
            "GPT-SoVITS rejected the synthesis request.".into(),
        ));
    }
    let audio = response.bytes().await.map_err(|_| {
        CommandError::Synthesis("GPT-SoVITS returned unreadable audio.".into())
    })?;
    if audio.len() < 44
        || audio.len() > MAX_AUDIO_BYTES
        || &audio[0..4] != b"RIFF"
        || &audio[8..12] != b"WAVE"
    {
        return Err(CommandError::Synthesis(
            "GPT-SoVITS returned malformed or oversized WAV audio.".into(),
        ));
    }
    Ok(audio.to_vec())
}

fn valid_language(language: &str) -> bool {
    !language.is_empty()
        && language.len() <= 32
        && language
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-' || byte == b'_')
}

#[tauri::command(rename = "voice:synthesize")]
async fn voice_synthesize(
    state: State<'_, VoiceSynthesisRequests>,
    request: GPTSoVITSRequest,
) -> Result<Vec<u8>, CommandError> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CommandError::Configuration(
            "Invalid GPT-SoVITS request identifier.".into(),
        ));
    }
    let request_id = request.request_id.clone();
    let task = {
        let mut requests = state
            .0
            .lock()
            .map_err(|_| CommandError::Synthesis("Synthesis state is unavailable.".into()))?;
        if requests.contains_key(&request_id) {
            return Err(CommandError::Configuration(
                "GPT-SoVITS request identifier is already active.".into(),
            ));
        }
        let task = tokio::spawn(send_gpt_sovits_request(request));
        requests.insert(request_id.clone(), task.abort_handle());
        task
    };
    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            Err(CommandError::Synthesis("Synthesis cancelled.".into()))
        }
        Err(_) => Err(CommandError::Synthesis(
            "GPT-SoVITS synthesis stopped unexpectedly.".into(),
        )),
    };
    if let Ok(mut requests) = state.0.lock() {
        requests.remove(&request_id);
    }
    result
}

#[tauri::command(rename = "voice:cancel_synthesis")]
fn voice_cancel_synthesis(
    state: State<'_, VoiceSynthesisRequests>,
    request_id: String,
) -> Result<(), CommandError> {
    let abort = state
        .0
        .lock()
        .map_err(|_| CommandError::Synthesis("Synthesis state is unavailable.".into()))?
        .remove(&request_id);
    if let Some(abort) = abort {
        abort.abort();
    }
    Ok(())
}

const WHISPER_PORT: u16 = 8000;
const SOVITS_PORT: u16 = 9880;
const CONDA_HOOK: &str = r#"for candidate in "$HOME/miniconda3" "$HOME/anaconda3" "$HOME/miniforge3" "/opt/conda"; do
  if [ -f "$candidate/etc/profile.d/conda.sh" ]; then . "$candidate/etc/profile.d/conda.sh"; break; fi
done
"#;

#[derive(Debug, Serialize)]
struct VoiceServiceStatus {
    whisper: bool,
    sovits: bool,
}

fn port_open(port: u16) -> bool {
    let address = std::net::SocketAddr::from(([127, 0, 0, 1], port));
    TcpStream::connect_timeout(&address, Duration::from_millis(150)).is_ok()
}

fn run_wsl(script: &str) -> Result<(), CommandError> {
    let mut command = Command::new("wsl.exe");
    command
        .arg("-e")
        .arg("bash")
        .arg("-lc")
        .arg(script)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
    }
    command.spawn().map(|_| ()).map_err(|error| {
        CommandError::Configuration(format!("Unable to launch WSL: {error}"))
    })
}

/// Starts Whisper or GPT-SoVITS inside WSL. Both services detach from the
/// launching shell, so they survive after the WSL invocation returns.
fn start_voice_service(service: &str) -> Result<(), CommandError> {
    let script = match service {
        "whisper" => format!(
            "{CONDA_HOOK}conda activate GPTSoVits >/dev/null 2>&1\n\
             LOG=/tmp/ice-whisper.log\n\
             for dir in /mnt/d/workplace/codex/ice-wisper-service /mnt/d/workplace/ice-wisper-service; do\n\
               if [ -d \"$dir\" ]; then\n\
                 cd \"$dir\" && setsid nohup uvicorn server:app --host 127.0.0.1 --port {WHISPER_PORT} >>\"$LOG\" 2>&1 </dev/null &\n\
                 disown 2>/dev/null\n\
                 sleep 2\n\
                 echo \"started whisper from $dir\" >>\"$LOG\"\n\
                 exit 0\n\
               fi\n\
             done\n\
             echo \"whisper service directory not found\" >>\"$LOG\"\n"
        ),
        "sovits" => format!(
            "{CONDA_HOOK}conda activate GPTSoVits >/dev/null 2>&1\n\
             LOG=/tmp/ice-sovits.log\n\
             for dir in /mnt/d/workplace/codex/GPT-SoVITS-main /mnt/d/workplace/GPT-SoVITS-main; do\n\
               if [ -d \"$dir\" ]; then\n\
                 cd \"$dir\" || continue\n\
                 CFG=\"\"\n\
                 [ -f my_config.yaml ] && CFG=\"-c my_config.yaml\"\n\
                 setsid nohup python api_v2.py $CFG --batch_size=16 --batch_threshold=0.3 --parallel_infer=true --use_cuda_graph=true --split_bucket=true >>\"$LOG\" 2>&1 </dev/null &\n\
                 disown 2>/dev/null\n\
                 sleep 3\n\
                 echo \"started GPT-SoVITS from $dir\" >>\"$LOG\"\n\
                 exit 0\n\
               fi\n\
             done\n\
             echo \"GPT-SoVITS directory not found\" >>\"$LOG\"\n"
        ),
        _ => {
            return Err(CommandError::Configuration(
                "Unknown voice service.".into(),
            ));
        }
    };
    run_wsl(&script)
}

#[tauri::command(rename = "voice:services_status")]
fn voice_services_status() -> VoiceServiceStatus {
    VoiceServiceStatus {
        whisper: port_open(WHISPER_PORT),
        sovits: port_open(SOVITS_PORT),
    }
}

#[tauri::command(rename = "voice:service_start")]
fn voice_service_start(service: String) -> Result<(), CommandError> {
    let running = match service.as_str() {
        "whisper" => port_open(WHISPER_PORT),
        "sovits" => port_open(SOVITS_PORT),
        _ => {
            return Err(CommandError::Configuration(
                "Unknown voice service.".into(),
            ));
        }
    };
    if running {
        return Ok(());
    }
    start_voice_service(&service)
}

#[tauri::command(rename = "voice:service_stop")]
fn voice_service_stop(service: String) -> Result<(), CommandError> {
    let pattern = match service.as_str() {
        "whisper" => "uvicorn server:app",
        "sovits" => "api_v2.py",
        _ => {
            return Err(CommandError::Configuration(
                "Unknown voice service.".into(),
            ));
        }
    };
    let script = format!("pkill -f '{pattern}' >/dev/null 2>&1 || true");
    run_wsl(&script)
}

async fn send_whisper_request(request: WhisperRequest) -> Result<VoiceTranscription, CommandError> {
    const MAX_AUDIO_BYTES: usize = 25 * 1024 * 1024;
    let endpoint = whisper_endpoint(&request.base_url)?;
    if request.model.trim().is_empty()
        || request.model.len() > 128
        || !request
            .model
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || b"._-/".contains(&byte))
    {
        return Err(CommandError::Configuration(
            "Enter a valid Whisper model name.".into(),
        ));
    }
    if request.data.is_empty() || request.data.len() > MAX_AUDIO_BYTES {
        return Err(CommandError::Recognition(
            "The recording is empty or exceeds the 25 MiB limit.".into(),
        ));
    }
    let mime_type = request
        .content_type
        .split(';')
        .next()
        .unwrap_or_default()
        .trim();
    if !matches!(mime_type, "audio/webm" | "audio/wav") {
        return Err(CommandError::Recognition(
            "The microphone audio format is unsupported.".into(),
        ));
    }
    let filename = if mime_type == "audio/wav" {
        "recording.wav"
    } else {
        "recording.webm"
    };
    let boundary = format!("iceagent{}", request.request_id.replace('-', ""));
    let mut body = Vec::with_capacity(request.data.len() + request.model.len() + 512);
    for (name, value) in [("model", request.model.as_str()), ("language", "zh")] {
        body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"{name}\"\r\n\r\n{value}\r\n").as_bytes());
    }
    body.extend_from_slice(format!("--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"{filename}\"\r\nContent-Type: {mime_type}\r\n\r\n").as_bytes());
    body.extend_from_slice(&request.data);
    body.extend_from_slice(format!("\r\n--{boundary}--\r\n").as_bytes());
    let response = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(90))
        .build()
        .map_err(|_| CommandError::Network("Unable to initialize Whisper networking.".into()))?
        .post(endpoint)
        .header(
            reqwest::header::CONTENT_TYPE,
            format!("multipart/form-data; boundary={boundary}"),
        )
        .body(body)
        .send()
        .await
        .map_err(|error| {
            if error.is_timeout() {
                CommandError::Network("Whisper transcription timed out.".into())
            } else {
                CommandError::Network("Unable to reach the local Whisper service.".into())
            }
        })?;
    if !response.status().is_success() {
        return Err(CommandError::Recognition(
            "The Whisper service rejected the recording.".into(),
        ));
    }
    let result: WhisperResponse = response.json().await.map_err(|_| {
        CommandError::Recognition("The Whisper service returned an invalid response.".into())
    })?;
    let segments = result
        .segments
        .unwrap_or_default()
        .into_iter()
        .map(|segment| VoiceTranscriptionSegment {
            text: segment.text,
            start_ms: (segment.start.max(0.0) * 1000.0).round() as u64,
            end_ms: (segment.end.max(0.0) * 1000.0).round() as u64,
        })
        .collect();
    Ok(VoiceTranscription {
        text: result.text,
        language: result.language.unwrap_or_else(|| "zh".into()),
        confidence: None,
        segments,
    })
}

#[tauri::command(rename = "voice:transcribe")]
async fn voice_transcribe(
    state: State<'_, VoiceTranscriptionRequests>,
    request: WhisperRequest,
) -> Result<VoiceTranscription, CommandError> {
    if request.request_id.is_empty()
        || request.request_id.len() > 128
        || !request
            .request_id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
    {
        return Err(CommandError::Configuration(
            "Invalid Whisper request identifier.".into(),
        ));
    }
    let request_id = request.request_id.clone();
    let task = {
        let mut requests = state
            .0
            .lock()
            .map_err(|_| CommandError::Recognition("Transcription state is unavailable.".into()))?;
        if requests.contains_key(&request_id) {
            return Err(CommandError::Configuration(
                "Whisper request identifier is already active.".into(),
            ));
        }
        let task = tokio::spawn(send_whisper_request(request));
        requests.insert(request_id.clone(), task.abort_handle());
        task
    };
    let result = match task.await {
        Ok(result) => result,
        Err(error) if error.is_cancelled() => {
            Err(CommandError::Recognition("Transcription cancelled.".into()))
        }
        Err(_) => Err(CommandError::Recognition(
            "Whisper transcription stopped unexpectedly.".into(),
        )),
    };
    if let Ok(mut requests) = state.0.lock() {
        requests.remove(&request_id);
    }
    result
}

#[tauri::command(rename = "voice:cancel_transcription")]
fn voice_cancel_transcription(
    state: State<'_, VoiceTranscriptionRequests>,
    request_id: String,
) -> Result<(), CommandError> {
    let abort = state
        .0
        .lock()
        .map_err(|_| CommandError::Recognition("Transcription state is unavailable.".into()))?
        .remove(&request_id);
    if let Some(abort) = abort {
        abort.abort();
    }
    Ok(())
}

#[tauri::command(rename = "audio:save_capture")]
fn audio_save_capture(app: AppHandle, data: Vec<u8>) -> Result<String, CommandError> {
    let directory = app
        .path()
        .app_data_dir()
        .map_err(|error| CommandError::Audio(error.to_string()))?
        .join("audio-tests");
    std::fs::create_dir_all(&directory).map_err(|error| CommandError::Audio(error.to_string()))?;
    let timestamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| CommandError::Audio(error.to_string()))?
        .as_millis();
    let path = directory.join(format!("microphone-{timestamp}.webm"));
    std::fs::write(&path, data).map_err(|error| CommandError::Audio(error.to_string()))?;
    Ok(path.to_string_lossy().into_owned())
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

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BalanceInfo {
    currency: String,
    total_balance: String,
    granted_balance: String,
    topped_up_balance: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct BalanceResponse {
    is_available: bool,
    balance_infos: Vec<BalanceInfo>,
}

#[derive(Debug, Serialize)]
struct UsageRecord {
    ts: u64,
    prompt: u64,
    completion: u64,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct UsageResponse {
    input_rate: f64,
    output_rate: f64,
    records: Vec<UsageRecord>,
}

/// Local usage log written by `ai:stream`; DeepSeek exposes no usage history API.
#[tauri::command(rename = "ai:usage")]
async fn ai_usage(app: AppHandle) -> Result<UsageResponse, CommandError> {
    const INPUT_RATE: f64 = 2.0;
    const OUTPUT_RATE: f64 = 8.0;
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let cutoff = now.saturating_sub(30 * 24 * 3600);
    let mut records = Vec::new();
    if let Ok(dir) = app.path().app_data_dir() {
        if let Ok(text) = std::fs::read_to_string(dir.join("usage.jsonl")) {
            for line in text.lines() {
                if let Ok(value) = serde_json::from_str::<serde_json::Value>(line) {
                    let ts = value.get("ts").and_then(|item| item.as_u64()).unwrap_or(0);
                    if ts < cutoff {
                        continue;
                    }
                    records.push(UsageRecord {
                        ts,
                        prompt: value.get("prompt").and_then(|item| item.as_u64()).unwrap_or(0),
                        completion: value
                            .get("completion")
                            .and_then(|item| item.as_u64())
                            .unwrap_or(0),
                    });
                }
            }
        }
    }
    Ok(UsageResponse {
        input_rate: INPUT_RATE,
        output_rate: OUTPUT_RATE,
        records,
    })
}

#[tauri::command(rename = "ai:balance")]
async fn ai_balance(base_url: Option<String>) -> Result<BalanceResponse, CommandError> {
    let key = secure_store_get("deepseek_api_key".into())?.ok_or_else(|| {
        CommandError::Configuration("Configure an API key in Chat Configuration first.".into())
    })?;
    let base = base_url
        .unwrap_or_else(|| "https://api.deepseek.com".into())
        .trim_end_matches('/')
        .trim_end_matches("/chat/completions")
        .to_string();
    if !(base.starts_with("https://") || base.starts_with("http://")) {
        return Err(CommandError::Configuration("Enter a valid base URL.".into()));
    }
    let response = reqwest::Client::new()
        .get(format!("{base}/user/balance"))
        .bearer_auth(key)
        .timeout(std::time::Duration::from_secs(15))
        .send()
        .await
        .map_err(|_| CommandError::Network("Unable to reach the billing service.".into()))?;
    if !response.status().is_success() {
        return Err(CommandError::Network(format!(
            "Billing service returned {}.",
            response.status().as_u16()
        )));
    }
    let payload: serde_json::Value = response
        .json()
        .await
        .map_err(|_| CommandError::Network("Unable to read the balance response.".into()))?;
    let infos = payload
        .get("balance_infos")
        .and_then(|value| value.as_array())
        .map(|items| {
            items
                .iter()
                .map(|item| BalanceInfo {
                    currency: item.get("currency").and_then(|v| v.as_str()).unwrap_or("CNY").to_string(),
                    total_balance: item.get("total_balance").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
                    granted_balance: item.get("granted_balance").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
                    topped_up_balance: item.get("topped_up_balance").and_then(|v| v.as_str()).unwrap_or("0").to_string(),
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    Ok(BalanceResponse {
        is_available: payload.get("is_available").and_then(|v| v.as_bool()).unwrap_or(false),
        balance_infos: infos,
    })
}

#[tauri::command(rename = "ai:stream")]
async fn ai_stream(app: AppHandle, request: ChatRequest) -> Result<Vec<BackendChunk>, CommandError> {
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
    let response = reqwest::Client::new().post(format!("{base}/chat/completions")).bearer_auth(key).timeout(std::time::Duration::from_secs(30)).json(&serde_json::json!({"model": request.model, "messages": request.messages, "temperature": request.temperature, "max_tokens": request.max_output_tokens, "stream": true, "stream_options": {"include_usage": true}})).send().await.map_err(|_| CommandError::Network("Unable to reach the AI service.".into()))?;
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
        if let Some(usage) = parsed.get("usage").filter(|value| !value.is_null()) {
            let prompt = usage.get("prompt_tokens").and_then(|value| value.as_u64()).unwrap_or(0);
            let completion = usage
                .get("completion_tokens")
                .and_then(|value| value.as_u64())
                .unwrap_or(0);
            if prompt + completion > 0 {
                let ts = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                if let Ok(dir) = app.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    let line = format!(
                        "{{\"ts\":{ts},\"prompt\":{prompt},\"completion\":{completion}}}\n"
                    );
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("usage.jsonl"))
                    {
                        let _ = std::io::Write::write_all(&mut file, line.as_bytes());
                    }
                }
            }
        }
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

#[derive(Default)]
struct TaskBuffer {
    pid: Option<u32>,
    events: Vec<serde_json::Value>,
}

#[derive(Default)]
struct TaskRunState(std::sync::Mutex<TaskBuffer>);

/// Resolves the `dsh` launcher from PATH (npm shims resolve to a .cmd on Windows).
fn task_log(app: &AppHandle, message: &str) {
    if let Ok(dir) = app.path().app_data_dir() {
        let _ = std::fs::create_dir_all(&dir);
        if let Ok(mut file) = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("ice-task.log"))
        {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map(|value| value.as_millis())
                .unwrap_or_default();
            let _ = std::io::Write::write_all(&mut file, format!("[{stamp}] {message}\n").as_bytes());
        }
    }
}

fn resolve_dsh() -> Result<String, CommandError> {
    #[cfg(windows)]
    {
        let output = std::process::Command::new("cmd")
            .args(["/C", "where", "dsh"])
            .creation_flags(CREATE_NO_WINDOW)
            .output()
            .map_err(|_| CommandError::Configuration("Unable to run `where dsh`.".into()))?;
        let text = String::from_utf8_lossy(&output.stdout);
        let mut fallback = None;
        for line in text.lines().map(str::trim).filter(|line| !line.is_empty()) {
            if line.to_ascii_lowercase().ends_with(".cmd") {
                return Ok(line.to_string());
            }
            fallback.get_or_insert(line.to_string());
        }
        if let Some(path) = fallback {
            return Ok(path);
        }
        Err(CommandError::Configuration(
            "`dsh` was not found on PATH. Install DeepSeek Harness or add it to PATH.".into(),
        ))
    }
    #[cfg(not(windows))]
    {
        Ok("dsh".to_string())
    }
}

#[tauri::command(rename = "task:start")]
async fn task_start(
    app: AppHandle,
    state: State<'_, TaskRunState>,
    prompt: String,
    session_id: Option<String>,
    workspace: Option<String>,
) -> Result<serde_json::Value, CommandError> {
    task_log(&app, &format!("task_start invoked, prompt len={}", prompt.len()));
    if prompt.trim().is_empty() {
        return Err(CommandError::Configuration("Task prompt is empty.".into()));
    }
    let key = secure_store_get("deepseek_api_key".into())?.ok_or_else(|| {
        CommandError::Configuration(
            "Configure the DeepSeek API key in Chat Configuration before running tasks.".into(),
        )
    })?;
    task_log(&app, "deepseek key ok");
    let dsh = match resolve_dsh() {
        Ok(path) => {
            task_log(&app, &format!("resolved dsh: {path}"));
            path
        }
        Err(error) => {
            task_log(&app, &format!("resolve dsh failed: {error}"));
            return Err(error);
        }
    };
    let cwd = workspace.unwrap_or_else(|| "D:\\codex\\workspace".to_string());
    std::fs::create_dir_all(&cwd).map_err(|error| {
        CommandError::Configuration(format!("Unable to create the task workspace: {error}"))
    })?;
    let mut args: Vec<String> = vec!["--profile".into(), "headless".into(), "--json".into()];
    if let Some(id) = session_id.filter(|value| !value.trim().is_empty()) {
        args.push("--session-id".into());
        args.push(id);
    }
    // The Electron-based dsh shim does not reliably read a piped stdin, so the
    // task goes in as one positional argument with newlines flattened.
    args.push(prompt.split_whitespace().collect::<Vec<_>>().join(" "));

    let mut command = std::process::Command::new("cmd");
    command
        .arg("/C")
        .arg(&dsh)
        .args(&args)
        .current_dir(&cwd)
        .env("DEEPSEEK_API_KEY", key)
        .stdin(std::process::Stdio::null())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .creation_flags(CREATE_NO_WINDOW);
    let mut child = match command.spawn() {
        Ok(child) => child,
        Err(error) => {
            task_log(&app, &format!("spawn failed: {error}"));
            return Err(CommandError::Configuration(format!("Unable to start dsh: {error}")));
        }
    };
    task_log(&app, &format!("spawned dsh pid={}", child.id()));
    let pid = child.id();
    {
        let mut guard = state
            .0
            .lock()
            .map_err(|_| CommandError::Configuration("Task state is unavailable.".into()))?;
        guard.pid = Some(pid);
        guard.events.clear();
    }

    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let app_handle = app.clone();
    std::thread::spawn(move || {
        let err_handle = app_handle.clone();
        let err_thread = std::thread::spawn(move || {
            if let Some(err) = stderr {
                use std::io::BufRead as _;
                for line in std::io::BufReader::new(err).lines().map_while(Result::ok) {
                    if line.trim().is_empty() {
                        continue;
                    }
                    if let Some(handle) = err_handle.try_state::<TaskRunState>() {
                        let _ = handle;
                    }
                    task_log(&err_handle, &format!("stderr: {line}"));
                    let _ = err_handle.emit(
                        "task:event",
                        serde_json::json!({ "type": "stderr", "text": line }),
                    );
                }
            }
        });
        if let Some(out) = stdout {
            use std::io::BufRead as _;
            for line in std::io::BufReader::new(out).lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                if let Ok(dir) = app_handle.path().app_data_dir() {
                    let _ = std::fs::create_dir_all(&dir);
                    if let Ok(mut file) = std::fs::OpenOptions::new()
                        .create(true)
                        .append(true)
                        .open(dir.join("ice-task.log"))
                    {
                        let _ = std::io::Write::write_all(&mut file, format!("{line}\n").as_bytes());
                    }
                }
                let event = serde_json::from_str::<serde_json::Value>(&line)
                    .unwrap_or_else(|_| serde_json::json!({ "type": "raw", "text": line }));
                if let Some(task_state) = app_handle.try_state::<TaskRunState>() {
                    if let Ok(mut guard) = task_state.0.lock() {
                        guard.events.push(event.clone());
                        if guard.events.len() > 4000 {
                            guard.events.drain(0..1000);
                        }
                    }
                }
                let _ = app_handle.emit("task:event", event);
            }
        }
        let _ = err_thread.join();
        let code = child
            .wait()
            .ok()
            .and_then(|status| status.code())
            .unwrap_or(-1);
        task_log(&app_handle, &format!("dsh exited code={code}"));
        let exit_event = serde_json::json!({ "type": "exit", "code": code });
        if let Some(task_state) = app_handle.try_state::<TaskRunState>() {
            if let Ok(mut guard) = task_state.0.lock() {
                guard.events.push(exit_event.clone());
                guard.pid = None;
            }
        }
        let _ = app_handle.emit("task:event", exit_event);
    });

    Ok(serde_json::json!({ "pid": pid, "workspace": cwd }))
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct TaskPoll {
    events: Vec<serde_json::Value>,
    running: bool,
    cursor: usize,
}

/// Polling transport: works without the core event permission.
#[tauri::command(rename = "task:poll")]
fn task_poll(state: State<'_, TaskRunState>, since: usize) -> Result<TaskPoll, CommandError> {
    let guard = state
        .0
        .lock()
        .map_err(|_| CommandError::Configuration("Task state is unavailable.".into()))?;
    let start = since.min(guard.events.len());
    Ok(TaskPoll {
        events: guard.events[start..].to_vec(),
        running: guard.pid.is_some(),
        cursor: guard.events.len(),
    })
}

#[tauri::command(rename = "task:stop")]
fn task_stop(state: State<'_, TaskRunState>) -> Result<(), CommandError> {
    let pid = state
        .0
        .lock()
        .map_err(|_| CommandError::Configuration("Task state is unavailable.".into()))?
        .pid;
    if let Some(pid) = pid {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .creation_flags(CREATE_NO_WINDOW)
            .status();
    }
    Ok(())
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

#[tauri::command(rename = "window:drag_current")]
fn window_drag_current(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .start_dragging()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

/// Resizes the desktop pet while keeping it anchored to the bottom-right corner.
const PET_BASE_WIDTH: f64 = 300.0;
const PET_BASE_RATIO: f64 = 0.45;
const MENU_WIDTH: f64 = 172.0;
const MENU_HEIGHT: f64 = 240.0;
const FLYOUT_WIDTH: f64 = 150.0;
const FLYOUT_HEIGHT: f64 = 230.0;
const MENU_GAP: f64 = 10.0;
const PET_MAX_SCALE: f64 = 1.6;

/// Current pet state: the window rectangle never changes after startup, only the
/// character box inside it, so opening the menu cannot resize anything.
#[derive(Clone, Copy)]
struct PetState {
    scale: f64,
    menu_open: bool,
    pet_width: f64,
    pet_height: f64,
}

struct PetWindowState(Mutex<PetState>);

impl Default for PetWindowState {
    fn default() -> Self {
        Self(Mutex::new(PetState {
            scale: 1.0,
            menu_open: false,
            pet_width: PET_BASE_WIDTH,
            pet_height: (PET_BASE_WIDTH * 1.62).round(),
        }))
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PetBox {
    width: f64,
    height: f64,
}

#[cfg(windows)]
fn cursor_position() -> Option<(i32, i32)> {
    #[repr(C)]
    struct Point {
        x: i32,
        y: i32,
    }
    #[link(name = "user32")]
    extern "system" {
        fn GetCursorPos(point: *mut Point) -> i32;
    }
    let mut point = Point { x: 0, y: 0 };
    let ok = unsafe { GetCursorPos(&mut point) };
    if ok == 0 {
        None
    } else {
        Some((point.x, point.y))
    }
}

/// Keeps the pet clickable while letting the transparent area fall through to
/// the desktop: the window ignores cursor events unless the pointer is over the
/// character (or the menu is open).
#[cfg(windows)]
fn start_pet_hit_test(app: AppHandle) {
    std::thread::spawn(move || {
        let mut interactive = true;
        loop {
            std::thread::sleep(std::time::Duration::from_millis(40));
            let Some(window) = app.get_webview_window(MAIN_WINDOW) else {
                continue;
            };
            let (pet_width, pet_height, menu_open) = {
                let state = app.state::<PetWindowState>();
                let Ok(guard) = state.0.lock() else { continue };
                (guard.pet_width, guard.pet_height, guard.menu_open)
            };
            let (Ok(position), Ok(size), Some(cursor)) = (
                window.outer_position(),
                window.outer_size(),
                cursor_position(),
            ) else {
                continue;
            };
            let factor = window.scale_factor().unwrap_or(1.0).max(0.5);
            let window_width = size.width as f64 / factor;
            let window_height = size.height as f64 / factor;
            let local_x = (cursor.0 - position.x) as f64 / factor;
            let local_y = (cursor.1 - position.y) as f64 / factor;
            let over_pet = local_x >= window_width - pet_width
                && local_x <= window_width
                && local_y >= window_height - pet_height
                && local_y <= window_height;
            let next = menu_open || over_pet;
            if next != interactive {
                interactive = next;
                let _ = window.set_ignore_cursor_events(!next);
            }
        }
    });
}

#[cfg(windows)]
fn apply_window_rect(
    window: &WebviewWindow,
    x: i32,
    y: i32,
    width: i32,
    height: i32,
) -> Result<(), CommandError> {
    #[link(name = "user32")]
    extern "system" {
        fn SetWindowPos(
            hwnd: isize,
            insert_after: isize,
            x: i32,
            y: i32,
            cx: i32,
            cy: i32,
            flags: u32,
        ) -> i32;
    }
    // HWND_TOP / SWP_NOZORDER keeps the pet's stacking, SWP_NOACTIVATE avoids focus steals.
    const SWP_NOZORDER: u32 = 0x0004;
    const SWP_NOACTIVATE: u32 = 0x0010;
    let hwnd = window
        .hwnd()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
    let ok = unsafe {
        SetWindowPos(
            hwnd.0 as isize,
            0,
            x,
            y,
            width,
            height,
            SWP_NOZORDER | SWP_NOACTIVATE,
        )
    };
    if ok == 0 {
        return Err(CommandError::WindowOperation(
            "Unable to reposition the pet window.".into(),
        ));
    }
    Ok(())
}

/// Fixed window rectangle: big enough for the character plus the menu, so the
/// menu never resizes or repositions the window.
fn fixed_window_box(area: &tauri::PhysicalRect<i32, u32>, factor: f64) -> (f64, f64) {
    let logical_height = area.size.height as f64 / factor;
    let width = (PET_BASE_WIDTH * PET_MAX_SCALE) + MENU_WIDTH + FLYOUT_WIDTH + MENU_GAP * 2.0;
    let height = (logical_height * PET_BASE_RATIO * PET_MAX_SCALE)
        .max(MENU_HEIGHT + FLYOUT_HEIGHT + MENU_GAP)
        .round();
    (width, height)
}

/// Recomputes the character box for the current scale and remembers it.
fn compute_pet_box(window: &WebviewWindow, state: &mut PetState) -> PetBox {
    let pet_width = (PET_BASE_WIDTH * state.scale).round();
    let pet_height = match window.current_monitor() {
        Ok(Some(monitor)) => {
            let factor = monitor.scale_factor();
            let area = monitor.work_area();
            ((area.size.height as f64 / factor) * PET_BASE_RATIO * state.scale).round()
        }
        _ => (PET_BASE_WIDTH * 1.62 * state.scale).round(),
    };
    state.pet_width = pet_width;
    state.pet_height = pet_height;
    PetBox {
        width: pet_width,
        height: pet_height,
    }
}

/// Positions the fixed-size window in the bottom-right corner of the work area.
fn apply_pet_window(window: &WebviewWindow, state: &mut PetState) -> Result<PetBox, CommandError> {
    let pet_box = compute_pet_box(window, state);
    let Ok(Some(monitor)) = window.current_monitor() else {
        return Ok(pet_box);
    };
    let factor = monitor.scale_factor();
    let area = monitor.work_area();
    let (win_width, win_height) = fixed_window_box(&area, factor);
    let margin = (10.0 * factor).round() as i32;
    let x = area.position.x + area.size.width as i32 - (win_width * factor).round() as i32 - margin;
    let y = area.position.y + area.size.height as i32 - (win_height * factor).round() as i32 - margin;
    let physical_width = (win_width * factor).round() as i32;
    let physical_height = (win_height * factor).round() as i32;
    #[cfg(windows)]
    {
        apply_window_rect(window, x, y, physical_width, physical_height)?;
    }
    #[cfg(not(windows))]
    {
        window
            .set_size(tauri::LogicalSize::new(win_width, win_height))
            .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
        window
            .set_position(tauri::PhysicalPosition::new(x, y))
            .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
    }
    Ok(pet_box)
}

#[tauri::command(rename = "window:set_pet_scale")]
fn window_set_pet_scale(
    app: AppHandle,
    state: State<'_, PetWindowState>,
    scale: f64,
) -> Result<PetBox, CommandError> {
    let window = main_window(&app)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| CommandError::WindowOperation("Pet window state is unavailable.".into()))?;
    guard.scale = scale.clamp(0.55, 1.6);
    // No window resize: the character just changes size inside the fixed window.
    Ok(compute_pet_box(&window, &mut guard))
}

#[tauri::command(rename = "window:set_menu_open")]
fn window_set_menu_open(
    app: AppHandle,
    state: State<'_, PetWindowState>,
    open: bool,
) -> Result<PetBox, CommandError> {
    let window = main_window(&app)?;
    let mut guard = state
        .0
        .lock()
        .map_err(|_| CommandError::WindowOperation("Pet window state is unavailable.".into()))?;
    guard.menu_open = open;
    Ok(compute_pet_box(&window, &mut guard))
}

#[tauri::command(rename = "window:minimize_current")]
fn window_minimize_current(window: WebviewWindow) -> Result<(), CommandError> {
    window
        .minimize()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))
}

#[tauri::command(rename = "window:toggle_maximize_current")]
fn window_toggle_maximize_current(window: WebviewWindow) -> Result<bool, CommandError> {
    let maximized = window
        .is_maximized()
        .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
    if maximized {
        window
            .unmaximize()
            .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
        Ok(false)
    } else {
        window
            .maximize()
            .map_err(|error| CommandError::WindowOperation(error.to_string()))?;
        Ok(true)
    }
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
    // Settings and configuration behave like a regular folder window; the chat
    // panel stays a compact drawer next to the pet.
    let (panel_width, panel_height, min_width, min_height, docked) = match panel.as_str() {
        "settings" => (1120.0, 700.0, 760.0, 520.0, false),
        "chat-config" => (640.0, 660.0, 480.0, 460.0, false),
        _ => (480.0, 680.0, 400.0, 480.0, true),
    };
    let app_for_builder = app.clone();
    let created = tauri::async_runtime::spawn_blocking(move || {
        WebviewWindowBuilder::new(
            &app_for_builder,
            label,
            WebviewUrl::App("index.html".into()),
        )
        .title(title)
        .inner_size(panel_width, panel_height)
        .min_inner_size(min_width, min_height)
        .decorations(false)
        .transparent(true)
        .shadow(false)
        // The chat drawer floats above the desktop with the pet; settings and
        // configuration behave like normal windows.
        .always_on_top(docked)
        .resizable(true)
        .maximizable(true)
        .focused(true)
        .build()
    })
    .await
    .map_err(|error| CommandError::WindowOperation(error.to_string()))?
    .map_err(|error| CommandError::WindowOperation(error.to_string()))?;

    // The chat drawer hugs the pet; the larger windows open centred like Explorer.
    if let Some(main) = app.get_webview_window(MAIN_WINDOW) {
        if let (Ok(main_position), Ok(main_size), Ok(panel_size)) = (
            main.outer_position(),
            main.outer_size(),
            created.outer_size(),
        ) {
            let mut x = main_position.x - panel_size.width as i32 - 10;
            let mut y = main_position.y + main_size.height as i32 - panel_size.height as i32;
            if let Ok(Some(monitor)) = main.current_monitor() {
                let area = monitor.work_area();
                if !docked {
                    x = area.position.x + (area.size.width as i32 - panel_size.width as i32) / 2;
                    y = area.position.y + (area.size.height as i32 - panel_size.height as i32) / 2;
                }
                let min_x = area.position.x + 10;
                let min_y = area.position.y + 10;
                let max_x = area.position.x + area.size.width as i32 - panel_size.width as i32 - 10;
                x = x.max(min_x).min(max_x);
                y = y.max(min_y);
            }
            let _ = created.set_position(tauri::PhysicalPosition::new(x, y));
        }
    }
    Ok(())
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

/// Appends a line to `%LOCALAPPDATA%\\com.iceagent.desktop\\startup.log`.
///
/// A packaged Windows build runs under the `windows` subsystem, so a startup
/// failure leaves no console output at all: the app simply "does not open".
/// This log is the only way to tell an invisible window from a process that
/// never started.
fn startup_log(message: &str) {
    use std::io::Write;

    let Some(base) = std::env::var_os("LOCALAPPDATA") else {
        return;
    };
    let directory = std::path::PathBuf::from(base).join("com.iceagent.desktop");
    let _ = std::fs::create_dir_all(&directory);
    let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(directory.join("startup.log"))
    else {
        return;
    };
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or_default();
    let _ = writeln!(file, "[{stamp}] {message}");
}

pub fn run() {
    std::panic::set_hook(Box::new(|info| {
        startup_log(&format!("panic: {info}"));
    }));
    startup_log("startup: launching Ice Agent");

    let result = tauri::Builder::default()
        .manage(VoiceTranscriptionRequests::default())
        .manage(VoiceSynthesisRequests::default())
        .manage(PetWindowState::default())
        .manage(TaskRunState::default())
        .setup(|app| {
            if let Some(window) = app.get_webview_window(MAIN_WINDOW) {
                window.set_min_size(Some(tauri::LogicalSize::new(120.0, 1.0)))?;
                {
                    let state = app.state::<PetWindowState>();
                    let mut guard = state
                        .0
                        .lock()
                        .map_err(|_| "Pet window state is unavailable.".to_string())?;
                    apply_pet_window(&window, &mut guard)
                        .map_err(|error| error.to_string())?;
                }
                startup_log("setup: pet window uses the fixed menu-sized box");
                #[cfg(windows)]
                start_pet_hit_test(app.handle().clone());
            } else {
                startup_log("setup: main window is missing");
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
            window_drag_current,
            window_set_pet_scale,
            task_start,
            task_poll,
            task_stop,
            window_set_menu_open,
            window_minimize_current,
            window_toggle_maximize_current,
            window_open_panel,
            app_get_info,
            secure_store_get,
            secure_store_set,
            secure_store_remove,
            ai_test_connection,
            ai_stream,
            ai_balance,
            ai_usage,
            memory_initialize,
            audio_save_capture,
            voice_transcribe,
            voice_cancel_transcription,
            voice_synthesize,
            voice_cancel_synthesis,
            voice_services_status,
            voice_service_start,
            voice_service_stop
        ])
        .run(tauri::generate_context!());

    match result {
        Ok(()) => startup_log("startup: event loop ended"),
        Err(error) => {
            startup_log(&format!("startup: failed to run: {error}"));
            panic!("error while running Ice Agent: {error}");
        }
    }
}

#[cfg(test)]
mod tests {
    use super::{gpt_sovits_endpoint, whisper_endpoint, CommandError};

    #[test]
    fn whisper_endpoint_only_accepts_loopback_http_origins() {
        assert_eq!(
            whisper_endpoint("http://127.0.0.1:8000").unwrap().as_str(),
            "http://127.0.0.1:8000/v1/audio/transcriptions"
        );
        assert_eq!(
            whisper_endpoint("http://localhost:8000/").unwrap().as_str(),
            "http://localhost:8000/v1/audio/transcriptions"
        );
        assert!(whisper_endpoint("https://127.0.0.1:8000").is_err());
        assert!(whisper_endpoint("http://192.168.1.4:8000").is_err());
        assert!(whisper_endpoint("http://localhost:8000/other").is_err());
    }

    #[test]
    fn command_errors_are_serializable_and_descriptive() {
        let error = serde_json::to_value(CommandError::WindowUnavailable("missing".into()))
            .expect("command errors should serialize");
        assert_eq!(error["code"], "WindowUnavailable");
        assert_eq!(error["message"], "missing");
    }

    #[test]
    fn gpt_sovits_endpoint_only_accepts_loopback_http_origins() {
        assert_eq!(
            gpt_sovits_endpoint("http://127.0.0.1:9880").unwrap().as_str(),
            "http://127.0.0.1:9880/tts"
        );
        assert_eq!(
            gpt_sovits_endpoint("http://localhost:9880/").unwrap().as_str(),
            "http://localhost:9880/tts"
        );
        assert!(gpt_sovits_endpoint("https://127.0.0.1:9880").is_err());
        assert!(gpt_sovits_endpoint("http://192.168.1.4:9880").is_err());
        assert!(gpt_sovits_endpoint("http://localhost:9880/other").is_err());
    }
}
