use reqwest::Client;
use serde::Serialize;
use serde_json::{Value};
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::RwLock;
use tokio::time::{sleep, Duration};
use tracing::info;
use base64::{engine::general_purpose::STANDARD, Engine};

use crate::ai::error::AIError;
use crate::ai::{
    AIProvider, GenerateRequest, ProviderTaskHandle, ProviderTaskPollResult, ProviderTaskSubmission,
};

const GENERATE_ENDPOINT_PATH: &str = "/v1/api/generate";
const RESULT_ENDPOINT_PATH: &str = "/v1/api/result";
const DEFAULT_BASE_URL: &str = "https://grsai.dakka.com.cn";
const DEFAULT_PRO_MODEL: &str = "nano-banana-pro";
const POLL_INTERVAL_MS: u64 = 2000;

const SUPPORTED_MODELS: [&str; 11] = [
    "nano-banana-2",
    "nano-banana-pro",
    "nano-banana-pro-vt",
    "nano-banana-pro-cl",
    "nano-banana-pro-vip",
    "nano-banana-pro-4k-vip",
    "grsai/nano-banana-pro",
    "gpt-image-2",
    "gpt-image-2-vip",
    "grsai/gpt-image-2",
    "grsai/gpt-image-2-vip",
];

fn decode_file_url_path(value: &str) -> String {
    let raw = value.trim_start_matches("file://");
    let decoded = urlencoding::decode(raw)
        .map(|result| result.into_owned())
        .unwrap_or_else(|_| raw.to_string());
    let normalized = if decoded.starts_with('/')
        && decoded.len() > 2
        && decoded.as_bytes().get(2) == Some(&b':')
    {
        &decoded[1..]
    } else {
        &decoded
    };
    normalized.to_string()
}

fn encode_reference_for_grsai(source: &str) -> Option<String> {
    let trimmed = source.trim();
    if trimmed.is_empty() {
        return None;
    }

    if trimmed.starts_with("http://") || trimmed.starts_with("https://") {
        return Some(trimmed.to_string());
    }

    if let Some((meta, payload)) = trimmed.split_once(',') {
        if meta.starts_with("data:") && meta.ends_with(";base64") && !payload.is_empty() {
            return Some(payload.to_string());
        }
    }

    let likely_base64 = trimmed.len() > 256
        && trimmed
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '+' || ch == '/' || ch == '=');
    if likely_base64 {
        return Some(trimmed.to_string());
    }

    let path = if trimmed.starts_with("file://") {
        PathBuf::from(decode_file_url_path(trimmed))
    } else {
        PathBuf::from(trimmed)
    };
    let bytes = std::fs::read(path).ok()?;
    Some(STANDARD.encode(bytes))
}

fn is_gpt_image_2_model(model: &str) -> bool {
    let bare = model.split_once('/').map(|(_, m)| m).unwrap_or(model);
    bare == "gpt-image-2" || bare == "gpt-image-2-vip"
}

fn resolve_gpt_image_2_vip_dimensions(aspect_ratio: &str, size: &str) -> Result<String, AIError> {
    match (aspect_ratio, size) {
        ("1:1", "1K") => Ok("1024x1024"),
        ("1:1", "2K") => Ok("2048x2048"),
        ("1:1", "4K") => Ok("2880x2880"),
        ("16:9", "1K") => Ok("1280x720"),
        ("16:9", "2K") => Ok("2048x1152"),
        ("16:9", "4K") => Ok("3840x2160"),
        ("9:16", "1K") => Ok("720x1280"),
        ("9:16", "2K") => Ok("1152x2048"),
        ("9:16", "4K") => Ok("2160x3840"),
        ("4:3", "1K") => Ok("1152x864"),
        ("4:3", "2K") => Ok("2304x1728"),
        ("4:3", "4K") => Ok("3264x2448"),
        ("3:4", "1K") => Ok("864x1152"),
        ("3:4", "2K") => Ok("1728x2304"),
        ("3:4", "4K") => Ok("2448x3264"),
        ("3:2", "1K") => Ok("1536x1024"),
        ("3:2", "2K") => Ok("2048x1360"),
        ("3:2", "4K") => Ok("3504x2336"),
        ("2:3", "1K") => Ok("1024x1536"),
        ("2:3", "2K") => Ok("1360x2048"),
        ("2:3", "4K") => Ok("2336x3504"),
        ("5:4", "1K") => Ok("1120x896"),
        ("5:4", "2K") => Ok("2240x1792"),
        ("5:4", "4K") => Ok("3200x2560"),
        ("4:5", "1K") => Ok("896x1120"),
        ("4:5", "2K") => Ok("1792x2240"),
        ("4:5", "4K") => Ok("2560x3200"),
        ("21:9", "1K") => Ok("1456x624"),
        ("21:9", "2K") => Ok("2912x1248"),
        ("21:9", "4K") => Ok("3840x1648"),
        ("9:21", "1K") => Ok("624x1456"),
        ("9:21", "2K") => Ok("1248x2912"),
        ("9:21", "4K") => Ok("1648x3840"),
        ("1:3", "1K") => Ok("688x2048"),
        ("1:3", "2K") => Ok("1280x3840"),
        ("3:1", "1K") => Ok("2048x688"),
        ("3:1", "2K") => Ok("3840x1280"),
        ("2:1", "1K") => Ok("1536x768"),
        ("2:1", "2K") => Ok("3072x1536"),
        ("2:1", "4K") => Ok("3840x1920"),
        ("1:2", "1K") => Ok("768x1536"),
        ("1:2", "2K") => Ok("1536x3072"),
        ("1:2", "4K") => Ok("1920x3840"),
        _ => Err(AIError::InvalidRequest(format!(
            "Unsupported aspect ratio / resolution combination for gpt-image-2-vip: {} {}",
            aspect_ratio, size
        ))),
    }
    .map(|s| s.to_string())
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrsaiGenerateRequestBody {
    model: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
    aspect_ratio: String,
    reply_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_size: Option<String>,
}

pub struct GrsaiProvider {
    client: Client,
    api_key: Arc<RwLock<Option<String>>>,
    base_url: String,
}

impl GrsaiProvider {
    pub fn new() -> Self {
        Self {
            client: Client::new(),
            api_key: Arc::new(RwLock::new(None)),
            base_url: DEFAULT_BASE_URL.to_string(),
        }
    }

    fn normalize_requested_model(&self, request: &GenerateRequest) -> String {
        let requested = request
            .model
            .split_once('/')
            .map(|(_, model)| model.to_string())
            .unwrap_or_else(|| request.model.clone());

        // gpt-image-2 系列直接返回
        if requested == "gpt-image-2" || requested == "gpt-image-2-vip" {
            return requested;
        }

        if requested == "nano-banana-2" {
            return requested;
        }

        if requested == "nano-banana-pro" || requested.starts_with("nano-banana-pro-") {
            return request
                .extra_params
                .as_ref()
                .and_then(|params| params.get("grsai_pro_model"))
                .and_then(|value| value.as_str())
                .map(Self::normalize_pro_variant)
                .unwrap_or_else(|| requested);
        }

        DEFAULT_PRO_MODEL.to_string()
    }

    fn normalize_pro_variant(input: &str) -> String {
        let trimmed = input.trim().to_lowercase();
        if trimmed == DEFAULT_PRO_MODEL || trimmed.starts_with("nano-banana-pro-") {
            return trimmed;
        }
        DEFAULT_PRO_MODEL.to_string()
    }

    fn extract_result_url(payload: &Value) -> Option<String> {
        payload
            .get("results")
            .and_then(|results| results.as_array())
            .and_then(|results| results.first())
            .and_then(|first| first.get("url"))
            .and_then(|url| url.as_str())
            .map(|url| url.to_string())
    }

    async fn request_generate(&self, request: &GenerateRequest, model: String) -> Result<Value, AIError> {
        let is_gpt = is_gpt_image_2_model(&model);
        let is_gpt_vip = model == "gpt-image-2-vip";

        let aspect_ratio = if is_gpt_vip {
            resolve_gpt_image_2_vip_dimensions(&request.aspect_ratio, &request.size)?
        } else {
            request.aspect_ratio.clone()
        };

        let image_size = if is_gpt {
            None
        } else {
            Some(request.size.clone())
        };

        let body = GrsaiGenerateRequestBody {
            model: model.clone(),
            prompt: request.prompt.clone(),
            images: request
                .reference_images
                .as_ref()
                .map(|images| {
                    images
                        .iter()
                        .filter_map(|image| encode_reference_for_grsai(image))
                        .collect::<Vec<_>>()
                })
                .filter(|v| !v.is_empty()),
            aspect_ratio,
            reply_type: "json".to_string(),
            image_size,
        };

        if request
            .reference_images
            .as_ref()
            .map(|images| !images.is_empty())
            .unwrap_or(false)
            && body.images.is_none()
        {
            return Err(AIError::InvalidRequest(
                "Reference images are present but none could be encoded for GRSAI".to_string(),
            ));
        }

        let endpoint = format!("{}{}", self.base_url, GENERATE_ENDPOINT_PATH);
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        info!("[GRSAI API] URL: {} model: {}", endpoint, model);
        let response = self
            .client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "GRSAI generate request failed {}: {}",
                status, error_text
            )));
        }

        response.json::<Value>().await.map_err(AIError::from)
    }

    async fn poll_once(&self, task_id: &str) -> Result<ProviderTaskPollResult, AIError> {
        let endpoint = format!("{}{}", self.base_url, RESULT_ENDPOINT_PATH);
        let api_key = self
            .api_key
            .read()
            .await
            .clone()
            .ok_or_else(|| AIError::InvalidRequest("API key not set".to_string()))?;

        let response = self
            .client
            .get(&endpoint)
            .header("Authorization", format!("Bearer {}", api_key))
            .query(&[("id", task_id)])
            .send()
            .await?;

        if !response.status().is_success() {
            let status = response.status();
            let error_text = response.text().await.unwrap_or_default();
            return Err(AIError::Provider(format!(
                "GRSAI result request failed {}: {}",
                status, error_text
            )));
        }

        let payload = response.json::<Value>().await?;

        if let Some(url) = Self::extract_result_url(&payload) {
            return Ok(ProviderTaskPollResult::Succeeded(url));
        }

        match payload.get("status").and_then(|raw| raw.as_str()) {
            Some("running") | None => Ok(ProviderTaskPollResult::Running),
            Some("violation") => {
                let reason = payload
                    .get("error")
                    .and_then(|raw| raw.as_str())
                    .unwrap_or("content violation");
                Ok(ProviderTaskPollResult::Failed(reason.to_string()))
            }
            Some("failed") => {
                let reason = payload
                    .get("error")
                    .and_then(|raw| raw.as_str())
                    .filter(|value| !value.is_empty())
                    .unwrap_or("unknown failure");
                Ok(ProviderTaskPollResult::Failed(reason.to_string()))
            }
            Some(other) => Err(AIError::Provider(format!(
                "GRSAI unexpected task status: {}",
                other
            ))),
        }
    }

    async fn poll_until_complete(&self, task_id: &str) -> Result<String, AIError> {
        let mut poll_count = 0u32;
        loop {
            poll_count = poll_count.wrapping_add(1);
            match self.poll_once(task_id).await? {
                ProviderTaskPollResult::Running => {
                    sleep(Duration::from_millis(POLL_INTERVAL_MS)).await;
                }
                ProviderTaskPollResult::Succeeded(url) => {
                    info!("[GRSAI] generate succeeded after {} polls", poll_count);
                    return Ok(url);
                }
                ProviderTaskPollResult::SucceededWithMeta { url, .. } => {
                    return Ok(url);
                }
                ProviderTaskPollResult::Failed(message) => {
                    return Err(AIError::TaskFailed(message));
                }
            }
        }
    }
}

impl Default for GrsaiProvider {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl AIProvider for GrsaiProvider {
    fn name(&self) -> &str {
        "grsai"
    }

    fn supports_model(&self, model: &str) -> bool {
        if model.starts_with("grsai/") {
            return true;
        }
        SUPPORTED_MODELS.contains(&model)
    }

    fn list_models(&self) -> Vec<String> {
        vec![
            "grsai/nano-banana-2".to_string(),
            "grsai/nano-banana-pro".to_string(),
            "grsai/gpt-image-2".to_string(),
            "grsai/gpt-image-2-vip".to_string(),
        ]
    }

    async fn set_api_key(&self, api_key: String) -> Result<(), AIError> {
        let mut key = self.api_key.write().await;
        *key = Some(api_key);
        Ok(())
    }

    fn supports_task_resume(&self) -> bool {
        true
    }

    async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
        let model = self.normalize_requested_model(&request);
        let generate_response = self.request_generate(&request, model).await?;

        if let Some(url) = Self::extract_result_url(&generate_response) {
            return Ok(ProviderTaskSubmission::Succeeded(url));
        }

        let task_id = generate_response
            .get("id")
            .and_then(|raw| raw.as_str())
            .ok_or_else(|| AIError::Provider("GRSAI response missing task id".to_string()))?;
        Ok(ProviderTaskSubmission::Queued(ProviderTaskHandle {
            task_id: task_id.to_string(),
            metadata: None,
        }))
    }

    async fn poll_task(&self, handle: ProviderTaskHandle) -> Result<ProviderTaskPollResult, AIError> {
        self.poll_once(handle.task_id.as_str()).await
    }

    async fn generate(&self, request: GenerateRequest) -> Result<String, AIError> {
        let model = self.normalize_requested_model(&request);
        info!(
            "[GRSAI Request] model: {}, size: {}, aspect_ratio: {}",
            model, request.size, request.aspect_ratio
        );

        let generate_response = self.request_generate(&request, model).await?;

        if let Some(url) = Self::extract_result_url(&generate_response) {
            return Ok(url);
        }

        let task_id = generate_response
            .get("id")
            .and_then(|raw| raw.as_str())
            .ok_or_else(|| AIError::Provider("GRSAI response missing task id".to_string()))?;

        self.poll_until_complete(task_id).await
    }
}
