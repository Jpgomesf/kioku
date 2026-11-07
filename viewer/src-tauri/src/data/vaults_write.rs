//! Writing the vaults file the way scripts/vaults.py does: a backup first, under `backups/`
//! beside the file in a name no other backup can take, then the new text swapped in whole.
//! Only apply_visibility calls this, after a person confirmed the change.

use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Write};
use std::path::{Path, PathBuf};

use anyhow::{Context, Result, bail};

/// Saves `text` as `<folder>/backups/<stem>-<YYYYmmdd-HHMMSS>-<micros>.toml`, created
/// exclusively and readable only by you, and returns its path.
pub fn write_backup(live: &Path, text: &str) -> Result<PathBuf> {
    let folder = live
        .parent()
        .context("the vaults file has no folder")?
        .join("backups");
    fs::create_dir_all(&folder).with_context(|| format!("cannot create {}", folder.display()))?;
    let stem = live
        .file_stem()
        .and_then(|s| s.to_str())
        .unwrap_or("vaults");
    let now = chrono::Local::now();
    let stamp = format!(
        "{}-{:06}",
        now.format("%Y%m%d-%H%M%S"),
        now.timestamp_subsec_micros() % 1_000_000
    );
    for attempt in 0..100 {
        let name = if attempt == 0 {
            format!("{stem}-{stamp}.toml")
        } else {
            format!("{stem}-{stamp}-{attempt}.toml")
        };
        let path = folder.join(name);
        match private_new_file(&path) {
            Ok(mut file) => {
                file.write_all(text.as_bytes())
                    .and_then(|()| file.sync_all())
                    .with_context(|| format!("cannot write the backup {}", path.display()))?;
                return Ok(path);
            }
            Err(error) if error.kind() == ErrorKind::AlreadyExists => {}
            Err(error) => {
                return Err(error)
                    .with_context(|| format!("cannot back up into {}", folder.display()));
            }
        }
    }
    bail!(
        "could not create a backup in {}, so nothing was written",
        folder.display()
    )
}

/// Replaces the file at `live` with `text` in one step: a sibling is written and synced, then
/// renamed over it, so the file is never half written. A symlinked vaults file (dotfiles) is
/// written through, not replaced by a plain file. The file keeps its permissions.
pub fn replace(live: &Path, text: &str) -> Result<()> {
    let target =
        fs::canonicalize(live).with_context(|| format!("cannot find {}", live.display()))?;
    let folder = target.parent().context("the vaults file has no folder")?;
    let name = target
        .file_name()
        .and_then(|n| n.to_str())
        .unwrap_or("vaults.toml");
    let temporary = folder.join(format!(".{name}.kioku-viewer-{}.tmp", std::process::id()));
    let written = (|| -> Result<()> {
        let mut file = private_new_file(&temporary)
            .with_context(|| format!("cannot create {}", temporary.display()))?;
        file.write_all(text.as_bytes())?;
        file.sync_all()?;
        let permissions = fs::metadata(&target)?.permissions();
        fs::set_permissions(&temporary, permissions)?;
        fs::rename(&temporary, &target)
            .with_context(|| format!("cannot replace {}", target.display()))?;
        Ok(())
    })();
    if written.is_err() {
        // Best effort: the live file was never touched, only the sibling may be left.
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// A new file only this user can read, failing if the name is taken.
fn private_new_file(path: &Path) -> std::io::Result<fs::File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> Result<PathBuf> {
        let folder = std::env::temp_dir().join(format!(
            "kioku-viewer-{name}-{}-{}",
            std::process::id(),
            chrono::Local::now()
                .timestamp_nanos_opt()
                .unwrap_or_default()
        ));
        fs::create_dir_all(&folder)?;
        Ok(folder)
    }

    #[test]
    fn backups_never_overwrite_each_other() -> Result<()> {
        let folder = scratch("backups")?;
        let live = folder.join("vaults.toml");
        fs::write(&live, "old")?;
        let first = write_backup(&live, "one")?;
        let second = write_backup(&live, "two")?;
        assert_ne!(first, second);
        assert_eq!(fs::read_to_string(&first)?, "one");
        assert_eq!(fs::read_to_string(&second)?, "two");
        assert_eq!(first.parent(), Some(folder.join("backups").as_path()));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&first)?.permissions().mode() & 0o777, 0o600);
        }
        fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[test]
    fn replace_swaps_the_text_and_keeps_permissions() -> Result<()> {
        let folder = scratch("replace")?;
        let live = folder.join("vaults.toml");
        fs::write(&live, "old")?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&live, fs::Permissions::from_mode(0o640))?;
        }
        replace(&live, "new")?;
        assert_eq!(fs::read_to_string(&live)?, "new");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(fs::metadata(&live)?.permissions().mode() & 0o777, 0o640);
        }
        // No sibling is left behind.
        assert_eq!(fs::read_dir(&folder)?.count(), 1);
        fs::remove_dir_all(folder)?;
        Ok(())
    }

    #[cfg(unix)]
    #[test]
    fn replace_writes_through_a_symlink() -> Result<()> {
        let folder = scratch("symlink")?;
        let real = folder.join("dotfiles-vaults.toml");
        let link = folder.join("vaults.toml");
        fs::write(&real, "old")?;
        std::os::unix::fs::symlink(&real, &link)?;
        replace(&link, "new")?;
        assert!(fs::symlink_metadata(&link)?.file_type().is_symlink());
        assert_eq!(fs::read_to_string(&real)?, "new");
        fs::remove_dir_all(folder)?;
        Ok(())
    }
}
