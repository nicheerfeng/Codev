use std::io::{Read, Seek, SeekFrom};
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicUsize, Ordering};
use std::time::{Duration, Instant};

static RUNNING: AtomicUsize = AtomicUsize::new(0);
const OUTPUT_LIMIT: u64 = 8 * 1024 * 1024;

struct Permit;
impl Drop for Permit {
    /// 释放 Git 子进程并发名额。
    fn drop(&mut self) {
        RUNNING.fetch_sub(1, Ordering::SeqCst);
    }
}

/// 限制同时运行的 Git 命令，等待也计入超时。
fn acquire(deadline: Instant) -> Result<Permit, String> {
    loop {
        if RUNNING
            .fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| {
                (n < 2).then_some(n + 1)
            })
            .is_ok()
        {
            return Ok(Permit);
        }
        if Instant::now() >= deadline {
            return Err("Git 操作繁忙，请稍后重试".into());
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// 所有 Git 命令静默运行；禁止交互认证、分页及隐式维护。
pub(super) fn command(repo: &Path, args: &[&str]) -> Command {
    let mut cmd = Command::new("git");
    cmd.arg("--no-pager")
        .args([
            "-c",
            "credential.interactive=false",
            "-c",
            "maintenance.auto=false",
            "-c",
            "gc.auto=0",
            "-c",
            "core.fsmonitor=false",
        ])
        .arg("-C")
        .arg(repo)
        .args(args)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GCM_INTERACTIVE", "Never")
        .env("GIT_ASKPASS", "")
        .env("SSH_ASKPASS", "")
        .env(
            "GIT_SSH_COMMAND",
            "ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ConnectTimeout=5",
        )
        .env("GIT_OPTIONAL_LOCKS", "0")
        .env("GIT_LITERAL_PATHSPECS", "1")
        .stdin(Stdio::null());
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

/// 到期终止整个子进程树，输出写临时文件避免管道塞满导致等待失效。
fn run(mut cmd: Command, timeout: Duration) -> Result<(bool, String, String), String> {
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
    let mut child = cmd
        .spawn()
        .map_err(|e| format!("无法启动 Git，请确认已安装 Git：{e}"))?;
    #[cfg(windows)]
    let job = match crate::modules::proc::job::ProcessJob::create_for(child.id()) {
        Ok(job) => job,
        Err(e) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("无法保护 Git 子进程：{e}"));
        }
    };
    let outcome = loop {
        if stdout.metadata().map(|m| m.len()).unwrap_or(0) > OUTPUT_LIMIT
            || stderr.metadata().map(|m| m.len()).unwrap_or(0) > OUTPUT_LIMIT
        {
            break Err("Git 输出超过限制，请在终端查看".to_string());
        }
        match child.try_wait() {
            Ok(Some(status)) => break Ok(status.success()),
            Err(e) => break Err(e.to_string()),
            Ok(None) => {}
        }
        if Instant::now() >= deadline {
            break Err("Git 操作超时，已停止子进程".into());
        }
        std::thread::sleep(Duration::from_millis(20));
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
        .take(OUTPUT_LIMIT)
        .read_to_end(&mut out)
        .map_err(|e| e.to_string())?;
    stderr
        .take(OUTPUT_LIMIT)
        .read_to_end(&mut err)
        .map_err(|e| e.to_string())?;
    Ok((
        success,
        String::from_utf8_lossy(&out).into_owned(),
        String::from_utf8_lossy(&err).into_owned(),
    ))
}

/// Missing HEAD is normal for a newly initialized repository.
pub(super) fn has_head(repo: &Path) -> Result<bool, String> {
    let (success, _, err) = run(
        command(repo, &["rev-parse", "--verify", "--quiet", "HEAD"]),
        Duration::from_secs(5),
    )?;
    if success || err.trim().is_empty() {
        Ok(success)
    } else {
        Err(failure_message(&err))
    }
}

/// 只返回安全的错误类别，避免远端 URL、凭据或 hook 输出泄漏到界面。
pub(super) fn git(repo: &Path, args: &[&str], timeout: Duration) -> Result<String, String> {
    let (success, out, err) = run(command(repo, args), timeout)?;
    if success {
        return Ok(out);
    }
    Err(failure_message(&err))
}

fn failure_message(err: &str) -> String {
    let lower = err.to_lowercase();
    let message = if lower.contains("dubious ownership") {
        "仓库所有者不受 Git 信任；请核实目录所有者后在终端处理，不会自动修改 safe.directory"
    } else if lower.contains("authentication")
        || lower.contains("terminal prompts disabled")
        || lower.contains("permission denied")
    {
        "Git 认证或权限不足，请先在终端完成认证后重试"
    } else if lower.contains("host key verification failed") {
        "SSH 主机密钥未受信任，请在终端核实主机身份"
    } else if lower.contains("not a git repository") {
        "所选目录已不是 Git 仓库，请刷新工作区"
    } else {
        "Git 操作未完成，请在终端检查仓库状态、网络或 Git 配置"
    };
    message.into()
}

#[cfg(test)]
mod tests {
    use super::*;
    /// 真实子进程超时后必须退出，不只丢弃等待结果。
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
        assert!(run(cmd, Duration::from_millis(200))
            .unwrap_err()
            .contains("超时"));
        assert!(started.elapsed() < Duration::from_secs(5));
    }
}
