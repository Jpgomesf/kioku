//! Asks the person at the Mac to confirm a change: Touch ID, or the Mac password when Touch ID
//! can't be used (LocalAuthentication's device-owner policy). It goes through
//! robius-authentication, which holds the unsafe calls, so this crate stays free of them.
//! Agents can ask for access, but only a person passes this. Other systems have no prompt
//! here, so their builds stay read-only.

use crate::error::{CommandError, CommandResult};

/// True where Kioku can ask the person at the computer to confirm a change: macOS.
pub const fn available() -> bool {
    cfg!(target_os = "macos")
}

/// Asks the person to confirm. `reason` completes macOS's "Kioku is trying to …", such as
/// "let Codex read personal".
pub async fn confirm(reason: String) -> CommandResult<()> {
    // The prompt waits for the person, so it gets a thread of its own.
    tokio::task::spawn_blocking(move || prompt(&reason))
        .await
        .map_err(|error| CommandError::unavailable(format!("the check stopped: {error}")))?
}

#[cfg(target_os = "macos")]
fn prompt(reason: &str) -> CommandResult<()> {
    use robius_authentication::{
        AndroidText, BiometricStrength, Context, PolicyBuilder, Text, WindowsText,
    };

    // Biometrics and the password together are the device-owner policy: Touch ID first,
    // the Mac password when Touch ID can't be used.
    let policy = PolicyBuilder::new()
        .biometrics(Some(BiometricStrength::Strong))
        .password(true)
        .build()
        .ok_or_else(|| {
            CommandError::unavailable("this Mac can't ask for Touch ID or a password")
        })?;
    // Unused on macOS, where it is always accepted.
    let windows = WindowsText::new("Kioku", reason)
        .ok_or_else(|| CommandError::invalid_argument("the reason is too long"))?;
    let text = Text {
        android: AndroidText {
            title: "Kioku",
            subtitle: None,
            description: None,
        },
        apple: reason,
        windows,
    };
    let (answer, answered) = std::sync::mpsc::channel();
    Context::new(())
        .authenticate(text, &policy, move |result| {
            // The receiver waits below; if it is gone, nobody is listening any more.
            let _ = answer.send(result);
        })
        .map_err(refused)?;
    match answered.recv() {
        Ok(Ok(())) => Ok(()),
        Ok(Err(error)) => Err(refused(error)),
        Err(_) => Err(CommandError::unavailable("macOS gave no answer")),
    }
}

#[cfg(target_os = "macos")]
fn refused(error: robius_authentication::Error) -> CommandError {
    use robius_authentication::Error;
    match error {
        Error::UserCanceled | Error::AppCanceled | Error::SystemCanceled => {
            CommandError::cancelled()
        }
        other => CommandError::unavailable(format!("macOS didn't confirm it ({other:?})")),
    }
}

#[cfg(not(target_os = "macos"))]
fn prompt(_reason: &str) -> CommandResult<()> {
    Err(CommandError::read_only())
}
