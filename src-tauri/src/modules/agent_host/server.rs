use super::{bridge::lock, coordinator::Host, protocol::*};
use axum::{
    extract::{
        ws::{Message as WsMessage, WebSocket, WebSocketUpgrade},
        ConnectInfo, State,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Redirect, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    net::{IpAddr, Ipv4Addr, SocketAddr},
    path::PathBuf,
    sync::Arc,
    time::Duration,
};
use tokio::{
    net::TcpListener,
    sync::{mpsc, oneshot, Semaphore},
};
use tower_http::services::ServeDir;

pub struct RemoteListener {
    pub port: u16,
    pub stop: oneshot::Sender<()>,
}
fn token(headers: &HeaderMap) -> Option<String> {
    headers
        .get("authorization")
        .and_then(|h| h.to_str().ok())
        .and_then(|s| s.strip_prefix("Bearer "))
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("sec-websocket-protocol")
                .and_then(|h| h.to_str().ok())
                .and_then(|s| {
                    s.split(',')
                        .map(str::trim)
                        .find_map(|s| s.strip_prefix("codev-token.").map(str::to_string))
                })
        })
}
fn authorize(host: &Host, headers: &HeaderMap) -> Result<Principal, Response> {
    token(headers)
        .and_then(|t| host.authenticate(&t))
        .ok_or_else(|| {
            (
                StatusCode::UNAUTHORIZED,
                Json(json!({"error":"设备未授权或已被吊销"})),
            )
                .into_response()
        })
}
fn error_response(error: String) -> Response {
    (StatusCode::BAD_REQUEST, Json(json!({"error":error}))).into_response()
}
fn same_origin(headers: &HeaderMap) -> bool {
    let Some(origin) = headers.get("origin").and_then(|h| h.to_str().ok()) else {
        return true;
    };
    if origin == "tauri://localhost"
        || origin == "http://tauri.localhost"
        || origin == "https://tauri.localhost"
    {
        return true;
    }
    let Some(host) = headers.get("host").and_then(|h| h.to_str().ok()) else {
        return false;
    };
    if origin == format!("http://{host}") || origin == format!("https://{host}") {
        return true;
    }
    origin == "http://localhost:1420" || origin == "http://127.0.0.1:1420"
}
fn router(host: Arc<Host>) -> Router {
    let static_files = ServeDir::new(&host.web_directory);
    Router::new()
        .route("/", get(|| async { Redirect::temporary("/mobile.html") }))
        .route(
            "/v1/health",
            get(|| async { Json(json!({"ok":true,"protocolVersion":PROTOCOL_VERSION})) }),
        )
        .route("/v1/bootstrap", get(bootstrap))
        .route("/v1/ws", get(socket))
        .route("/v1/sessions", get(sessions))
        .route("/v1/workspaces", get(workspaces))
        .route("/v1/pair/request", post(pair_request))
        .route("/v1/pair/claim", post(pair_claim))
        .layer(axum::extract::DefaultBodyLimit::max(64 * 1024))
        .fallback_service(static_files)
        .with_state(host)
}
async fn bootstrap(State(host): State<Arc<Host>>, headers: HeaderMap) -> Response {
    match authorize(&host, &headers) {
        Ok(principal) => Json(host.snapshot_for(principal.desktop)).into_response(),
        Err(e) => e,
    }
}
async fn sessions(State(host): State<Arc<Host>>, headers: HeaderMap) -> Response {
    match authorize(&host, &headers) {
        Ok(principal) => {
            Json(host.snapshot_for(principal.desktop)["sessions"].clone()).into_response()
        }
        Err(e) => e,
    }
}
async fn workspaces(State(host): State<Arc<Host>>, headers: HeaderMap) -> Response {
    match authorize(&host, &headers) {
        Ok(principal) => {
            Json(host.snapshot_for(principal.desktop)["workspaces"].clone()).into_response()
        }
        Err(e) => e,
    }
}
async fn pair_request(
    State(host): State<Arc<Host>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(params): Json<Value>,
) -> Response {
    if !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match host.request_device(&peer.ip().to_string(), params) {
        Ok(v) => Json(v).into_response(),
        Err(e) => error_response(e),
    }
}
async fn pair_claim(
    State(host): State<Arc<Host>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
    Json(params): Json<Value>,
) -> Response {
    if !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    match host.claim_device(&peer.ip().to_string(), params) {
        Ok(v) => Json(v).into_response(),
        Err(e) => error_response(e),
    }
}
async fn socket(
    State(host): State<Arc<Host>>,
    headers: HeaderMap,
    ws: WebSocketUpgrade,
) -> Response {
    if !same_origin(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    let principal = match authorize(&host, &headers) {
        Ok(p) => p,
        Err(e) => return e,
    };
    ws.protocols(["codev-events"])
        .max_message_size(MAX_FRAME_BYTES)
        .max_frame_size(MAX_FRAME_BYTES)
        .on_upgrade(move |socket| connection(host, principal, socket))
}
async fn connection(host: Arc<Host>, principal: Principal, socket: WebSocket) {
    let (mut send, mut receive) = socket.split();
    let mut events = host.events.subscribe();
    let (replies, mut response) = mpsc::channel::<Value>(32);
    let capacity = Arc::new(Semaphore::new(24));
    let mut subscribed = HashSet::<String>::new();
    let mut tick = tokio::time::interval(Duration::from_secs(15));
    let snapshot = host.snapshot_for(principal.desktop);
    let mut sequence = snapshot["sequence"].as_u64().unwrap_or(0);
    if send
        .send(WsMessage::Text(
            json!({"type":"snapshot","snapshot":snapshot})
                .to_string()
                .into(),
        ))
        .await
        .is_err()
    {
        return;
    }
    loop {
        tokio::select! {
            _=host.shutdown.notified()=>break,
            message=receive.next()=>{
                match message{
                    Some(Ok(WsMessage::Text(raw)))=>{
                        let command=match serde_json::from_str::<Command>(&raw){Ok(c)=>c,Err(e)=>{let _=send.send(WsMessage::Text(json!({"type":"protocol.error","error":e.to_string()}).to_string().into())).await;continue;}};
                        if !host.principal_active(&principal){break;}
                        if matches!(command.operation.as_str(),"session.open"|"runtime.subscribe"|"session.connect"){if let Some(id)=&command.session_id{subscribed.insert(id.clone());}}
                        if command.operation=="runtime.unsubscribe"{if let Some(id)=&command.session_id{subscribed.remove(id);}let _=send.send(WsMessage::Text(json!({"type":"response","requestId":command.request_id,"ok":true,"data":{}}).to_string().into())).await;continue;}
                        let Ok(permit)=capacity.clone().try_acquire_owned()else{let _=send.send(WsMessage::Text(json!({"type":"response","requestId":command.request_id,"ok":false,"error":"并发请求过多"}).to_string().into())).await;continue;};
                        let host=host.clone();let principal=principal.clone();let replies=replies.clone();
                        tokio::spawn(async move{let request_id=command.request_id.clone();let result=host.dispatch(&principal,command).await;let value=match result{Ok(data)=>json!({"type":"response","requestId":request_id,"ok":true,"data":data}),Err(error)=>json!({"type":"response","requestId":request_id,"ok":false,"error":error})};let _=replies.send(value).await;drop(permit);});
                    },
                    Some(Ok(WsMessage::Close(_)))|None|Some(Err(_))=>break,
                    Some(Ok(WsMessage::Ping(bytes)))=>{if send.send(WsMessage::Pong(bytes)).await.is_err(){break;}},
                    _=>{}
                }
            },
            Some(reply)=response.recv()=>{if send.send(WsMessage::Text(reply.to_string().into())).await.is_err(){break;}},
            event=events.recv()=>{
                let event=match event{
                    Ok(mut event)=>{if event.sequence<=sequence{continue;}sequence=event.sequence;
                        if event.kind=="session.patch" && !event.session_id.as_ref().map(|id|subscribed.contains(id)).unwrap_or(false){event.kind="session.summary".into();event.payload=event.payload.get("summary").cloned().unwrap_or(Value::Null);}
                        if !principal.desktop{redact_event(&mut event);}
                        json!({"type":"event","event":event})
                    },
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_))=>{let snapshot=host.snapshot_for(principal.desktop);sequence=snapshot["sequence"].as_u64().unwrap_or(0);json!({"type":"resync","snapshot":snapshot})},
                    Err(_)=>break,
                };
                if tokio::time::timeout(Duration::from_secs(10),send.send(WsMessage::Text(event.to_string().into()))).await.map(|r|r.is_err()).unwrap_or(true){break;}
            },
            _=tick.tick()=>{
                if !host.principal_active(&principal){break;}
                if !principal.desktop && !host.remote_active(){break;}
                if send.send(WsMessage::Ping(Vec::new().into())).await.is_err(){break;}
            }
        }
    }
    let _ = send.close().await;
}

pub async fn start_local(host: Arc<Host>) -> Result<u16, String> {
    let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))
        .await
        .map_err(|e| e.to_string())?;
    let port = listener.local_addr().map_err(|e| e.to_string())?.port();
    tokio::spawn(async move {
        let cloned = host.clone();
        let result = axum::serve(
            listener,
            router(cloned).into_make_service_with_connect_info::<SocketAddr>(),
        )
        .with_graceful_shutdown(async move { host.shutdown.notified().await })
        .await;
        if let Err(e) = result {
            log::error!("agent host listener: {e}");
        }
    });
    Ok(port)
}
impl Host {
    pub async fn enable_remote(self: &Arc<Self>, port: u16) -> Result<Value, String> {
        if port == 0 {
            return Err("请输入 1–65535 的端口".into());
        }
        if lock(&self.remote).is_some() {
            return Ok(self.remote_status());
        }
        let listener = TcpListener::bind((Ipv4Addr::UNSPECIFIED, port))
            .await
            .map_err(|e| format!("无法监听手机连接端口：{e}"))?;
        let (stop, mut stopped) = oneshot::channel();
        {
            let mut remote = lock(&self.remote);
            if remote.is_some() {
                return Ok(json!({"enabled":true,"port":port}));
            }
            *remote = Some(RemoteListener { port, stop });
        }
        let host = self.clone();
        tokio::spawn(async move {
            let state = host.clone();
            let _ = axum::serve(
                listener,
                router(state).into_make_service_with_connect_info::<SocketAddr>(),
            )
            .with_graceful_shutdown(async move {
                tokio::select! {_=host.shutdown.notified()=>{},_=&mut stopped=>{}}
            })
            .await;
        });
        self.remote_enabled
            .store(true, std::sync::atomic::Ordering::Release);
        Ok(self.remote_status())
    }
    pub fn disable_remote(&self) {
        self.remote_enabled
            .store(false, std::sync::atomic::Ordering::Release);
        if let Some(listener) = lock(&self.remote).take() {
            let _ = listener.stop.send(());
        }
        let mut auth = lock(&self.auth);
        auth.challenge = None;
        auth.pending.clear();
    }
    pub fn remote_status(&self) -> Value {
        if let Some(listener) = lock(&self.remote).as_ref() {
            let port = listener.port;
            let mut addresses = vec![format!("http://127.0.0.1:{port}")];
            // Discover the route's LAN address without opening an outbound connection.
            if let Ok(socket) = std::net::UdpSocket::bind((Ipv4Addr::UNSPECIFIED, 0)) {
                if socket.connect("192.0.2.1:80").is_ok() {
                    if let Ok(addr) = socket.local_addr() {
                        if !addr.ip().is_loopback()
                            && addr.ip() != IpAddr::V4(Ipv4Addr::UNSPECIFIED)
                        {
                            addresses.push(format!("http://{}:{port}", addr.ip()));
                        }
                    }
                }
            }
            json!({"enabled":true,"port":port,"addresses":addresses,"encrypted":false})
        } else {
            json!({"enabled":false})
        }
    }
}

fn redact_event(event: &mut Event) {
    match event.kind.as_str() {
        "session.patch" => {
            if let Some(view) = event.payload.get_mut("view").and_then(Value::as_object_mut) {
                view.remove("nativeSessionId");
                view.remove("nativeSessionPath");
            }
        }
        "host.changed" => {
            if let Some(harnesses) = event.payload.get_mut("harnesses").and_then(Value::as_array_mut) {
                for harness in harnesses {
                    if let Some(object) = harness.as_object_mut() {
                        object.remove("command");
                        object.remove("args");
                    }
                }
            }
        }
        _ => {}
    }
}

pub fn find_web_directory() -> PathBuf {
    if let Some(directory) = std::env::var_os("CODEV_WEB_DIR") {
        return PathBuf::from(directory);
    }
    if let Ok(exe) = std::env::current_exe() {
        if let Some(parent) = exe.parent() {
            for path in [
                parent.join("web"),
                parent.join("resources/web"),
                parent.join("../Resources/web"),
            ] {
                if path.join("mobile.html").is_file() {
                    return path;
                }
            }
        }
    }
    PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../dist")
}

pub async fn run_standalone() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let mut port = 3080u16;
    let mut bind = Ipv4Addr::LOCALHOST.to_string();
    let mut workspaces = vec![];
    let mut directory = std::env::var_os("CODEV_DATA_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            dirs::data_local_dir()
                .unwrap_or_else(std::env::temp_dir)
                .join("codev-agent-host")
        });
    while let Some(arg) = args.next() {
        match arg.as_str() {
            "--port" => {
                port = args
                    .next()
                    .ok_or("缺少端口")?
                    .parse()
                    .map_err(|_| "端口无效")?
            }
            "--host" => bind = args.next().ok_or("缺少绑定地址")?,
            "--workspace" => workspaces.push(args.next().ok_or("缺少工作区路径")?),
            "--data-dir" => directory = PathBuf::from(args.next().ok_or("缺少数据目录")?),
            "--help" | "-h" => {
                println!("codev-server [--host 127.0.0.1] [--port 3080] [--workspace PATH] [--data-dir PATH]\nCODEV_WEB_DIR 指定包含 mobile.html 的前端产物目录");
                return Ok(());
            }
            _ => return Err(format!("未知参数：{arg}")),
        }
    }
    let host = Host::open(directory, find_web_directory())?;
    host.remote_enabled
        .store(true, std::sync::atomic::Ordering::Release);
    host.start_background();
    for path in workspaces {
        host.workspace(&path)?;
    }
    if let Err(error) = host.refresh_native_history().await {
        log::warn!("原生会话刷新失败：{error}");
    }
    let listener = TcpListener::bind(format!("{bind}:{port}"))
        .await
        .map_err(|e| e.to_string())?;
    println!(
        "Codev Agent Host: http://{bind}:{port}\nAccess token: {}\n关闭终端前请先停止运行任务。",
        host.desktop_token
    );
    let cloned = host.clone();
    let stopping = host.clone();
    let result = axum::serve(
        listener,
        router(cloned).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(async move {
        let _ = tokio::signal::ctrl_c().await;
        stopping.close_all();
    })
    .await;
    host.close_all();
    result.map_err(|e| e.to_string())
}
