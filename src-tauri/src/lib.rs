use serde::Serialize;
use tauri::{AppHandle, Manager, WebviewWindow};

const MAIN_WINDOW: &str = "main";

#[derive(Debug, Serialize)]
#[serde(tag = "code", content = "message")]
pub enum CommandError {
    WindowUnavailable(String),
    WindowOperation(String),
}

impl std::fmt::Display for CommandError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::WindowUnavailable(message) | Self::WindowOperation(message) => {
                formatter.write_str(message)
            }
        }
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
        .invoke_handler(tauri::generate_handler![
            window_show,
            window_hide,
            window_toggle,
            window_close,
            window_minimize,
            window_drag,
            app_get_info
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
