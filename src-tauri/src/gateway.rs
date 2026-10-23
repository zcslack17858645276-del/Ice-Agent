//! Native WebSocket bridge to the OpenClaw Gateway.
//!
//! The Gateway only grants operator scopes to connections without a browser
//! `Origin` header; a WebView-to-Gateway socket is admitted but receives an empty
//! scope set, so every RPC fails with `FORBIDDEN`. The webview therefore never
//! opens the socket itself: Rust owns the connection and forwards JSON frames as
//! Tauri events, which keeps the loopback backend path (full scopes) intact.

use futures_util::{SinkExt, StreamExt};
use std::sync::Mutex;
use std::time::Duration;
use tauri::{AppHandle, Emitter, State};
use tokio::sync::mpsc;
use tokio_tungstenite::tungstenite::Message;

use crate::{startup_log, CommandError};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(15);

enum Outgoing {
    Text(String),
    Pong(Vec<u8>),
    Close,
}

pub struct GatewaySession {
    sender: mpsc::UnboundedSender<Outgoing>,
    task: tokio::task::AbortHandle,
}

#[derive(Default)]
pub struct GatewayState(pub Mutex<Option<GatewaySession>>);

fn stop_session(state: &State<'_, GatewayState>) {
    let Ok(mut guard) = state.0.lock() else {
        return;
    };
    if let Some(session) = guard.take() {
        let _ = session.sender.send(Outgoing::Close);
        session.task.abort();
    }
}

/// Opens the Gateway socket. Frames arrive as `gateway:frame` events and a
/// terminal close as `gateway:closed`.
#[tauri::command(rename = "gateway:connect")]
pub async fn gateway_connect(
    app: AppHandle,
    state: State<'_, GatewayState>,
    url: String,
    token: String,
) -> Result<(), CommandError> {
    let url = url.trim().to_string();
    if !(url.starts_with("ws://") || url.starts_with("wss://")) {
        return Err(CommandError::Configuration(
            "网关地址必须以 ws:// 或 wss:// 开头。".into(),
        ));
    }
    if token.trim().is_empty() {
        return Err(CommandError::Credential(
            "缺少网关 Token，请先在网关设置里填写。".into(),
        ));
    }
    stop_session(&state);
    startup_log(&format!(
        "gateway:connect url={url} token_len={}",
        token.trim().len()
    ));

    let connected = tokio::time::timeout(CONNECT_TIMEOUT, tokio_tungstenite::connect_async(&url))
        .await
        .map_err(|_| CommandError::Network(format!("连接 {url} 超时。")))?
        .map_err(|error| {
            startup_log(&format!("gateway:connect failed: {error}"));
            CommandError::Network(format!("无法连接 {url}：{error}"))
        })?;
    let (stream, _response) = connected;
    let (mut write, mut read) = stream.split();
    let (sender, mut receiver) = mpsc::unbounded_channel::<Outgoing>();
    let session_sender = sender.clone();
    let app_for_read = app.clone();

    let task = tokio::spawn(async move {
        let writer = tokio::spawn(async move {
            while let Some(item) = receiver.recv().await {
                let message = match item {
                    Outgoing::Text(text) => Message::Text(text.into()),
                    Outgoing::Pong(payload) => Message::Pong(payload.into()),
                    Outgoing::Close => {
                        let _ = write.send(Message::Close(None)).await;
                        return;
                    }
                };
                if write.send(message).await.is_err() {
                    return;
                }
            }
        });

        loop {
            match read.next().await {
                Some(Ok(Message::Text(text))) => {
                    let _ = app_for_read.emit("gateway:frame", text.to_string());
                }
                Some(Ok(Message::Ping(payload))) => {
                    let _ = sender.send(Outgoing::Pong(payload.to_vec()));
                }
                Some(Ok(Message::Close(frame))) => {
                    let (code, reason) = frame
                        .map(|item| (u16::from(item.code), item.reason.to_string()))
                        .unwrap_or((1000, String::new()));
                    let _ = app_for_read.emit(
                        "gateway:closed",
                        serde_json::json!({ "code": code, "reason": reason }),
                    );
                    break;
                }
                Some(Err(error)) => {
                    let _ = app_for_read.emit(
                        "gateway:closed",
                        serde_json::json!({ "code": 1006, "reason": error.to_string() }),
                    );
                    break;
                }
                None => {
                    let _ = app_for_read.emit(
                        "gateway:closed",
                        serde_json::json!({ "code": 1006, "reason": "连接已关闭" }),
                    );
                    break;
                }
                _ => {}
            }
        }
        writer.abort();
    });

    let abort = task.abort_handle();
    if let Ok(mut guard) = state.0.lock() {
        *guard = Some(GatewaySession {
            sender: session_sender,
            task: abort,
        });
    }
    startup_log("gateway:connect ok");
    Ok(())
}

/// Sends one already-serialized JSON frame.
#[tauri::command(rename = "gateway:send")]
pub fn gateway_send(state: State<'_, GatewayState>, frame: String) -> Result<(), CommandError> {
    let guard = state
        .0
        .lock()
        .map_err(|_| CommandError::Network("网关连接状态不可用。".into()))?;
    let Some(session) = guard.as_ref() else {
        return Err(CommandError::Network("尚未连接 OpenClaw 网关。".into()));
    };
    if let Ok(value) = serde_json::from_str::<serde_json::Value>(&frame) {
        let method = value.get("method").and_then(|item| item.as_str()).unwrap_or("-");
        startup_log(&format!("gateway:send {method}"));
    }
    session
        .sender
        .send(Outgoing::Text(frame))
        .map_err(|_| CommandError::Network("网关发送失败。".into()))
}

#[tauri::command(rename = "gateway:close")]
pub fn gateway_close(state: State<'_, GatewayState>) -> Result<(), CommandError> {
    stop_session(&state);
    Ok(())
}
