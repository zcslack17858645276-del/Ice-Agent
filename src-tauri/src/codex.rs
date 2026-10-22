// Client-side Codex app-server client.
//
// Spawns `codex app-server` for the machine the pet runs on, speaks
// newline-delimited JSON-RPC over stdio, and surfaces:
//   - responses to our requests
//   - server -> client requests (approvals), forwarded as events with their id
//   - notifications (turn/item/thread events)
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde_json::{json, Value};

#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x0800_0000;

pub type EventSink = Arc<dyn Fn(Value) + Send + Sync>;

pub struct CodexEngine {
    stdin: Mutex<ChildStdin>,
    child: Mutex<Child>,
    pending: Mutex<HashMap<u64, Sender<Result<Value, String>>>>,
    next_id: AtomicU64,
    emit: EventSink,
}

fn resolve_codex() -> Result<String, String> {
    let mut candidates: Vec<std::path::PathBuf> = Vec::new();
    if let Ok(appdata) = std::env::var("APPDATA") {
        candidates.push(
            std::path::Path::new(&appdata)
                .join("npm")
                .join("node_modules")
                .join("@openai")
                .join("codex")
                .join("bin")
                .join("codex.js"),
        );
    }
    candidates.push(std::path::PathBuf::from(
        "D:\\nodejs\\node_global\\node_modules\\@openai\\codex\\bin\\codex.js",
    ));
    candidates
        .into_iter()
        .find(|candidate| candidate.exists())
        .map(|candidate| candidate.to_string_lossy().to_string())
        .ok_or_else(|| "Codex CLI not found (npm i -g @openai/codex).".to_string())
}

impl CodexEngine {
    pub fn spawn(cwd: &str, emit: EventSink) -> Result<Arc<Self>, String> {
        let codex = resolve_codex()?;
        let mut command = Command::new("node");
        command
            .arg(&codex)
            .arg("app-server")
            .current_dir(cwd)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        command.creation_flags(CREATE_NO_WINDOW);

        let mut child = command.spawn().map_err(|error| error.to_string())?;
        let stdin = child.stdin.take().ok_or("no stdin")?;
        let stdout = child.stdout.take().ok_or("no stdout")?;

        let engine = Arc::new(Self {
            stdin: Mutex::new(stdin),
            child: Mutex::new(child),
            pending: Mutex::new(HashMap::new()),
            next_id: AtomicU64::new(0),
            emit,
        });

        let reader = engine.clone();
        std::thread::spawn(move || {
            let lines = BufReader::new(stdout).lines();
            for line in lines.map_while(Result::ok) {
                let text = line.trim();
                if text.is_empty() {
                    continue;
                }
                let Ok(message) = serde_json::from_str::<Value>(text) else {
                    continue;
                };
                let id = message.get("id").and_then(Value::as_u64);
                let method = message.get("method").and_then(Value::as_str).map(str::to_string);

                match (id, method) {
                    // Response to a request we sent.
                    (Some(id), None) => {
                        let waiter = reader.pending.lock().ok().and_then(|mut map| map.remove(&id));
                        if let Some(waiter) = waiter {
                            let outcome = match message.get("error") {
                                Some(error) => Err(error.to_string()),
                                None => Ok(message.get("result").cloned().unwrap_or(Value::Null)),
                            };
                            let _ = waiter.send(outcome);
                        }
                    }
                    // Server -> client request (approval).
                    (Some(id), Some(method)) => {
                        (reader.emit)(json!({
                            "type": "request",
                            "id": id,
                            "method": method,
                            "params": message.get("params").cloned().unwrap_or(Value::Null),
                        }));
                    }
                    // Notification.
                    (None, Some(method)) => {
                        (reader.emit)(json!({
                            "type": "notification",
                            "method": method,
                            "params": message.get("params").cloned().unwrap_or(Value::Null),
                        }));
                    }
                    _ => {}
                }
            }
            (reader.emit)(json!({ "type": "closed" }));
        });

        engine.request(
            "initialize",
            json!({ "clientInfo": { "name": "ice-agent", "title": "Ice Agent", "version": "0.1.0" } }),
            Duration::from_secs(20),
        )?;
        engine.notify("initialized", json!({}));
        Ok(engine)
    }

    pub fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.next_id.fetch_add(1, Ordering::SeqCst) + 1;
        let (tx, rx) = mpsc::channel();
        self.pending.lock().map_err(|_| "pending lock")?.insert(id, tx);
        self.write(json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))?;
        match rx.recv_timeout(timeout) {
            Ok(Ok(value)) => Ok(value),
            Ok(Err(error)) => Err(error),
            Err(_) => {
                if let Ok(mut map) = self.pending.lock() {
                    map.remove(&id);
                }
                Err(format!("{method} timed out"))
            }
        }
    }

    pub fn notify(&self, method: &str, params: Value) {
        let _ = self.write(json!({ "jsonrpc": "2.0", "method": method, "params": params }));
    }

    pub fn respond(&self, id: u64, result: Value) -> Result<(), String> {
        self.write(json!({ "jsonrpc": "2.0", "id": id, "result": result }))
    }

    fn write(&self, message: Value) -> Result<(), String> {
        let mut stdin = self.stdin.lock().map_err(|_| "stdin lock")?;
        writeln!(stdin, "{message}").map_err(|error| error.to_string())
    }

    pub fn start_thread(&self, cwd: &str) -> Result<String, String> {
        self.start_thread_with_sandbox(cwd, "workspace-write")
    }

    pub fn start_thread_with_sandbox(&self, cwd: &str, sandbox: &str) -> Result<String, String> {
        self.start_thread_with_policy(cwd, sandbox, "on-request")
    }

    pub fn start_thread_with_policy(
        &self,
        cwd: &str,
        sandbox: &str,
        approval_policy: &str,
    ) -> Result<String, String> {
        let thread = self.request(
            "thread/start",
            json!({
                "cwd": cwd,
                "approvalPolicy": approval_policy,
                "sandbox": sandbox,
            }),
            Duration::from_secs(60),
        )?;
        thread
            .get("threadId")
            .and_then(Value::as_str)
            .or_else(|| thread.get("thread").and_then(|t| t.get("id")).and_then(Value::as_str))
            .map(str::to_string)
            .ok_or_else(|| "thread/start returned no thread id".to_string())
    }

    pub fn start_turn(&self, thread_id: &str, text: &str) -> Result<Value, String> {
        self.request(
            "turn/start",
            json!({
                "threadId": thread_id,
                "input": [{ "type": "text", "text": text }],
            }),
            Duration::from_secs(60),
        )
    }

    pub fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}

impl Drop for CodexEngine {
    fn drop(&mut self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::Instant;

    /// End-to-end check against a real app-server: an out-of-sandbox command
    /// must raise an approval request, and answering it must run the command.
    #[test]
    fn approval_roundtrip() {
        let workspace = "D:\\codex\\workspace";
        let marker = "D:\\codex\\workspace\\codex-rust-poc.txt";
        let _ = std::fs::remove_file(marker);

        // codex writes PATH-alias temp dirs under $CODEX_HOME/tmp; point it at
        // the workspace so the sandboxed test process can write there.
        let real_home = std::path::Path::new(&std::env::var("USERPROFILE").unwrap_or_default())
            .join(".codex");
        let test_home = std::path::Path::new(workspace).join(".codex-test-home");
        let _ = std::fs::create_dir_all(&test_home);
        for name in ["auth.json", "config.toml"] {
            let source = real_home.join(name);
            if source.exists() {
                let _ = std::fs::copy(&source, test_home.join(name));
            }
        }
        std::env::set_var("CODEX_HOME", &test_home);

        let (tx, rx) = mpsc::channel::<Value>();
        let sink: EventSink = Arc::new(move |value| {
            let _ = tx.send(value);
        });
        let engine = CodexEngine::spawn(workspace, sink).expect("spawn app-server");
        let thread = engine
            .start_thread_with_policy(workspace, "danger-full-access", "untrusted")
            .expect("thread/start");
        engine
            .start_turn(
                &thread,
                "Use the shell tool to run exactly: cmd /c echo rust-poc > D:\\codex\\workspace\\codex-rust-poc.txt",
            )
            .expect("turn/start");

        let deadline = Instant::now() + Duration::from_secs(180);
        let mut saw_approval = false;
        let mut answered = false;
        let mut idle = false;
        while Instant::now() < deadline && !idle {
            let Ok(event) = rx.recv_timeout(Duration::from_secs(5)) else {
                continue;
            };
            match event.get("type").and_then(Value::as_str) {
                Some("request") => {
                    let method = event.get("method").and_then(Value::as_str).unwrap_or("");
                    if method.contains("requestApproval") {
                        saw_approval = true;
                        eprintln!(
                            "[poc] approval command = {}",
                            event
                                .get("params")
                                .and_then(|params| params.get("command"))
                                .and_then(Value::as_str)
                                .unwrap_or("<none>")
                        );
                        let id = event.get("id").and_then(Value::as_u64).unwrap();
                        engine
                            .respond(id, json!({ "decision": "accept" }))
                            .expect("respond approval");
                        answered = true;
                    }
                }
                Some("notification") => {
                    let method = event.get("method").and_then(Value::as_str).unwrap_or("");
                    if method == "item/completed" {
                        let item = event.get("params").and_then(|params| params.get("item"));
                        let kind = item.and_then(|item| item.get("type")).and_then(Value::as_str);
                        if kind == Some("agentMessage") {
                            eprintln!(
                                "[poc] final message = {}",
                                item.and_then(|item| item.get("text")).and_then(Value::as_str).unwrap_or("")
                            );
                        }
                        if kind == Some("commandExecution") {
                            eprintln!(
                                "[poc] command finished exit={:?} output={:?}",
                                item.and_then(|item| item.get("exitCode")).and_then(Value::as_i64),
                                item.and_then(|item| item.get("aggregatedOutput"))
                                    .and_then(Value::as_str)
                                    .unwrap_or("")
                                    .chars()
                                    .take(160)
                                    .collect::<String>()
                            );
                        }
                    }
                    let status = event
                        .get("params")
                        .and_then(|params| params.get("status"))
                        .and_then(|status| status.get("type"))
                        .and_then(Value::as_str)
                        .unwrap_or("");
                    if method == "thread/status/changed" && status == "idle" {
                        idle = true;
                    }
                }
                _ => {}
            }
        }

        engine.shutdown();
        assert!(saw_approval, "approval request was never received");
        assert!(answered, "approval was never answered");
        assert!(idle, "turn did not finish");
        std::thread::sleep(Duration::from_millis(3000));
        assert!(
            std::path::Path::new(marker).exists(),
            "approved command did not run"
        );
    }
}
