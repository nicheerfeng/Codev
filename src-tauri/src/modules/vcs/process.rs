use serde::{Deserialize, Serialize};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static RUNNING: AtomicUsize = AtomicUsize::new(0);
pub const MAX_STDOUT_BYTES: u64 = 4 * 1024 * 1024;
pub const MAX_DIFF_BYTES: usize = 2 * 1024 * 1024;
pub const MAX_STATUS_ENTRIES: usize = 1_200;

struct Permit;
impl Drop for Permit {
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

fn acquire(deadline: Instant) -> Result<Permit, String> {
    loop {
        if RUNNING
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 4).then_some(n + 1)
            })
            .is_ok()
        {
            return Ok(Permit);
        }
        if Instant::now() >= deadline {
            return Err(VcsError::new(
                VcsErrorCode::Busy,
                "Git 进程池繁忙，请稍后重试",
                "当前有较多 Git 任务正在执行，请等待几秒后刷新。",
            )
            .to_wire());
        }
        std::thread::sleep(Duration::from_millis(15));
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PromptPolicy {
    /// Background read operations (status, diff, log, rev-parse) never block waiting for prompts.
    SilentRead,
    /// User-triggered remote operations allow OS credential helpers (Windows GCM / macOS keychain / SSH agent).
    InteractiveRemote,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum VcsErrorCode {
    NoGitInstalled,
    NotARepo,
    DubiousOwnership,
    MissingAuthorIdentity,
    AuthRequired,
    HostKeyUntrusted,
    DetachedHead,
    NoUpstream,
    NonFastForward,
    MergeConflict,
    HookFailed,
    BranchCheckedOutElsewhere,
    DirtyWorktree,
    Busy,
    Timeout,
    CommandFailed,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VcsError {
    pub code: VcsErrorCode,
    pub message: String,
    pub hint: String,
}

impl VcsError {
    pub fn new(
        code: VcsErrorCode,
        message: impl Into<String>,
        hint: impl Into<String>,
    ) -> Self {
        Self {
            code,
            message: message.into(),
            hint: hint.into(),
        }
    }

    /// Encode with a compact prefix so frontend callers can parse actionable VcsErrorCode cleanly,
    /// while remaining human-readable if shown directly in a toast.
    pub fn to_wire(&self) -> String {
        format!(
            "[vcs:{:?}] {}（{}）",
            self.code, self.message, self.hint
        )
    }
}

pub fn git_binary() -> String {
    #[cfg(windows)]
    {
        for candidate in [
            "git",
            r"C:\Program Files\Git\cmd\git.exe",
            r"C:\Program Files\Git\bin\git.exe",
        ] {
            let mut cmd = Command::new(candidate);
            cmd.arg("--version")
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null());
            crate::modules::proc::hide_console(&mut cmd);
            if cmd.status().is_ok_and(|s| s.success()) {
                return candidate.to_string();
            }
        }
    }
    "git".to_string()
}

pub fn command(repo: &Path, args: &[&str], policy: PromptPolicy, has_stdin: bool) -> Command {
    let mut cmd = Command::new(git_binary());
    cmd.arg("--no-pager")
        .args([
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotePath=false",
        ]);
    if policy == PromptPolicy::SilentRead {
        cmd.args(["-c", "credential.interactive=false"]);
    }
    cmd.arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(if has_stdin {
            Stdio::piped()
        } else {
            Stdio::null()
        });

    if policy == PromptPolicy::SilentRead {
        cmd.env("GIT_TERMINAL_PROMPT", "0")
            .env("GCM_INTERACTIVE", "Never")
            .env("GIT_ASKPASS", "")
            .env("SSH_ASKPASS", "")
            .env(
                "GIT_SSH_COMMAND",
                "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5",
            );
    } else {
        cmd.env("GIT_SSH_COMMAND", "ssh -o ConnectTimeout=12");
    }

    for key in [
        "GIT_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_COMMON_DIR",
        "GIT_CONFIG_COUNT",
        "GIT_CONFIG_PARAMETERS",
    ] {
        cmd.env_remove(key);
    }
    crate::modules::proc::hide_console(&mut cmd);
    cmd
}

pub fn run_raw(
    mut cmd: Command,
    stdin_bytes: Option<&[u8]>,
    timeout: Duration,
) -> Result<(bool, Vec<u8>, String), String> {
    let deadline = Instant::now() + timeout;
    let _permit = acquire(deadline)?;
    let mut stdout = tempfile::tempfile().map_err(|e| e.to_string())?;
    let mut stderr = tempfile::tempfile().map_err(|e| e.to_string())?;
    cmd.stdout(Stdio::from(stdout.try_clone().map_err(|e| e.to_string())?));
    cmd.stderr(Stdio::from(stderr.try_clone().map_err(|e| e.to_string())?));
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    let mut child = cmd.spawn().map_err(|e| {
        VcsError::new(
            VcsErrorCode::NoGitInstalled,
            format!("无法启动 Git：{e}"),
            "请在 Git 体检中心检查系统是否已安装 Git 并加入 PATH。",
        )
        .to_wire()
    })?;
    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法保护 Git 子进程：{e}"));
        }
    };
    if let Some(input) = stdin_bytes {
        if let Some(mut child_stdin) = child.stdin.take() {
            child_stdin
                .write_all(input)
                .map_err(|e| format!("写入 Git 标准输入失败：{e}"))?;
        }
    }
    let outcome = loop {
        if stdout.metadata().map(|m| m.len()).unwrap_or(0) > MAX_STDOUT_BYTES
            || stderr.metadata().map(|m| m.len()).unwrap_or(0) > MAX_STDOUT_BYTES
        {
            break Err(VcsError::new(
                VcsErrorCode::CommandFailed,
                "Git 输出体积超过 4 MiB 上限",
                "当前差异或日志过大，请在终端执行该命令。",
            )
            .to_wire());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            Err(e) => break Err(e.to_string()),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break Err(VcsError::new(
                VcsErrorCode::Timeout,
                "Git 操作超时，已终止子进程",
                "请检查网络连接、凭据弹窗或 Hook 脚本是否卡住。",
            )
            .to_wire());
        }
        std::thread::sleep(Duration::from_millis(15));
    };
    #[cfg(windows)]
    drop(job);
    #[cfg(unix)]
    unsafe {
        libc::kill(-(child.id() as i32), libc::SIGKILL);
    }
    if outcome.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let success = outcome?;
    stdout.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    stderr.seek(SeekFrom::Start(0)).map_err(|e| e.to_string())?;
    let mut out = Vec::new();
    let mut err = Vec::new();
    stdout
        .take(MAX_STDOUT_BYTES)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    stderr
        .take(MAX_STDOUT_BYTES)
        .read_to_end(&mut err)
        .map_err(|e| e.to_string())?;
    Ok((success, out, String::from_utf8_lossy(&err).into_owned()))
}

pub fn git(
    repo: &Path,
    args: &[&str],
    policy: PromptPolicy,
    timeout: Duration,
) -> Result<String, String> {
    let (success, out, err) = run_raw(command(repo, args, policy, false), None, timeout)?;
    if success {
        Ok(String::from_utf8_lossy(&out).into_owned())
    } else {
        Err(classify_error(&err).to_wire())
    }
}

pub fn git_bytes(
    repo: &Path,
    args: &[&str],
    policy: PromptPolicy,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    let (success, out, err) = run_raw(command(repo, args, policy, false), None, timeout)?;
    if success {
        Ok(out)
    } else {
        Err(classify_error(&err).to_wire())
    }
}

pub fn git_with_stdin(
    repo: &Path,
    args: &[&str],
    stdin: &[u8],
    policy: PromptPolicy,
    timeout: Duration,
) -> Result<String, String> {
    let (success, out, err) =
        run_raw(command(repo, args, policy, true), Some(stdin), timeout)?;
    if success {
        Ok(String::from_utf8_lossy(&out).into_owned())
    } else {
        Err(classify_error(&err).to_wire())
    }
}

pub fn has_head(repo: &Path) -> Result<bool, String> {
    let (success, _, err) = run_raw(
        command(
            repo,
            &["rev-parse", "--verify", "--quiet", "HEAD"],
            PromptPolicy::SilentRead,
            false,
        ),
        None,
        Duration::from_secs(5),
    )?;
    if success || err.trim().is_empty() {
        Ok(success)
    } else {
        Err(classify_error(&err).to_wire())
    }
}

pub fn classify_error(err: &str) -> VcsError {
    let lower = err.to_lowercase();
    let trimmed = err
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .take(3)
        .collect::<Vec<_>>()
        .join(" | ");
    if lower.contains("dubious ownership") {
        VcsError::new(
            VcsErrorCode::DubiousOwnership,
            "仓库目录所有者不受 Git 信任",
            "请确认目录安全后在 Git 体检中处理或手动配置 safe.directory。",
        )
    } else if lower.contains("author identity unknown")
        || lower.contains("unable to auto-detect email address")
        || lower.contains("please tell me who you are")
    {
        VcsError::new(
            VcsErrorCode::MissingAuthorIdentity,
            "尚未配置 Git 提交姓名或邮箱",
            "请在 Git 体检中心一键填入 user.name 和 user.email 后再提交。",
        )
    } else if lower.contains("authentication")
        || lower.contains("could not read username")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied")
        || lower.contains("invalid username or password")
    {
        VcsError::new(
            VcsErrorCode::AuthRequired,
            "远程仓库需要登录凭据或授权",
            "请检查 Windows 凭据管理器、SSH Key 或 gh 登录状态后重试。",
        )
    } else if lower.contains("host key verification failed") {
        VcsError::new(
            VcsErrorCode::HostKeyUntrusted,
            "SSH 主机指纹尚未信任",
            "请先在终端连接一次目标 Git 主机并确认指纹。",
        )
    } else if lower.contains("not a git repository") {
        VcsError::new(
            VcsErrorCode::NotARepo,
            "当前目录不是 Git 仓库",
            "可以在 Git 面板点击初始化 Git 仓库。",
        )
    } else if lower.contains("no upstream branch")
        || lower.contains("has no upstream branch")
        || lower.contains("no tracking information")
    {
        VcsError::new(
            VcsErrorCode::NoUpstream,
            "当前分支尚未关联远端上游分支",
            "点击推送时可自动设置 upstream（git push -u origin）。",
        )
    } else if lower.contains("non-fast-forward")
        || lower.contains("rejected") && lower.contains("fetch first")
    {
        VcsError::new(
            VcsErrorCode::NonFastForward,
            "远端已有新提交，本地推送被拒绝",
            "请先点击拉取（Rebase）同步远端最新提交后再推送。",
        )
    } else if lower.contains("conflict")
        || lower.contains("unmerged")
        || lower.contains("could not apply")
    {
        VcsError::new(
            VcsErrorCode::MergeConflict,
            "合并或变基产生文件冲突",
            "请在 Git 面板的“合并冲突”分组打开三路合并视图解决冲突。",
        )
    } else if lower.contains("is already used by worktree")
        || lower.contains("already checked out at")
    {
        VcsError::new(
            VcsErrorCode::BranchCheckedOutElsewhere,
            "目标分支已在另一个 Worktree 中检出",
            "请直接切换到对应的 Worktree，或基于它新建分支。",
        )
    } else if lower.contains("would be overwritten by")
        || lower.contains("local changes") && lower.contains("overwritten")
    {
        VcsError::new(
            VcsErrorCode::DirtyWorktree,
            "工作区存在未保存更改，操作已中止",
            "请先暂存、提交或 Stash 当前改动后再切分支。",
        )
    } else if lower.contains("hook") || lower.contains("pre-commit") || lower.contains("commit-msg") {
        VcsError::new(
            VcsErrorCode::HookFailed,
            "Git Hook 检查未通过",
            if trimmed.is_empty() {
                "仓库本地 Hook 拦截了本次提交。".into()
            } else {
                trimmed
            },
        )
    } else {
        VcsError::new(
            VcsErrorCode::CommandFailed,
            if trimmed.is_empty() {
                "Git 操作失败".into()
            } else {
                trimmed
            },
            "可在终端核对仓库状态或打开 Git 体检检查环境。",
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn terminates_timeout() {
        #[cfg(windows)]
        let mut cmd = {
            let mut c = Command::new("powershell.exe");
            c.args(["-NoProfile", "-Command", "Start-Sleep -Seconds 30"]);
            c
        };
        #[cfg(not(windows))]
        let mut cmd = {
            let mut c = Command::new("sh");
            c.args(["-c", "sleep 30"]);
            c
        };
        crate::modules::proc::hide_console(&mut cmd);
        let started = Instant::now();
        let err = run_raw(cmd, None, Duration::from_millis(200)).unwrap_err();
        assert!(err.contains("超时"), "unexpected err: {err}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn classifies_common_errors() {
        assert_eq!(
            classify_error("Author identity unknown\nfatal: unable to auto-detect email address").code,
            VcsErrorCode::MissingAuthorIdentity
        );
        assert_eq!(
            classify_error("fatal: The current branch feat has no upstream branch.").code,
            VcsErrorCode::NoUpstream
        );
        assert_eq!(
            classify_error("fatal: 'feat' is already used by worktree at 'D:/wt'").code,
            VcsErrorCode::BranchCheckedOutElsewhere
        );
    }
}
