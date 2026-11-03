//! Errors the caller can act on, kept distinct from internal failures.
//!
//! Application code stays on `anyhow`; it raises a [`UserError`] for problems
//! the caller can fix. The MCP layer shows those messages verbatim and reports
//! everything else as a short category, logging the full chain to stderr.

/// A failure caused by the request, with a message written for the caller.
#[derive(Debug, thiserror::Error)]
pub enum UserError {
    /// The arguments are malformed or out of range.
    #[error("{0}")]
    InvalidArgument(String),
    /// The requested memory or path does not exist.
    #[error("{0}")]
    NotFound(String),
    /// The write conflicts with stored data, such as another note's source.
    #[error("{0}")]
    Conflict(String),
    /// The write is not allowed, such as a note containing a credential.
    #[error("{0}")]
    Refused(String),
}

impl UserError {
    pub fn category(&self) -> &'static str {
        match self {
            Self::InvalidArgument(_) => "invalid_argument",
            Self::NotFound(_) => "not_found",
            Self::Conflict(_) => "conflict",
            Self::Refused(_) => "refused",
        }
    }
}

/// Return early with an invalid-argument error.
macro_rules! invalid {
    ($($arg:tt)*) => {
        return Err(anyhow::Error::new($crate::error::UserError::InvalidArgument(format!($($arg)*))))
    };
}

/// Return early with a not-found error.
macro_rules! not_found {
    ($($arg:tt)*) => {
        return Err(anyhow::Error::new($crate::error::UserError::NotFound(format!($($arg)*))))
    };
}

/// Return early with a conflict error.
macro_rules! conflict {
    ($($arg:tt)*) => {
        return Err(anyhow::Error::new($crate::error::UserError::Conflict(format!($($arg)*))))
    };
}

pub(crate) use {conflict, invalid, not_found};
