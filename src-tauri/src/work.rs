// Client-side work mode store (cards, command ledger, approval bindings).
//
// Data lives under `work_dir()` (D:\IceAgent\work by default, override with
// ICE_AGENT_WORK_DIR). Every mutation is a whole-file atomic replace.
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};

use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

use crate::codex::CodexEngine;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkPlan {
    pub title: String,
    pub steps: Vec<String>,
    pub risks: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct WorkCard {
    pub id: String,
    pub version: u64,
    pub state: String, // open | claimed | dismissed
    pub stage: String, // confirming | sending | working | completed | failed | unknown
    pub command_id: String,
    pub text: String,
    pub cwd: String,
    pub plan: WorkPlan,
    pub created_at: String,
    #[serde(default)]
    pub approval_id: Option<String>,
    #[serde(default)]
    pub native_turn_id: Option<String>,
    #[serde(default)]
    pub last_text: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ApprovalBinding {
    pub approval_id: String,
    pub card_id: String,
    pub answered: bool,
    pub decision: String,
    pub created_at: String,
}

pub fn work_dir() -> PathBuf {
    std::env::var("ICE_AGENT_WORK_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| PathBuf::from("D:\\IceAgent\\work"))
}

fn cards_dir() -> PathBuf {
    work_dir().join("cards")
}
fn commands_dir() -> PathBuf {
    work_dir().join("commands")
}
fn approvals_dir() -> PathBuf {
    work_dir().join("approvals")
}

fn ensure_dirs() -> Result<(), String> {
    for dir in [cards_dir(), commands_dir(), approvals_dir()] {
        std::fs::create_dir_all(&dir).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn now() -> String {
    // Seconds since epoch is enough for ordering; keep it dependency free.
    let seconds = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|value| value.as_secs())
        .unwrap_or(0);
    seconds.to_string()
}

fn write_json(path: &std::path::Path, value: &Value) -> Result<(), String> {
    let text = serde_json::to_string_pretty(value).map_err(|error| error.to_string())?;
    let tmp = path.with_extension(format!("{}.tmp", std::process::id()));
    std::fs::write(&tmp, text).map_err(|error| error.to_string())?;
    std::fs::rename(&tmp, path).map_err(|error| error.to_string())
}

fn read_card(id: &str) -> Option<WorkCard> {
    let path = cards_dir().join(format!("{id}.json"));
    let text = std::fs::read_to_string(path).ok()?;
    serde_json::from_str(&text).ok()
}

fn save_card(card: &WorkCard) -> Result<(), String> {
    write_json(
        &cards_dir().join(format!("{}.json", card.id)),
        &serde_json::to_value(card).map_err(|error| error.to_string())?,
    )
}

/// Creates an open card. Nothing is dispatched here.
pub fn prepare(text: &str, cwd: &str) -> Result<WorkCard, String> {
    ensure_dirs()?;
    let id = format!("card-{}", uuid_like());
    let card = WorkCard {
        id: id.clone(),
        version: 1,
        state: "open".into(),
        stage: "confirming".into(),
        command_id: format!("cmd-{}", uuid_like()),
        text: text.trim().to_string(),
        cwd: cwd.to_string(),
        plan: WorkPlan {
            title: text.trim().chars().take(40).collect(),
            steps: vec![],
            risks: vec![],
        },
        created_at: now(),
        approval_id: None,
        native_turn_id: None,
        last_text: String::new(),
    };
    save_card(&card)?;
    Ok(card)
}

pub fn revise(id: &str, expected_version: u64, text: &str) -> Result<WorkCard, String> {
    let mut card = read_card(id).ok_or("card not found")?;
    if card.state != "open" {
        return Err("card is not open".into());
    }
    if card.version != expected_version {
        return Err("version_conflict".into());
    }
    card.version += 1;
    card.text = text.to_string();
    save_card(&card)?;
    Ok(card)
}

pub fn dismiss(id: &str, expected_version: u64) -> Result<WorkCard, String> {
    let mut card = read_card(id).ok_or("card not found")?;
    if card.version != expected_version {
        return Err("version_conflict".into());
    }
    card.state = "dismissed".into();
    card.stage = "idle".into();
    save_card(&card)?;
    Ok(card)
}

/// Claims a command exactly once (`wx`). Returns true for the winner.
fn claim(command_id: &str) -> Result<bool, String> {
    ensure_dirs()?;
    let path = commands_dir().join(format!("{command_id}.json"));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(mut handle) => {
            use std::io::Write as _;
            let _ = handle.write_all(br#"{"state":"claimed"}"#);
            Ok(true)
        }
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

fn update_command(command_id: &str, state: &str) -> Result<(), String> {
    write_json(
        &commands_dir().join(format!("{command_id}.json")),
        &json!({ "state": state, "updatedAt": now() }),
    )
}

/// Confirms a card: CAS on the version, then a single dispatch.
pub fn confirm(id: &str, expected_version: u64, engine: &CodexEngine) -> Result<Value, String> {
    let mut card = read_card(id).ok_or("card not found")?;
    if card.version != expected_version {
        return Err("version_conflict".into());
    }
    if card.state == "dismissed" {
        return Err("dismissed".into());
    }
    if card.state != "open" {
        return Ok(json!({ "card": card, "state": "replayed" }));
    }
    if !claim(&card.command_id)? {
        return Ok(json!({ "card": card, "state": "replayed" }));
    }

    card.state = "claimed".into();
    card.stage = "sending".into();
    save_card(&card)?;

    let thread = engine.start_thread(&card.cwd)?;
    engine.start_turn(&thread, &card.text)?;

    card.stage = "working".into();
    card.native_turn_id = Some(thread);
    save_card(&card)?;
    update_command(&card.command_id, "accepted")?;
    Ok(json!({ "card": card, "state": "accepted" }))
}

/// Binds the current approval request to a card so it can be answered once.
pub fn bind_approval(approval_id: &str, card_id: &str) -> Result<(), String> {
    ensure_dirs()?;
    let path = approvals_dir().join(format!("{approval_id}.json"));
    match std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            return Err("approval_already_bound".into())
        }
        Err(error) => return Err(error.to_string()),
    }
    let binding = ApprovalBinding {
        approval_id: approval_id.to_string(),
        card_id: card_id.to_string(),
        answered: false,
        decision: String::new(),
        created_at: now(),
    };
    write_json(&path, &serde_json::to_value(binding).map_err(|e| e.to_string())?)
}

pub fn read_approval(approval_id: &str) -> Option<ApprovalBinding> {
    let text = std::fs::read_to_string(approvals_dir().join(format!("{approval_id}.json"))).ok()?;
    serde_json::from_str(&text).ok()
}

/// Answers an approval exactly once.
pub fn approve(
    approval_id: &str,
    decision: &str,
    engine: &CodexEngine,
    request_id: u64,
) -> Result<(), String> {
    let path = approvals_dir().join(format!("{approval_id}.json"));
    let mut binding = read_approval(approval_id).ok_or("approval not found")?;
    if binding.answered {
        return Err("approval_already_answered".into());
    }
    engine.respond(request_id, json!({ "decision": decision }))?;
    binding.answered = true;
    binding.decision = decision.to_string();
    write_json(&path, &serde_json::to_value(&binding).map_err(|e| e.to_string())?)?;
    if let Some(mut card) = read_card(&binding.card_id) {
        card.approval_id = Some(approval_id.to_string());
        save_card(&card)?;
    }
    Ok(())
}

/// Applies a turn notification to the matching card projection.
pub fn apply_notification(method: &str, params: &Value) {
    let Some(card_id) = params
        .get("threadId")
        .and_then(Value::as_str)
        .and_then(card_for_thread)
    else {
        return;
    };
    let Some(mut card) = read_card(&card_id) else {
        return;
    };
    match method {
        "item/completed" => {
            let item = params.get("item");
            if item.and_then(|item| item.get("type")).and_then(Value::as_str)
                == Some("agentMessage")
            {
                card.last_text = item
                    .and_then(|item| item.get("text"))
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .chars()
                    .take(400)
                    .collect();
            }
        }
        "thread/status/changed" => {
            let status = params
                .get("status")
                .and_then(|status| status.get("type"))
                .and_then(Value::as_str)
                .unwrap_or("");
            if status == "idle" && card.stage == "working" {
                card.stage = "completed".into();
            }
        }
        _ => {}
    }
    let _ = save_card(&card);
}

/// Scans cards to find the one owning a thread id (thread ids come from the
/// engine, cards store them after dispatch).
pub fn card_for_thread(thread_id: &str) -> Option<String> {
    let entries = std::fs::read_dir(cards_dir()).ok()?;
    for entry in entries.map_while(Result::ok) {
        let text = std::fs::read_to_string(entry.path()).ok()?;
        let card: WorkCard = serde_json::from_str(&text).ok()?;
        if card.native_turn_id.as_deref() == Some(thread_id) {
            return Some(card.id);
        }
    }
    None
}

pub fn status(id: &str) -> Option<Value> {
    let card = read_card(id)?;
    let command = std::fs::read_to_string(commands_dir().join(format!("{}.json", card.command_id)))
        .ok()
        .and_then(|text| serde_json::from_str::<Value>(&text).ok());
    let approval = card
        .approval_id
        .as_deref()
        .and_then(read_approval)
        .map(|binding| serde_json::to_value(binding).unwrap_or(Value::Null));
    Some(json!({ "card": card, "command": command, "approval": approval }))
}

pub fn list() -> Vec<WorkCard> {
    let mut cards = Vec::new();
    let Ok(entries) = std::fs::read_dir(cards_dir()) else {
        return cards;
    };
    for entry in entries.map_while(Result::ok) {
        if let Ok(text) = std::fs::read_to_string(entry.path()) {
            if let Ok(card) = serde_json::from_str::<WorkCard>(&text) {
                cards.push(card);
            }
        }
    }
    cards.sort_by(|a, b| b.created_at.cmp(&a.created_at));
    cards
}

fn uuid_like() -> String {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|value| value.as_nanos())
        .unwrap_or(0);
    format!("{nanos:x}")
}

/// Process-wide engine handle used by the Tauri commands.
pub struct WorkState {
    pub engine: Mutex<Option<Arc<CodexEngine>>>,
    pub approvals: Mutex<HashMap<String, u64>>,
}

impl Default for WorkState {
    fn default() -> Self {
        Self {
            engine: Mutex::new(None),
            approvals: Mutex::new(HashMap::new()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("ice-work-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        std::env::set_var("ICE_AGENT_WORK_DIR", &dir);
        dir
    }

    #[test]
    fn claim_is_exclusive_and_versions_conflict() {
        let dir = temp_dir("claim");
        let card = prepare("整理 workspace", "D:\\codex\\workspace").unwrap();
        assert_eq!(card.version, 1);
        assert!(claim(&card.command_id).unwrap());
        assert!(!claim(&card.command_id).unwrap());
        assert_eq!(revise(&card.id, 99, "x").unwrap_err(), "version_conflict");
        let revised = revise(&card.id, 1, "新内容").unwrap();
        assert_eq!(revised.version, 2);
        let dismissed = dismiss(&card.id, 2).unwrap();
        assert_eq!(dismissed.state, "dismissed");
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn approval_can_only_be_answered_once() {
        let dir = temp_dir("approval");
        let card = prepare("x", "D:\\codex\\workspace").unwrap();
        bind_approval("appr-1", &card.id).unwrap();
        assert!(bind_approval("appr-1", &card.id).is_err());
        let _ = std::fs::remove_dir_all(dir);
    }
}
