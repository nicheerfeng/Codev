use super::types::*;
use serde_json::{json, Value};
use std::io::Read;
use std::process::{Command, Stdio};
use std::time::Duration;

const API_TIMEOUT: Duration = Duration::from_secs(12);
const ACCEPT_JSON: &str = "application/vnd.github+json";
const ACCEPT_FULL_JSON: &str = "application/vnd.github.full+json";
const MAX_IMAGE_BYTES: usize = 8 * 1024 * 1024;
const CHECKS_CONCURRENCY: usize = 6;

pub fn parse_remote_url(raw: &str) -> Option<ForgeRepoRef> {
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return None;
    }
    let (host, path) = if let Some(rest) = trimmed.strip_prefix("git@") {
        let (h, p) = rest.split_once(':')?;
        (h.to_string(), p.to_string())
    } else if let Ok(parsed) = url::Url::parse(trimmed) {
        let h = parsed.host_str()?.to_string();
        let p = parsed.path().trim_start_matches('/').to_string();
        (h, p)
    } else {
        return None;
    };

    if !host.to_ascii_lowercase().contains("github") {
        return None;
    }
    let clean_path = path.trim_end_matches(".git").trim_matches('/');
    let mut parts = clean_path.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty() || repo.is_empty() {
        return None;
    }
    Some(ForgeRepoRef {
        provider: "github".into(),
        host,
        owner: owner.to_string(),
        repo: repo.to_string(),
        full_name: format!("{owner}/{repo}"),
    })
}

pub fn parse_repo_full_name(full_name: &str, host: Option<&str>) -> Option<ForgeRepoRef> {
    let trimmed = full_name.trim().trim_matches('/');
    let mut parts = trimmed.split('/');
    let owner = parts.next()?.trim();
    let repo = parts.next()?.trim();
    if owner.is_empty()
        || repo.is_empty()
        || parts.next().is_some()
        || owner.chars().any(char::is_whitespace)
        || repo.chars().any(char::is_whitespace)
    {
        return None;
    }
    let clean_host = host
        .map(str::trim)
        .filter(|h| !h.is_empty())
        .unwrap_or("github.com")
        .to_string();
    Some(ForgeRepoRef {
        provider: "github".into(),
        host: clean_host,
        owner: owner.to_string(),
        repo: repo.to_string(),
        full_name: format!("{owner}/{repo}"),
    })
}

pub fn fetch_user_repos(token: &str) -> Result<Vec<ForgeRepoOption>, String> {
    let url = "https://api.github.com/user/repos?sort=pushed&direction=desc&per_page=100&affiliation=owner,collaborator,organization_member";
    let arr = api_request("GET", url, Some(token), None)?;
    Ok(arr
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter_map(|item| {
            let full_name = str_field(&item, "full_name");
            let repo = str_field(&item, "name");
            let owner = item
                .get("owner")
                .map(|o| str_field(o, "login"))
                .unwrap_or_default();
            if full_name.is_empty() || owner.is_empty() || repo.is_empty() {
                return None;
            }
            let pushed_at = str_field(&item, "pushed_at");
            let updated_at = if !pushed_at.is_empty() {
                pushed_at
            } else {
                str_field(&item, "updated_at")
            };
            Some(ForgeRepoOption {
                full_name,
                owner,
                repo,
                host: "github.com".into(),
                private: item
                    .get("private")
                    .and_then(Value::as_bool)
                    .unwrap_or(false),
                open_issues_count: item
                    .get("open_issues_count")
                    .and_then(Value::as_u64)
                    .unwrap_or(0),
                updated_at,
                local_root: None,
            })
        })
        .collect())
}

pub fn detect_gh_cli() -> (bool, Option<String>) {
    let mut cmd = Command::new("gh");
    cmd.args(["auth", "token"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    crate::modules::proc::hide_console(&mut cmd);
    match cmd.output() {
        Ok(out) if out.status.success() => {
            let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
            (true, (!token.is_empty()).then_some(token))
        }
        Ok(_) => (true, None),
        Err(_) => (false, None),
    }
}

fn api_base(repo: &ForgeRepoRef) -> String {
    if repo.host.eq_ignore_ascii_case("github.com") {
        "https://api.github.com".to_string()
    } else {
        format!("https://{}/api/v3", repo.host)
    }
}

fn api_request(
    method: &str,
    url: &str,
    token: Option<&str>,
    body: Option<Value>,
) -> Result<Value, String> {
    api_request_with_accept(method, url, token, ACCEPT_JSON, body)
}

fn api_request_with_accept(
    method: &str,
    url: &str,
    token: Option<&str>,
    accept: &str,
    body: Option<Value>,
) -> Result<Value, String> {
    let mut req = ureq::request(method, url)
        .set("User-Agent", "Codev")
        .set("Accept", accept)
        .set("X-GitHub-Api-Version", "2022-11-28")
        .timeout(API_TIMEOUT);
    if let Some(tok) = token.filter(|s| !s.is_empty()) {
        req = req.set("Authorization", &format!("Bearer {tok}"));
    }
    let resp = match body {
        Some(json_body) => req.send_json(json_body),
        None => req.call(),
    }
    .map_err(|err| format!("GitHub API 请求失败：{err}"))?;

    let status = resp.status();
    if status == 204 || status == 205 {
        return Ok(Value::Null);
    }
    resp.into_json::<Value>()
        .or_else(|_| Ok(Value::Null))
}

fn body_with_resolved_assets(item: &Value) -> String {
    let body = str_field(item, "body");
    let body_html = str_field(item, "body_html");
    resolve_attachment_urls(&body, &body_html)
}

fn is_github_cdn_image_url(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://private-user-images.githubusercontent.com/")
        || lower.starts_with("https://user-images.githubusercontent.com/")
        || lower.starts_with("https://github-production-user-asset")
}

fn extract_html_image_urls(html: &str) -> Vec<String> {
    let mut urls = Vec::new();
    let lower = html.to_ascii_lowercase();
    let mut offset = 0usize;
    while let Some(pos) = lower[offset..].find("<img") {
        let start = offset + pos;
        let Some(gt_rel) = html[start..].find('>') else {
            break;
        };
        let tag = &html[start..start + gt_rel + 1];
        let tag_lower = tag.to_ascii_lowercase();
        for attr in ["src=\"", "src='"] {
            if let Some(src_pos) = tag_lower.find(attr) {
                let quote = attr.chars().last().unwrap_or('"');
                let val_start = src_pos + attr.len();
                if let Some(end_rel) = tag[val_start..].find(quote) {
                    let raw_src = tag[val_start..val_start + end_rel].replace("&amp;", "&");
                    if is_github_cdn_image_url(&raw_src) {
                        urls.push(raw_src);
                    }
                    break;
                }
            }
        }
        offset = start + gt_rel + 1;
    }
    urls
}

fn extract_asset_key(url: &str) -> Option<&str> {
    let without_query = url.split(['?', '#']).next().unwrap_or(url);
    let rest = if let Some(pos) = without_query.find("/user-attachments/assets/") {
        &without_query[pos + "/user-attachments/assets/".len()..]
    } else if let Some(pos) = without_query.find("/assets/") {
        &without_query[pos + "/assets/".len()..]
    } else {
        return None;
    };
    let tail = rest
        .trim_end_matches('/')
        .rsplit('/')
        .next()
        .unwrap_or("")
        .trim();
    if tail.len() >= 8 {
        Some(tail)
    } else {
        None
    }
}

fn is_github_attachment_span(url: &str) -> bool {
    let lower = url.to_ascii_lowercase();
    lower.starts_with("https://github.com/user-attachments/assets/")
        || (lower.starts_with("https://github.com/") && lower.contains("/assets/"))
}

fn find_github_attachment_spans(body: &str) -> Vec<(usize, usize)> {
    let mut spans = Vec::new();
    let mut offset = 0usize;
    while let Some(rel) = body[offset..].find("https://github.com/") {
        let start = offset + rel;
        let rest = &body[start..];
        let end_rel = rest
            .find(|c: char| {
                c.is_whitespace() || matches!(c, ')' | ']' | '"' | '\'' | '<' | '>' | '`')
            })
            .unwrap_or(rest.len());
        let candidate = &rest[..end_rel];
        if is_github_attachment_span(candidate) {
            spans.push((start, start + end_rel));
        }
        offset = start + end_rel.max(1);
    }
    spans
}

/// 将 Issue/PR/评论 Markdown 正文中的 `github.com/user-attachments/assets/...`
/// 替换为 GitHub API `body_html` 中已签名、无需 WebView Cookie 即可访问的 CDN 图片地址。
pub fn resolve_attachment_urls(body: &str, body_html: &str) -> String {
    if body.is_empty() || body_html.is_empty() || !body.contains("https://github.com/") {
        return body.to_string();
    }
    let html_urls = extract_html_image_urls(body_html);
    if html_urls.is_empty() {
        return body.to_string();
    }
    let spans = find_github_attachment_spans(body);
    if spans.is_empty() {
        return body.to_string();
    }

    let mut out = String::with_capacity(body.len() + 64);
    let mut cursor = 0usize;
    for (idx, (start, end)) in spans.iter().enumerate() {
        out.push_str(&body[cursor..*start]);
        let original = &body[*start..*end];
        let key = extract_asset_key(original);
        let resolved = key
            .and_then(|k| html_urls.iter().find(|u| u.contains(k)))
            .or_else(|| {
                if spans.len() == html_urls.len() {
                    html_urls.get(idx)
                } else {
                    None
                }
            });
        out.push_str(resolved.map(String::as_str).unwrap_or(original));
        cursor = *end;
    }
    out.push_str(&body[cursor..]);
    out
}

pub fn is_allowed_forge_image_host(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    lower == "github.com"
        || lower.ends_with(".github.com")
        || lower == "githubusercontent.com"
        || lower.ends_with(".githubusercontent.com")
        || (lower.starts_with("github-production-user-asset") && lower.ends_with(".amazonaws.com"))
}

fn should_send_bearer(host: &str) -> bool {
    let lower = host.trim().to_ascii_lowercase();
    lower == "github.com"
        || lower == "api.github.com"
        || lower.ends_with(".github.com")
        || lower == "raw.githubusercontent.com"
}

fn sniff_image_mime(header_ct: Option<&str>, bytes: &[u8]) -> Option<String> {
    if let Some(ct) = header_ct {
        let base = ct.split(';').next().unwrap_or("").trim().to_ascii_lowercase();
        if base.starts_with("image/") {
            return Some(base);
        }
        if base == "text/html" || base.starts_with("text/") {
            return None;
        }
    }
    if bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
        return Some("image/png".into());
    }
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        return Some("image/jpeg".into());
    }
    if bytes.starts_with(b"GIF87a") || bytes.starts_with(b"GIF89a") {
        return Some("image/gif".into());
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp".into());
    }
    None
}

/// 经桌面端网络栈（可携带 GitHub Token，避免跨站重定向泄露 Bearer）拉取 Issue/PR 内嵌图片为 data URL。
pub fn fetch_github_image(raw_url: &str, token: Option<&str>) -> Result<String, String> {
    let mut current = url::Url::parse(raw_url.trim()).map_err(|_| "无效的图片地址".to_string())?;
    let agent = ureq::AgentBuilder::new()
        .redirects(0)
        .timeout(API_TIMEOUT)
        .build();
    for _hop in 0..6 {
        if current.scheme() != "https" {
            return Err("仅支持 HTTPS GitHub 图片".into());
        }
        let host = current.host_str().unwrap_or("");
        if !is_allowed_forge_image_host(host) {
            return Err(format!("不支持的图片域名：{host}"));
        }
        let mut req = agent
            .get(current.as_str())
            .set("User-Agent", "Codev")
            .set("Accept", "image/avif,image/webp,image/png,image/jpeg,image/gif,*/*;q=0.8");
        if should_send_bearer(host) {
            if let Some(tok) = token.filter(|s| !s.is_empty()) {
                req = req.set("Authorization", &format!("Bearer {tok}"));
            }
        }
        let resp = req.call().map_err(|e| format!("拉取图片失败：{e}"))?;
        let status = resp.status();
        if (300..400).contains(&status) {
            let loc = resp
                .header("location")
                .ok_or_else(|| "图片重定向缺少 Location".to_string())?;
            current = current
                .join(loc)
                .map_err(|e| format!("无效的重定向地址：{e}"))?;
            continue;
        }
        if status >= 400 {
            return Err(format!("图片返回 HTTP {status}"));
        }
        let content_type = resp.header("content-type").map(str::to_string);
        let mut bytes = Vec::new();
        resp.into_reader()
            .take((MAX_IMAGE_BYTES + 1) as u64)
            .read_to_end(&mut bytes)
            .map_err(|e| format!("读取图片内容失败：{e}"))?;
        if bytes.len() > MAX_IMAGE_BYTES {
            return Err("图片体积超过 8MB 限制".into());
        }
        let mime = sniff_image_mime(content_type.as_deref(), &bytes)
            .ok_or_else(|| "目标未返回有效的图片格式".to_string())?;
        return Ok(format!(
            "data:{mime};base64,{}",
            crate::modules::voice::base64_encode(&bytes)
        ));
    }
    Err("图片重定向次数过多".into())
}

fn str_field(v: &Value, key: &str) -> String {
    v.get(key)
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string()
}

fn parse_number_from_api_url(url: &str) -> Option<u64> {
    url.trim_end_matches('/')
        .rsplit('/')
        .next()?
        .parse::<u64>()
        .ok()
}

fn api_url_to_html(api_url: &str, repo_full_name: &str, subject_type: &str, number: Option<u64>) -> String {
    if let Some(num) = number {
        let seg = match subject_type {
            "PullRequest" => "pull",
            "Issue" => "issues",
            _ => return format!("https://github.com/{repo_full_name}"),
        };
        format!("https://github.com/{repo_full_name}/{seg}/{num}")
    } else if !api_url.is_empty() {
        format!("https://github.com/{repo_full_name}")
    } else {
        format!("https://github.com/{repo_full_name}")
    }
}

pub fn fetch_viewer_login(token: &str) -> Option<String> {
    let val = api_request("GET", "https://api.github.com/user", Some(token), None).ok()?;
    let login = str_field(&val, "login");
    (!login.is_empty()).then_some(login)
}

pub fn fetch_notifications(
    repo: &ForgeRepoRef,
    token: &str,
) -> Result<Vec<ForgeNotification>, String> {
    let base = api_base(repo);
    let url = format!("{base}/repos/{}/{}/notifications?all=true&per_page=30", repo.owner, repo.repo);
    let arr = api_request("GET", &url, Some(token), None)?;
    let list = arr
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|item| {
            let subject = item.get("subject").cloned().unwrap_or(Value::Null);
            let subject_type = str_field(&subject, "type");
            let api_subject_url = str_field(&subject, "url");
            let number = parse_number_from_api_url(&api_subject_url);
            let repo_full = item
                .get("repository")
                .and_then(|r| r.get("full_name"))
                .and_then(Value::as_str)
                .map(str::to_string)
                .unwrap_or_else(|| repo.full_name.clone());
            ForgeNotification {
                id: str_field(&item, "id"),
                reason: str_field(&item, "reason"),
                unread: item.get("unread").and_then(Value::as_bool).unwrap_or(false),
                html_url: api_url_to_html(&api_subject_url, &repo_full, &subject_type, number),
                subject_type,
                title: str_field(&subject, "title"),
                number,
                repo_full_name: repo_full,
                updated_at: str_field(&item, "updated_at"),
            }
        })
        .collect();
    Ok(list)
}

pub fn fetch_issues(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    state: &str,
    viewer_login: Option<&str>,
) -> Result<Vec<ForgeIssue>, String> {
    let base = api_base(repo);
    let state_param = if matches!(state, "closed" | "all") { state } else { "open" };
    let url = format!(
        "{base}/repos/{}/{}/issues?state={state_param}&sort=updated&direction=desc&per_page=40",
        repo.owner, repo.repo
    );
    let arr = api_request_with_accept("GET", &url, token, ACCEPT_FULL_JSON, None)?;
    let issues = arr
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|item| item.get("pull_request").is_none())
        .map(|item| {
            let labels = item
                .get("labels")
                .and_then(Value::as_array)
                .map(|arr| {
                    arr.iter()
                        .map(|l| ForgeLabel {
                            name: str_field(l, "name"),
                            color: str_field(l, "color"),
                        })
                        .collect()
                })
                .unwrap_or_default();
            let is_assigned_to_me = viewer_login.is_some_and(|me| {
                item.get("assignees")
                    .and_then(Value::as_array)
                    .is_some_and(|a| a.iter().any(|u| str_field(u, "login") == me))
            });
            ForgeIssue {
                id: item.get("id").and_then(Value::as_u64).unwrap_or(0),
                number: item.get("number").and_then(Value::as_u64).unwrap_or(0),
                title: str_field(&item, "title"),
                state: str_field(&item, "state"),
                body: body_with_resolved_assets(&item),
                author: item
                    .get("user")
                    .map(|u| str_field(u, "login"))
                    .unwrap_or_default(),
                labels,
                comments_count: item.get("comments").and_then(Value::as_u64).unwrap_or(0),
                updated_at: str_field(&item, "updated_at"),
                html_url: str_field(&item, "html_url"),
                is_assigned_to_me,
            }
        })
        .collect();
    Ok(issues)
}

pub fn fetch_pulls(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    state: &str,
) -> Result<Vec<ForgePullRequest>, String> {
    let base = api_base(repo);
    let state_param = if matches!(state, "closed" | "all") { state } else { "open" };
    let url = format!(
        "{base}/repos/{}/{}/pulls?state={state_param}&sort=updated&direction=desc&per_page=25",
        repo.owner, repo.repo
    );
    let arr = api_request_with_accept("GET", &url, token, ACCEPT_FULL_JSON, None)?;
    let raw_items = arr.as_array().cloned().unwrap_or_default();
    let mut pulls = Vec::with_capacity(raw_items.len());
    for item in &raw_items {
        let head = item.get("head").cloned().unwrap_or(Value::Null);
        let base_obj = item.get("base").cloned().unwrap_or(Value::Null);
        let head_sha = str_field(&head, "sha");
        pulls.push(ForgePullRequest {
            id: item.get("id").and_then(Value::as_u64).unwrap_or(0),
            number: item.get("number").and_then(Value::as_u64).unwrap_or(0),
            title: str_field(item, "title"),
            state: str_field(item, "state"),
            draft: item.get("draft").and_then(Value::as_bool).unwrap_or(false),
            body: body_with_resolved_assets(item),
            author: item
                .get("user")
                .map(|u| str_field(u, "login"))
                .unwrap_or_default(),
            head_ref: str_field(&head, "ref"),
            base_ref: str_field(&base_obj, "ref"),
            head_sha,
            updated_at: str_field(item, "updated_at"),
            html_url: str_field(item, "html_url"),
            checks_status: "neutral".into(),
        });
    }
    let shas: Vec<String> = pulls.iter().map(|p| p.head_sha.clone()).collect();
    let mut statuses = vec!["neutral".to_string(); pulls.len()];
    for chunk_start in (0..shas.len()).step_by(CHECKS_CONCURRENCY) {
        let chunk_end = (chunk_start + CHECKS_CONCURRENCY).min(shas.len());
        std::thread::scope(|scope| {
            let mut handles = Vec::new();
            for (offset, sha) in shas[chunk_start..chunk_end].iter().enumerate() {
                if sha.is_empty() {
                    continue;
                }
                let sha_ref = sha.as_str();
                handles.push((
                    chunk_start + offset,
                    scope.spawn(move || {
                        fetch_combined_checks_status(repo, token, sha_ref)
                            .unwrap_or_else(|_| "neutral".into())
                    }),
                ));
            }
            for (idx, handle) in handles {
                if let Ok(status) = handle.join() {
                    statuses[idx] = status;
                }
            }
        });
    }
    for (pull, status) in pulls.iter_mut().zip(statuses.into_iter()) {
        pull.checks_status = status;
    }
    Ok(pulls)
}

fn fetch_combined_checks_status(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    sha: &str,
) -> Result<String, String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/commits/{sha}/check-runs?per_page=30",
        repo.owner, repo.repo
    );
    let val = api_request("GET", &url, token, None)?;
    let runs = val
        .get("check_runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    if runs.is_empty() {
        return Ok("neutral".into());
    }
    if runs.iter().any(|r| {
        matches!(
            r.get("conclusion").and_then(Value::as_str),
            Some("failure" | "timed_out" | "cancelled" | "action_required")
        )
    }) {
        return Ok("failure".into());
    }
    if runs
        .iter()
        .any(|r| r.get("status").and_then(Value::as_str) != Some("completed"))
    {
        return Ok("pending".into());
    }
    Ok("success".into())
}

pub fn fetch_comments(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    number: u64,
) -> Result<Vec<ForgeComment>, String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/issues/{number}/comments?per_page=60",
        repo.owner, repo.repo
    );
    let val = api_request_with_accept("GET", &url, token, ACCEPT_FULL_JSON, None)?;
    Ok(val
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|c| ForgeComment {
            id: c.get("id").and_then(Value::as_u64).unwrap_or(0),
            author: c
                .get("user")
                .map(|u| str_field(u, "login"))
                .unwrap_or_default(),
            body: body_with_resolved_assets(&c),
            created_at: str_field(&c, "created_at"),
            html_url: str_field(&c, "html_url"),
        })
        .collect())
}

pub fn fetch_pr_checks(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    sha: &str,
) -> Result<Vec<ForgeCheckRun>, String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/commits/{sha}/check-runs?per_page=40",
        repo.owner, repo.repo
    );
    let val = api_request("GET", &url, token, None)?;
    Ok(val
        .get("check_runs")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|r| ForgeCheckRun {
            id: r.get("id").and_then(Value::as_u64).unwrap_or(0),
            name: str_field(&r, "name"),
            status: str_field(&r, "status"),
            conclusion: r.get("conclusion").and_then(Value::as_str).map(str::to_string),
            html_url: str_field(&r, "html_url"),
        })
        .collect())
}

pub fn fetch_pr_files(
    repo: &ForgeRepoRef,
    token: Option<&str>,
    number: u64,
) -> Result<Vec<ForgePrFile>, String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/pulls/{number}/files?per_page=60",
        repo.owner, repo.repo
    );
    let val = api_request("GET", &url, token, None)?;
    Ok(val
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .map(|f| ForgePrFile {
            filename: str_field(&f, "filename"),
            status: str_field(&f, "status"),
            additions: f.get("additions").and_then(Value::as_u64).unwrap_or(0),
            deletions: f.get("deletions").and_then(Value::as_u64).unwrap_or(0),
            patch: f.get("patch").and_then(Value::as_str).map(str::to_string),
        })
        .collect())
}

pub fn create_comment(
    repo: &ForgeRepoRef,
    token: &str,
    number: u64,
    body: &str,
) -> Result<ForgeComment, String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/issues/{number}/comments",
        repo.owner, repo.repo
    );
    let c = api_request("POST", &url, Some(token), Some(json!({ "body": body })))?;
    Ok(ForgeComment {
        id: c.get("id").and_then(Value::as_u64).unwrap_or(0),
        author: c
            .get("user")
            .map(|u| str_field(u, "login"))
            .unwrap_or_default(),
        body: str_field(&c, "body"),
        created_at: str_field(&c, "created_at"),
        html_url: str_field(&c, "html_url"),
    })
}

pub fn create_issue(
    repo: &ForgeRepoRef,
    token: &str,
    title: &str,
    body: &str,
) -> Result<ForgeIssue, String> {
    let base = api_base(repo);
    let url = format!("{base}/repos/{}/{}/issues", repo.owner, repo.repo);
    let item = api_request(
        "POST",
        &url,
        Some(token),
        Some(json!({ "title": title, "body": body })),
    )?;
    Ok(ForgeIssue {
        id: item.get("id").and_then(Value::as_u64).unwrap_or(0),
        number: item.get("number").and_then(Value::as_u64).unwrap_or(0),
        title: str_field(&item, "title"),
        state: str_field(&item, "state"),
        body: str_field(&item, "body"),
        author: item
            .get("user")
            .map(|u| str_field(u, "login"))
            .unwrap_or_default(),
        labels: vec![],
        comments_count: 0,
        updated_at: str_field(&item, "updated_at"),
        html_url: str_field(&item, "html_url"),
        is_assigned_to_me: false,
    })
}

pub fn set_issue_state(
    repo: &ForgeRepoRef,
    token: &str,
    number: u64,
    state: &str,
) -> Result<(), String> {
    let base = api_base(repo);
    let url = format!("{base}/repos/{}/{}/issues/{number}", repo.owner, repo.repo);
    api_request("PATCH", &url, Some(token), Some(json!({ "state": state })))?;
    Ok(())
}

pub fn merge_pull_request(
    repo: &ForgeRepoRef,
    token: &str,
    number: u64,
    merge_method: &str,
) -> Result<(), String> {
    let base = api_base(repo);
    let url = format!(
        "{base}/repos/{}/{}/pulls/{number}/merge",
        repo.owner, repo.repo
    );
    let method = if matches!(merge_method, "squash" | "rebase") {
        merge_method
    } else {
        "merge"
    };
    api_request(
        "PUT",
        &url,
        Some(token),
        Some(json!({ "merge_method": method })),
    )?;
    Ok(())
}

pub fn mark_notification_read(
    repo: &ForgeRepoRef,
    token: &str,
    thread_id: &str,
) -> Result<(), String> {
    let base = api_base(repo);
    let url = format!("{base}/notifications/threads/{thread_id}");
    api_request("PATCH", &url, Some(token), None)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_github_ssh_and_https_remotes() {
        let ssh = parse_remote_url("git@github.com:nicheerfeng/Codev.git").unwrap();
        assert_eq!(ssh.owner, "nicheerfeng");
        assert_eq!(ssh.repo, "Codev");
        assert_eq!(ssh.full_name, "nicheerfeng/Codev");

        let https = parse_remote_url("https://github.com/octocat/Hello-World").unwrap();
        assert_eq!(https.full_name, "octocat/Hello-World");

        assert!(parse_remote_url("https://example.com/a/b.git").is_none());
    }

    #[test]
    fn parses_repo_full_name_safely() {
        let r = parse_repo_full_name(" nicheerfeng/Codev ", None).unwrap();
        assert_eq!(r.owner, "nicheerfeng");
        assert_eq!(r.repo, "Codev");
        assert_eq!(r.host, "github.com");
        assert!(parse_repo_full_name("invalid", None).is_none());
        assert!(parse_repo_full_name("a/b/c", None).is_none());
    }

    #[test]
    fn resolves_private_github_attachment_urls_from_body_html() {
        let md = "前文\n\n![img](https://github.com/user-attachments/assets/abc12345-dead-beef)\n\n<img width=\"600\" src=\"https://github.com/owner/repo/assets/123/def67890-feed-face\" />";
        let html = r#"<p>前文</p><p><a href="https://private-user-images.githubusercontent.com/1/abc12345-dead-beef.png?jwt=tok1"><img src="https://private-user-images.githubusercontent.com/1/abc12345-dead-beef.png?jwt=tok1&amp;v=2"></a></p><p><img width="600" src="https://private-user-images.githubusercontent.com/1/def67890-feed-face.png?jwt=tok2"></p>"#;
        let resolved = resolve_attachment_urls(md, html);
        assert!(resolved.contains("https://private-user-images.githubusercontent.com/1/abc12345-dead-beef.png?jwt=tok1&v=2"));
        assert!(resolved.contains("https://private-user-images.githubusercontent.com/1/def67890-feed-face.png?jwt=tok2"));
        assert!(!resolved.contains("https://github.com/user-attachments/assets/"));
    }

    #[test]
    fn restricts_forge_image_proxy_to_github_hosts() {
        assert!(is_allowed_forge_image_host("github.com"));
        assert!(is_allowed_forge_image_host("private-user-images.githubusercontent.com"));
        assert!(is_allowed_forge_image_host("raw.githubusercontent.com"));
        assert!(is_allowed_forge_image_host(
            "github-production-user-asset-6210df.s3.amazonaws.com"
        ));
        assert!(!is_allowed_forge_image_host("example.com"));
        assert!(!is_allowed_forge_image_host("127.0.0.1"));
    }
}
