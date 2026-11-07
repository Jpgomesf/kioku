//! The error every command returns, serialized as `{ code, message }` (see `CommandError` in
//! src/api/core.ts). Codes: not_implemented, read_only, not_found, invalid_argument, unavailable,
//! cancelled (the person cancelled the Touch ID or password check) and conflict (a file changed
//! under a write, so nothing was written).

use kioku::error::UserError;
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize, Clone, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
#[error("{message}")]
pub struct CommandError {
    pub code: String,
    pub message: String,
}

impl CommandError {
    fn new(code: &str, message: impl Into<String>) -> Self {
        Self {
            code: code.to_owned(),
            message: message.into(),
        }
    }

    pub fn not_implemented() -> Self {
        Self::new("not_implemented", "not implemented yet")
    }

    pub fn read_only() -> Self {
        Self::new("read_only", "Changes are read-only in this build.")
    }

    pub fn not_found(message: impl Into<String>) -> Self {
        Self::new("not_found", message)
    }

    pub fn invalid_argument(message: impl Into<String>) -> Self {
        Self::new("invalid_argument", message)
    }

    pub fn unavailable(message: impl Into<String>) -> Self {
        Self::new("unavailable", message)
    }

    pub fn cancelled() -> Self {
        Self::new("cancelled", "You cancelled the check.")
    }

    pub fn conflict(message: impl Into<String>) -> Self {
        Self::new("conflict", message)
    }
}

impl From<anyhow::Error> for CommandError {
    fn from(err: anyhow::Error) -> Self {
        match err.downcast_ref::<UserError>() {
            Some(user @ (UserError::NotFound(_) | UserError::InvalidArgument(_))) => {
                Self::new(user.category(), user.to_string())
            }
            // Conflict and refused only come from note writes, which the viewer never makes.
            Some(user) => Self::invalid_argument(user.to_string()),
            None => Self::unavailable(format!("{err:#}")),
        }
    }
}

pub type CommandResult<T> = Result<T, CommandError>;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn serializes_code_and_message() -> Result<(), serde_json::Error> {
        let json = serde_json::to_value(CommandError::not_implemented())?;
        assert_eq!(json["code"], "not_implemented");
        assert_eq!(json["message"], "not implemented yet");
        Ok(())
    }

    #[test]
    fn maps_user_errors_to_codes() {
        let err: CommandError = anyhow::Error::new(UserError::NotFound("no note".into())).into();
        assert_eq!(err.code, "not_found");
        assert_eq!(err.message, "no note");
        let err: CommandError = anyhow::anyhow!("connection refused").into();
        assert_eq!(err.code, "unavailable");
    }
}
