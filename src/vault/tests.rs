//! Session placement and visibility, on real temporary folders.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use super::*;
use crate::testing::note;

/// A temporary folder tree, removed on drop.
struct Tree(PathBuf);

impl Tree {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!("kioku-vault-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }

    fn dir(&self, relative: &str) -> PathBuf {
        let path = self.0.join(relative);
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    /// A repository at `relative` whose remotes are `remotes` (name, url).
    fn repo(&self, relative: &str, remotes: &[(&str, &str)]) -> PathBuf {
        let path = self.dir(relative);
        let git = path.join(".git");
        std::fs::create_dir_all(&git).unwrap();
        let mut config = String::from("[core]\n\tbare = false\n");
        for (name, url) in remotes {
            config.push_str(&format!("[remote \"{name}\"]\n\turl = {url}\n"));
        }
        std::fs::write(git.join("config"), config).unwrap();
        path
    }
}

impl Drop for Tree {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn vaults(tree: &Tree) -> Arc<Vaults> {
    let root = tree.0.display();
    let text = format!(
        r#"
        [[vault]]
        name = "personal"
        paths = ["{root}"]
        domains = ["personal", "personal/*", "kioku"]
        providers = ["local", "anthropic"]
        default_domain = "personal"

        [[vault]]
        name = "work"
        paths = ["{root}/work"]
        git_remotes = ["github.com/acme/*"]
        domains = ["work", "work/*"]
        providers = ["local", "openai"]
        default_domain = "work"

        [[vault]]
        name = "clash"
        domains = ["clash", "kioku"]
        providers = ["local"]
        default_domain = "clash"

        [[area]]
        domain = "personal/kioku"
        paths = ["{root}/projects/kioku"]

        [[area]]
        domain = "work/api"
        paths = ["{root}/work/api"]

        [[lock]]
        domains = ["personal/citizenship"]
        providers = ["local"]
        "#
    );
    Arc::new(Vaults::parse(&text, Path::new("/cfg/vaults.toml"), None).unwrap())
}

fn place(vaults: &Arc<Vaults>, provider: &str, folder: &Path) -> Session {
    Session::for_folder(Some(vaults), Some(provider), Some(folder))
}

fn placed(session: &Session) -> (&str, Option<&str>, &str) {
    let placement = session
        .placement()
        .unwrap_or_else(|| panic!("not placed: {session:?}"));
    (
        placement.vault(),
        placement.area(),
        placement.default_domain(),
    )
}

#[test]
fn the_longest_folder_wins_across_vaults() {
    let tree = Tree::new();
    let vaults = vaults(&tree);
    let home = place(&vaults, "local", &tree.dir("notes"));
    assert_eq!(placed(&home), ("personal", None, "personal"));
    assert!(home.placement().unwrap().at_root());
    let work = place(&vaults, "local", &tree.dir("work/web"));
    assert_eq!(placed(&work), ("work", None, "work"));
    let area = place(&vaults, "local", &tree.dir("work/api/src"));
    assert_eq!(placed(&area), ("work", Some("work/api"), "work/api"));
    let kioku = place(&vaults, "anthropic", &tree.dir("projects/kioku"));
    assert_eq!(
        placed(&kioku),
        ("personal", Some("personal/kioku"), "personal/kioku")
    );
    // A folder that merely shares a name prefix is not inside the area.
    let sibling = place(&vaults, "anthropic", &tree.dir("projects/kioku-old"));
    assert_eq!(placed(&sibling), ("personal", None, "personal"));
}

#[test]
fn a_git_remote_overrides_the_folder() {
    let tree = Tree::new();
    let vaults = vaults(&tree);
    // Under the personal folder, but the repository belongs to acme.
    let repo = tree.repo(
        "projects/client",
        &[
            ("upstream", "git@github.com:Other/x.git"),
            ("origin", "git@github.com:ACME/client.git"),
        ],
    );
    let nested = repo.join("src/deep");
    std::fs::create_dir_all(&nested).unwrap();
    assert_eq!(
        placed(&place(&vaults, "openai", &nested)),
        ("work", None, "work")
    );
    // A remote that matches no vault falls back to the folder.
    let own = tree.repo("projects/mine", &[("origin", "https://github.com/me/mine")]);
    assert_eq!(
        placed(&place(&vaults, "local", &own)),
        ("personal", None, "personal")
    );
    // A worktree's .git file leads to the main repository's config.
    let main_git = repo.join(".git");
    std::fs::create_dir_all(main_git.join("worktrees/wt")).unwrap();
    std::fs::write(main_git.join("worktrees/wt/commondir"), "../..\n").unwrap();
    let worktree = tree.dir("elsewhere/wt");
    std::fs::write(
        worktree.join(".git"),
        format!("gitdir: {}\n", main_git.join("worktrees/wt").display()),
    )
    .unwrap();
    assert_eq!(
        placed(&place(&vaults, "local", &worktree)),
        ("work", None, "work")
    );
}

#[test]
fn unplaced_and_undeclared_sessions_get_nothing() {
    let tree = Tree::new();
    let vaults = vaults(&tree);
    let outside = std::env::temp_dir().join(format!("kioku-outside-{}", uuid::Uuid::new_v4()));
    let session = place(&vaults, "local", &outside);
    let text = session.refusal().unwrap();
    assert!(text.contains(&outside.display().to_string()), "{text}");
    assert!(
        text.contains("/cfg/vaults.toml") && text.contains("paths"),
        "{text}"
    );
    let text = Session::for_folder(Some(&vaults), None, Some(&tree.0))
        .refusal()
        .unwrap()
        .to_owned();
    assert!(
        text.contains("MEMORY_PROVIDER") && text.contains("not in .env"),
        "{text}"
    );
    let text = Session::for_folder(Some(&vaults), Some("acme-ai"), Some(&tree.0))
        .refusal()
        .unwrap()
        .to_owned();
    assert!(text.contains("\"acme-ai\""), "{text}");
    let text = place(&vaults, "openai", &tree.0)
        .refusal()
        .unwrap()
        .to_owned();
    assert!(text.contains("does not allow provider openai"), "{text}");
    assert!(
        Session::for_folder(Some(&vaults), Some("local"), None)
            .refusal()
            .is_some()
    );
    let ambiguous = tree.repo("work/both", &[("origin", "git@github.com:acme/both.git")]);
    let clashing = Arc::new(
        Vaults::parse(
            "[[vault]]\nname = \"a\"\ngit_remotes = [\"github.com/acme/*\"]\ndomains = [\"a\"]\nproviders = [\"local\"]\ndefault_domain = \"a\"\n[[vault]]\nname = \"b\"\ngit_remotes = [\"github.com/*/both\"]\ndomains = [\"b\"]\nproviders = [\"local\"]\ndefault_domain = \"b\"\n",
            Path::new("/cfg/vaults.toml"),
            None,
        )
        .unwrap(),
    );
    let text = place(&clashing, "local", &ambiguous)
        .refusal()
        .unwrap()
        .to_owned();
    assert!(text.contains("github.com/acme/both"), "{text}");
    assert!(matches!(
        Session::for_folder(None, None, None),
        Session::Open
    ));
}

#[test]
fn http_principals_need_a_provider_and_a_vault() {
    let tree = Tree::new();
    let vaults = vaults(&tree);
    let mut principal = Principal::new("kilo", "read", "*").unwrap();
    assert!(
        Session::for_principal(Some(&vaults), &principal)
            .refusal()
            .is_some()
    );
    principal.provider = Some(Provider::Local);
    assert!(
        Session::for_principal(Some(&vaults), &principal)
            .refusal()
            .is_some()
    );
    principal.vault = Some("nowhere".into());
    assert!(
        Session::for_principal(Some(&vaults), &principal)
            .refusal()
            .is_some()
    );
    principal.vault = Some("work".into());
    let session = Session::for_principal(Some(&vaults), &principal);
    assert_eq!(placed(&session), ("work", None, "work"));
    assert!(matches!(
        Session::for_principal(None, &principal),
        Session::Open
    ));
}

#[test]
fn viewers_see_only_their_vault_minus_locks() {
    let tree = Tree::new();
    let vaults = vaults(&tree);
    let everyone = Principal::new("local", "read", "*").unwrap();
    let viewer = |provider: &str, principal: &Principal| {
        Viewer::new(principal, &place(&vaults, provider, &tree.dir("notes")))
    };
    let claude = viewer("anthropic", &everyone);
    assert!(claude.sees_domain("personal").unwrap());
    assert!(claude.sees_domain("personal/health").unwrap());
    assert!(!claude.sees_domain("work").unwrap(), "another vault");
    assert!(!claude.sees_domain("elsewhere").unwrap(), "no vault");
    assert!(
        !claude.sees_domain("personal/citizenship").unwrap(),
        "area lock"
    );
    let error = claude
        .check_domain("personal/citizenship")
        .unwrap_err()
        .to_string();
    assert!(
        error.contains("locked") && error.contains("anthropic"),
        "{error}"
    );
    let error = claude.check_domain("work").unwrap_err().to_string();
    assert!(error.contains("not in vault \"personal\""), "{error}");
    // "kioku" is claimed by personal and clash: a configuration error.
    assert!(claude.sees_domain("kioku").is_err());
    assert!(claude.check_domain("kioku").is_err());
    assert!(
        !claude.sees(&note("k", "kioku")),
        "ambiguous domains hide notes"
    );
    assert!(
        viewer("local", &everyone)
            .sees_domain("personal/citizenship")
            .unwrap()
    );

    let mut locked = note("passport", "personal/health");
    locked.input.lock = vec!["local".into()];
    assert!(!claude.sees(&locked), "note lock");
    assert!(viewer("local", &everyone).sees(&locked));
    assert!(claude.sees(&note("plain", "personal/health")));
    assert!(!claude.sees(&note("x", "work")));
    assert!(claude.restricts_notes());
    // A domain and a lock alone decide, as for a whole note.
    let local_only = ["local".to_owned()];
    assert!(!claude.sees_locked("personal/health", &local_only));
    assert!(claude.sees_locked("personal/health", &[]));
    assert!(viewer("local", &everyone).sees_locked("personal/health", &local_only));
    assert!(!claude.sees_locked("work", &[]));
    assert!(!claude.sees_locked("personal/citizenship", &[]));

    // The access profile narrows the vault further.
    let narrow = Principal::new("narrow", "read", "personal/health").unwrap();
    let narrowed = viewer("anthropic", &narrow);
    assert!(narrowed.sees_domain("personal/health").unwrap());
    assert!(!narrowed.sees_domain("personal").unwrap());

    // Compatibility mode: only the profile applies, and note locks are ignored.
    let open = Viewer::new(&narrow, &Session::Open);
    assert!(!open.restricts_notes());
    assert!(open.sees(&locked) && !open.sees(&note("x", "work")));
    // A refused session sees nothing at all.
    let refused = Viewer::new(&everyone, &Session::Refused("no".into()));
    assert!(!refused.sees_domain("personal").unwrap() && !refused.sees(&note("x", "personal")));
}

#[test]
fn providers_parse_case_insensitively() {
    assert_eq!(Provider::parse(" OpenAI ").unwrap(), Provider::OpenAi);
    assert_eq!(Provider::parse("deepseek").unwrap().to_string(), "deepseek");
    assert!(Provider::parse("gpt").is_err());
    for provider in Provider::ALL {
        assert_eq!(Provider::parse(provider.as_str()).unwrap(), provider);
    }
}
