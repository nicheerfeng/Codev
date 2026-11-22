//! Per-device pairing. Only SHA-256 token hashes are persisted.
use super::{bridge::lock, coordinator::Host, protocol::*};
use rand::RngCore;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use subtle::ConstantTimeEq;

pub fn secret() -> String {
    let mut bytes = [0u8; 32];
    rand::rngs::OsRng.fill_bytes(&mut bytes);
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn hash(value: &str) -> String {
    format!("{:x}", Sha256::digest(value.as_bytes()))
}
pub fn equal(left: &str, right: &str) -> bool {
    hash(left).as_bytes().ct_eq(hash(right).as_bytes()).into()
}

pub struct PairingChallenge {
    pub nonce: String,
    pub code: String,
    pub expires: u64,
    pub attempts: u8,
}
pub struct DeviceRequest {
    pub name: String,
    pub claim_hash: String,
    pub expires: u64,
    pub decision: Option<bool>,
    pub issued: bool,
}
#[derive(Default)]
pub struct PairingState {
    pub challenge: Option<PairingChallenge>,
    pub pending: HashMap<String, DeviceRequest>,
    pub rates: HashMap<String, (u64, u16)>,
}
impl PairingState {
    pub fn limit(&mut self, peer: &str) -> Result<(), String> {
        let time = now();
        self.rates
            .retain(|_, (at, _)| time.saturating_sub(*at) < 60);
        if self.rates.len() > 512 && !self.rates.contains_key(peer) {
            return Err("配对请求过多，请稍后重试".into());
        }
        let entry = self.rates.entry(peer.into()).or_insert((time, 0));
        entry.1 += 1;
        if entry.1 > 40 {
            return Err("配对请求过于频繁".into());
        }
        Ok(())
    }
    pub fn pending_list(&self) -> Vec<Value> {
        self.pending
            .iter()
            .filter(|(_, r)| r.expires > now() && r.decision.is_none())
            .map(|(id, r)| json!({"id":id,"name":r.name,"expiresAt":r.expires}))
            .collect()
    }
}
impl Host {
    pub fn authenticate(&self, token: &str) -> Option<Principal> {
        if equal(token, &self.desktop_token) {
            return Some(Principal {
                id: "desktop".into(),
                desktop: true,
            });
        }
        lock(&self.store)
            .authorize_device(&hash(token))
            .map(|id| Principal { id, desktop: false })
    }
    pub fn principal_active(&self, principal: &Principal) -> bool {
        principal.desktop || lock(&self.store).device_active(&principal.id)
    }
    pub fn begin_pairing(&self) -> Result<Value, String> {
        let remote = self.remote_status();
        let port = remote
            .get("port")
            .and_then(Value::as_u64)
            .ok_or("请先开启手机连接")?;
        let nonce = secret();
        let code = format!("{:06}", rand::random::<u32>() % 1_000_000);
        let expires = now() + 300;
        lock(&self.auth).challenge = Some(PairingChallenge {
            nonce: nonce.clone(),
            code: code.clone(),
            expires,
            attempts: 0,
        });
        Ok(
            json!({"nonce":nonce,"code":code,"expiresAt":expires,"port":port,"addresses":remote.get("addresses")}),
        )
    }
    pub fn request_device(&self, peer: &str, params: Value) -> Result<Value, String> {
        let mut auth = lock(&self.auth);
        auth.limit(peer)?;
        let nonce = text(&params, "nonce");
        let code = text(&params, "code");
        let claim = text(&params, "claimSecret");
        let name = text(&params, "deviceName");
        if !(32..=256).contains(&claim.len()) || name.is_empty() || name.chars().count() > 80 {
            return Err("设备信息无效".into());
        }
        let challenge = auth
            .challenge
            .as_mut()
            .ok_or("配对已失效，请在桌面重新生成")?;
        if challenge.expires < now() || challenge.attempts >= 5 {
            return Err("配对已过期或尝试次数过多".into());
        }
        if !equal(&nonce, &challenge.nonce) || !equal(&code, &challenge.code) {
            challenge.attempts += 1;
            return Err("配对码无效".into());
        }
        auth.pending.retain(|_, r| r.expires > now());
        if auth.pending.len() >= 32 {
            return Err("待处理设备过多".into());
        }
        let id = new_id();
        auth.pending.insert(
            id.clone(),
            DeviceRequest {
                name,
                claim_hash: hash(&claim),
                expires: now() + 300,
                decision: None,
                issued: false,
            },
        );
        auth.challenge = None;
        Ok(json!({"requestId":id,"status":"pending"}))
    }
    pub fn decide_device(&self, id: &str, approve: bool) -> Result<Value, String> {
        let mut auth = lock(&self.auth);
        let device = auth.pending.get_mut(id).ok_or("设备请求不存在")?;
        if device.expires < now() || device.decision.is_some() {
            return Err("设备请求已处理或已过期".into());
        }
        device.decision = Some(approve);
        Ok(json!({"status":if approve{"approved"}else{"denied"}}))
    }
    pub fn claim_device(&self, peer: &str, params: Value) -> Result<Value, String> {
        let mut auth = lock(&self.auth);
        auth.limit(peer)?;
        let id = text(&params, "requestId");
        let claim = text(&params, "claimSecret");
        let device = auth.pending.get_mut(&id).ok_or("设备请求不存在")?;
        if device.expires < now()
            || device.issued
            || !bool::from(hash(&claim).as_bytes().ct_eq(device.claim_hash.as_bytes()))
        {
            return Err("配对请求已过期".into());
        }
        match device.decision {
            None => Ok(json!({"status":"pending"})),
            Some(false) => Err("桌面已拒绝此设备".into()),
            Some(true) => {
                let token = secret();
                let device_id = new_id();
                lock(&self.store).add_device(&device_id, &device.name, &hash(&token))?;
                device.issued = true;
                Ok(json!({"status":"approved","deviceId":device_id,"token":token}))
            }
        }
    }
}
