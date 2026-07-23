use std::collections::{HashMap, HashSet};
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use tauri::{AppHandle, Emitter, Manager};
use tokio::sync::RwLock;
use tracing::{info, error};
use uuid::Uuid;

use crate::ai::error::AIError;
use crate::ai::providers::build_default_providers;
use crate::ai::{
    GenerateRequest, ProviderRegistry, ProviderTaskHandle, ProviderTaskPollResult,
    ProviderTaskSubmission,
};

static REGISTRY: std::sync::OnceLock<ProviderRegistry> = std::sync::OnceLock::new();
static ACTIVE_NON_RESUMABLE_JOB_IDS: std::sync::OnceLock<Arc<RwLock<HashSet<String>>>> =
    std::sync::OnceLock::new();

fn get_registry() -> &'static ProviderRegistry {
    REGISTRY.get_or_init(|| {
        let mut registry = ProviderRegistry::new();
        for provider in build_default_providers() {
            registry.register_provider(provider);
        }
        registry
    })
}

fn active_non_resumable_job_ids() -> &'static Arc<RwLock<HashSet<String>>> {
    ACTIVE_NON_RESUMABLE_JOB_IDS.get_or_init(|| Arc::new(RwLock::new(HashSet::new())))
}

#[derive(Debug, Serialize, Deserialize)]
pub struct GenerateRequestDto {
    pub prompt: String,
    pub model: String,
    pub size: String,
    pub aspect_ratio: String,
    pub reference_images: Option<Vec<String>>,
    pub extra_params: Option<HashMap<String, Value>>,
    /// Draft task ID - when set, generates final video from this draft
    #[serde(rename = "draftTaskId", default)]
    pub draft_task_id: Option<String>,
}

#[derive(Debug, Serialize)]
pub struct GenerationJobStatusDto {
    pub job_id: String,
    pub status: String,
    pub result: Option<String>,
    pub error: Option<String>,
    pub seed: Option<i64>,
    /// External task ID from the provider (e.g., volcvideo task ID like "cgt-xxx")
    /// Used for draft video final generation
    pub external_task_id: Option<String>,
}

#[derive(Debug)]
struct GenerationJobRecord {
    job_id: String,
    provider_id: String,
    status: String,
    resumable: bool,
    external_task_id: Option<String>,
    external_task_meta_json: Option<String>,
    result: Option<String>,
    error: Option<String>,
}

fn now_ms() -> i64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as i64
}

fn resolve_db_path(app: &AppHandle) -> Result<PathBuf, String> {
    let app_data_dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("Failed to resolve app data dir: {}", e))?;

    std::fs::create_dir_all(&app_data_dir)
        .map_err(|e| format!("Failed to create app data dir: {}", e))?;

    Ok(app_data_dir.join("projects.db"))
}

fn ensure_generation_jobs_table(conn: &Connection) -> Result<(), String> {
    conn.execute_batch(
        r#"
        CREATE TABLE IF NOT EXISTS ai_generation_jobs (
          job_id TEXT PRIMARY KEY,
          provider_id TEXT NOT NULL,
          status TEXT NOT NULL,
          resumable INTEGER NOT NULL DEFAULT 0,
          external_task_id TEXT,
          external_task_meta_json TEXT,
          result TEXT,
          error TEXT,
          created_at INTEGER NOT NULL,
          updated_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_status ON ai_generation_jobs(status);
        CREATE INDEX IF NOT EXISTS idx_ai_generation_jobs_updated_at ON ai_generation_jobs(updated_at DESC);
        "#,
    )
    .map_err(|e| format!("Failed to initialize ai_generation_jobs table: {}", e))?;

    Ok(())
}

fn open_db(app: &AppHandle) -> Result<Connection, String> {
    let db_path = resolve_db_path(app)?;
    let conn = Connection::open(db_path).map_err(|e| format!("Failed to open SQLite DB: {}", e))?;

    conn.pragma_update(None, "journal_mode", "WAL")
        .map_err(|e| format!("Failed to set journal_mode=WAL: {}", e))?;
    conn.pragma_update(None, "synchronous", "NORMAL")
        .map_err(|e| format!("Failed to set synchronous=NORMAL: {}", e))?;
    conn.pragma_update(None, "temp_store", "MEMORY")
        .map_err(|e| format!("Failed to set temp_store=MEMORY: {}", e))?;
    conn.busy_timeout(Duration::from_millis(3000))
        .map_err(|e| format!("Failed to set busy timeout: {}", e))?;

    ensure_generation_jobs_table(&conn)?;
    Ok(conn)
}

fn insert_generation_job(
    app: &AppHandle,
    job_id: &str,
    provider_id: &str,
    status: &str,
    resumable: bool,
    external_task_id: Option<&str>,
    external_task_meta_json: Option<&str>,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    let now = now_ms();
    conn.execute(
        r#"
        INSERT INTO ai_generation_jobs (
          job_id,
          provider_id,
          status,
          resumable,
          external_task_id,
          external_task_meta_json,
          result,
          error,
          created_at,
          updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
        "#,
        params![
            job_id,
            provider_id,
            status,
            if resumable { 1_i64 } else { 0_i64 },
            external_task_id,
            external_task_meta_json,
            result,
            error,
            now,
            now
        ],
    )
    .map_err(|e| format!("Failed to insert generation job: {}", e))?;
    Ok(())
}

fn update_generation_job(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          error = ?3,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, error, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job: {}", e))?;
    Ok(())
}

fn update_generation_job_with_seed(
    app: &AppHandle,
    job_id: &str,
    status: &str,
    result: Option<&str>,
    seed: Option<i64>,
) -> Result<(), String> {
    let conn = open_db(app)?;
    // Build metadata JSON with seed if provided
    let meta_json = seed.map(|s| {
        serde_json::json!({ "seed": s }).to_string()
    });
    conn.execute(
        r#"
        UPDATE ai_generation_jobs
        SET
          status = ?1,
          result = ?2,
          external_task_meta_json = ?3,
          updated_at = ?4
        WHERE job_id = ?5
        "#,
        params![status, result, meta_json, now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to update generation job with seed: {}", e))?;
    Ok(())
}

fn touch_generation_job(app: &AppHandle, job_id: &str) -> Result<(), String> {
    let conn = open_db(app)?;
    conn.execute(
        "UPDATE ai_generation_jobs SET updated_at = ?1 WHERE job_id = ?2",
        params![now_ms(), job_id],
    )
    .map_err(|e| format!("Failed to touch generation job: {}", e))?;
    Ok(())
}

fn get_generation_job(app: &AppHandle, job_id: &str) -> Result<Option<GenerationJobRecord>, String> {
    let conn = open_db(app)?;
    let mut stmt = conn
        .prepare(
            r#"
            SELECT
              job_id,
              provider_id,
              status,
              resumable,
              external_task_id,
              external_task_meta_json,
              result,
              error
            FROM ai_generation_jobs
            WHERE job_id = ?1
            LIMIT 1
            "#,
        )
        .map_err(|e| format!("Failed to prepare generation job query: {}", e))?;

    let result = stmt.query_row(params![job_id], |row| {
        Ok(GenerationJobRecord {
            job_id: row.get(0)?,
            provider_id: row.get(1)?,
            status: row.get(2)?,
            resumable: row.get::<_, i64>(3)? != 0,
            external_task_id: row.get(4)?,
            external_task_meta_json: row.get(5)?,
            result: row.get(6)?,
            error: row.get(7)?,
        })
    });

    match result {
        Ok(record) => Ok(Some(record)),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
        Err(error) => Err(format!("Failed to load generation job: {}", error)),
    }
}

fn dto_from_record(record: &GenerationJobRecord) -> GenerationJobStatusDto {
    // Extract seed from external_task_meta_json if present
    let seed = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<serde_json::Value>(raw).ok())
        .and_then(|val| val.get("seed").and_then(|v| v.as_i64()));
    GenerationJobStatusDto {
        job_id: record.job_id.clone(),
        status: record.status.clone(),
        result: record.result.clone(),
        error: record.error.clone(),
        seed,
        external_task_id: record.external_task_id.clone(),
    }
}

#[tauri::command]
pub async fn set_api_key(provider: String, api_key: String) -> Result<(), String> {
    info!("Setting API key for provider: {}", provider);

    let registry = get_registry();
    let resolved_provider = registry
        .get_provider(provider.as_str())
        .ok_or_else(|| format!("Unknown provider: {}", provider))?;

    resolved_provider
        .set_api_key(api_key)
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
pub async fn submit_generate_image_job(
    app: AppHandle,
    request: GenerateRequestDto,
) -> Result<String, String> {
    info!("[submit_generate_image_job] COMMAND INVOKED - model: {}", request.model);
    info!("[Job Request] model: {}, size: {}, aspect_ratio: {}, refs: {:?}",
        request.model,
        request.size,
        request.aspect_ratio,
        request.reference_images);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .cloned()
        .ok_or_else(|| "Provider not found".to_string())?;

    let req_model = request.model.clone();
    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
        draft_task_id: request.draft_task_id,
    };

    info!("[Job Request Full] prompt: {}, reference_images: {:?}",
        req.prompt, req.reference_images);

    let job_id = Uuid::new_v4().to_string();
    let provider_id = provider.name().to_string();

    if provider.supports_task_resume() {
        let submit_result = provider.submit_task(req).await;
        let submission = match submit_result {
            Ok(submission) => submission,
            Err(e) => {
                let msg = e.to_string();
                error!("[AI Backend Error] provider={} model={} error={}", provider.name(), req_model, msg);
                let _ = app.emit("backend:ai-error", serde_json::json!({
                    "message": msg,
                    "model": req_model,
                    "provider": provider.name(),
                    "ts": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as i64,
                }));
                return Err(msg);
            }
        };
        match submission {
            ProviderTaskSubmission::Succeeded(image_source) => {
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "succeeded",
                    true,
                    None,
                    None,
                    Some(image_source.as_str()),
                    None,
                )?;
            }
            ProviderTaskSubmission::Queued(handle) => {
                let meta_json = handle
                    .metadata
                    .as_ref()
                    .and_then(|value| serde_json::to_string(value).ok());
                insert_generation_job(
                    &app,
                    job_id.as_str(),
                    provider_id.as_str(),
                    "running",
                    true,
                    Some(handle.task_id.as_str()),
                    meta_json.as_deref(),
                    None,
                    None,
                )?;
            }
        }
        return Ok(job_id);
    }

    insert_generation_job(
        &app,
        job_id.as_str(),
        provider_id.as_str(),
        "running",
        false,
        None,
        None,
        None,
        None,
    )?;
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.insert(job_id.clone());
    }

    let app_handle = app.clone();
    let spawned_job_id = job_id.clone();
    let spawned_provider = provider.clone();
    tauri::async_runtime::spawn(async move {
        let result = spawned_provider.generate(req).await;
        let update_result = match result {
            Ok(image_source) => update_generation_job(
                &app_handle,
                spawned_job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            ),
            Err(error) => {
                let message = error.to_string();
                update_generation_job(
                    &app_handle,
                    spawned_job_id.as_str(),
                    "failed",
                    None,
                    Some(message.as_str()),
                )
            }
        };
        if let Err(error) = update_result {
            info!("Failed to update non-resumable generation job: {}", error);
        }
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(spawned_job_id.as_str());
    });

    Ok(job_id)
}

#[tauri::command]
pub async fn cancel_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<(), String> {
    info!("[cancel_generate_image_job] called with job_id: {}", job_id);

    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(record) = maybe_record else {
        info!("[cancel_generate_image_job] job not found in DB: {}", job_id);
        return Err("Job not found".to_string());
    };

    info!("[cancel_generate_image_job] found job: id={}, provider={}, status={}, external_task_id={:?}",
        record.job_id, record.provider_id, record.status, record.external_task_id);

    // Only allow cancelling non-terminal jobs
    if record.status == "succeeded" || record.status == "failed" || record.status == "cancelled" {
        return Err(format!("Job already in terminal state: {}", record.status));
    }

    // If the job has an external task ID and is for volcvideo, try to cancel via API
    // Note: Full API cancellation requires access to settings which is handled by frontend
    if let Some(external_task_id) = &record.external_task_id {
        if record.provider_id == "volcvideo" {
            info!("[cancel_generate_image_job] volcvideo task {} - frontend should call cancel API", external_task_id);
        }
    }

    // Update job status to cancelled
    update_generation_job(
        &app,
        job_id.as_str(),
        "cancelled",
        None,
        Some("Cancelled by user"),
    )?;

    // Remove from active jobs if present
    {
        let mut active_set = active_non_resumable_job_ids().write().await;
        active_set.remove(job_id.as_str());
    }

    info!("[cancel_generate_image_job] job {} cancelled successfully", job_id);
    Ok(())
}

#[tauri::command]
pub async fn cancel_video_generation_task(
    api_key: String,
    task_id: String,
) -> Result<(), String> {
    info!("[cancel_video_generation_task] cancelling task: {}", task_id);

    use crate::ai::providers::volcvideo::cancel_volcvideo_task;

    cancel_volcvideo_task(&api_key, &task_id)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn get_generate_image_job(
    app: AppHandle,
    job_id: String,
) -> Result<GenerationJobStatusDto, String> {
    info!("[get_generate_image_job] called with job_id: {}", job_id);
    let maybe_record = get_generation_job(&app, job_id.as_str())?;
    let Some(mut record) = maybe_record else {
        info!("[get_generate_image_job] job not found in DB: {}", job_id);
        return Ok(GenerationJobStatusDto {
            job_id,
            status: "not_found".to_string(),
            result: None,
            error: Some("job not found".to_string()),
            seed: None,
            external_task_id: None,
        });
    };

    info!("[get_generate_image_job] found job: id={}, provider={}, status={}, external_task_id={:?}",
        record.job_id, record.provider_id, record.status, record.external_task_id);

    if record.status == "succeeded" || record.status == "failed" {
        info!("[get_generate_image_job] job {} already terminal, returning: {}", job_id, record.status);
        return Ok(dto_from_record(&record));
    }

    if !record.resumable {
        let is_active = {
            let active_set = active_non_resumable_job_ids().read().await;
            active_set.contains(record.job_id.as_str())
        };
        if is_active {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            return Ok(dto_from_record(&record));
        }

        let interrupted_message = "job interrupted by app restart".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(interrupted_message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(interrupted_message);
        return Ok(dto_from_record(&record));
    }

    let provider = get_registry()
        .get_provider(record.provider_id.as_str())
        .cloned()
        .ok_or_else(|| format!("Provider not found for job: {}", record.provider_id))?;

    let Some(task_id) = record.external_task_id.clone() else {
        let message = "missing external task id".to_string();
        update_generation_job(
            &app,
            record.job_id.as_str(),
            "failed",
            None,
            Some(message.as_str()),
        )?;
        record.status = "failed".to_string();
        record.error = Some(message);
        return Ok(dto_from_record(&record));
    };

    let task_meta = record
        .external_task_meta_json
        .as_deref()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok());

    info!("[get_generate_image_job] calling provider.poll_task for job: {}, task_id: {}", job_id, task_id);
    match provider
        .poll_task(ProviderTaskHandle {
            task_id,
            metadata: task_meta,
        })
        .await
    {
        Ok(ProviderTaskPollResult::Running) => {
            let _ = touch_generation_job(&app, record.job_id.as_str());
            Ok(dto_from_record(&record))
        }
        Ok(ProviderTaskPollResult::Succeeded(image_source)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(image_source.as_str()),
                None,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(image_source),
                error: None,
                seed: None,
                external_task_id: record.external_task_id.clone(),
            })
        }
        Ok(ProviderTaskPollResult::SucceededWithMeta { url, seed }) => {
            info!("[get_generate_image_job] SucceededWithMeta: url={}, seed={:?}", url, seed);
            update_generation_job_with_seed(
                &app,
                record.job_id.as_str(),
                "succeeded",
                Some(url.as_str()),
                seed,
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "succeeded".to_string(),
                result: Some(url),
                error: None,
                seed,
                external_task_id: record.external_task_id.clone(),
            })
        }
        Ok(ProviderTaskPollResult::Failed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
                seed: None,
                external_task_id: record.external_task_id.clone(),
            })
        }
        Err(AIError::TaskFailed(message)) => {
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(message.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(message),
                seed: None,
                external_task_id: record.external_task_id.clone(),
            })
        }
        Err(error) => {
            let error_msg = error.to_string();
            info!("[VideoJob] poll_task error for job {}: {}", job_id, error_msg);
            update_generation_job(
                &app,
                record.job_id.as_str(),
                "failed",
                None,
                Some(error_msg.as_str()),
            )?;
            Ok(GenerationJobStatusDto {
                job_id: record.job_id,
                status: "failed".to_string(),
                result: None,
                error: Some(error_msg),
                seed: None,
                external_task_id: record.external_task_id.clone(),
            })
        }
    }
}

#[tauri::command]
pub async fn generate_image(request: GenerateRequestDto) -> Result<String, String> {
    info!("Generating image with model: {}", request.model);

    let registry = get_registry();
    let provider = registry
        .resolve_provider_for_model(&request.model)
        .or_else(|| registry.get_default_provider())
        .ok_or_else(|| "Provider not found".to_string())?;

    let req = GenerateRequest {
        prompt: request.prompt,
        model: request.model,
        size: request.size,
        aspect_ratio: request.aspect_ratio,
        reference_images: request.reference_images,
        extra_params: request.extra_params,
        draft_task_id: request.draft_task_id,
    };

    provider.generate(req).await.map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn list_models() -> Result<Vec<String>, String> {
    Ok(get_registry().list_models())
}

#[derive(Debug, serde::Deserialize)]
pub struct PolishTextRequest {
    pub text: String,
    pub model: String,
    pub api_key: String,
    pub base_url: String,
    pub reference_images: Option<Vec<String>>,
    #[serde(default)]
    pub custom_prompt: Option<String>,
    // 视频元信息字段
    #[serde(default)]
    pub video_duration: Option<String>,
    #[serde(default)]
    pub video_resolution: Option<String>,
    #[serde(default)]
    pub video_aspect_ratio: Option<String>,
    #[serde(default)]
    pub video_shot_type: Option<String>,
    #[serde(default)]
    pub video_shot_size: Option<String>,
    #[serde(default)]
    pub video_angle: Option<String>,
    #[serde(default)]
    pub video_camera_movement: Option<String>,
    #[serde(default)]
    pub video_camera_speed: Option<String>,
    // 是否为首尾帧模式
    #[serde(default)]
    pub is_video_frame: Option<bool>,
    // 提示词模板类型：image 或 video，用于选择对应的默认模板
    #[serde(default)]
    pub prompt_type: Option<String>,
}

// 图片润色提示词模板的备用默认值（当用户未设置自定义模板时使用）
const BACKUP_TEXT_POLISH_TEMPLATE: &str = "你是专业的AI绘画提示词润色专家。我将为你提供待优化的原始AI绘画提示词（可能包含参考图片的@引用标记），请按照以下要求进行深度优化：
核心任务：深度理解原始提示词的核心语义和用户期望的视觉目标
视觉增强：从画面构图、风格流派、色彩调性、光影效果、主体元素、质感表现、氛围情绪等维度进行专业增强
AI适配：结合AI绘画工具的生成逻辑进行优化补充
输出要求：直接输出润色后的提示词，不需要任何解释或前缀说明
请直接输出优化后的提示词文本。";

// 视频润色提示词模板的备用默认值（当用户未设置自定义模板时使用）
const BACKUP_VIDEO_POLISH_TEMPLATE: &str = "你是专业的 AI 视频生成提示词润色专家，具备丰富的镜头语言、视觉美学和 AI 生成适配经验。我将为你提供参考图片和待优化的原始 AI 视频提示词（可能为空），请严格遵循以下要求，完成深度优化，确保优化后的提示词精准适配 AI 视频生成工具，能直接生成符合预期的视觉效果：
核心前提：深度拆解原始提示词的核心语义、镜头逻辑、动态需求和视觉预期，不偏离用户核心诉求，不添加无关元素，同时弥补原始提示词的细节缺失。
优化核心维度（按需精准融入，不冗余，贴合 AI 生成特性）：
场景：明确环境、具体地点、背景细节（如天气、植被、建筑风格、空间层次），补充环境动态变化（如风吹，光影流动、烟雾飘动）；
时长：根据视频总时长，可拆分关键镜头时长分配；
景别：精准标注每段镜头景别（远景 / 全景 / 中景 / 近景 / 特写），明确景别切换逻辑，贴合内容节奏；
运镜：适配 AI 工具可实现的运镜方式（固定镜头、缓慢推进 / 拉远、平稳跟随、缓慢环绕、柔和摇镜等），标注运镜速度和幅度，避免复杂难实现的运镜；
角色 / 主体：详细描述外观细节、色彩、纹理、状态，明确表情、连贯动作及运动轨迹，突出主体辨识度；
情绪基调：精准定位整体情绪（紧张、压抑、温馨、科幻、惊悚等），并通过光影、色彩、动作强化情绪表达；
光影：明确光源类型（自然光 / 人工光 / 特殊光源）、光线方向、明暗对比，补充光影动态效果（如光斑移动、反光变化），增强画面层次感；
动作：细化主体及环境的连贯动作，标注动作速度、幅度，确保动态流畅自然，符合逻辑；
氛围：强化整体视觉氛围（写实、科幻、复古、梦幻、末日等），通过色彩、光影、环境细节统一氛围基调；
台词 / 旁白（按需）：简洁适配视频时长，贴合内容节奏，语言自然，符合整体情绪；
音效 / 配乐（按需）：明确背景音乐风格、环境音细节、特效音，贴合画面节奏和情绪，增强沉浸感。
AI 适配优化：结合主流 AI 视频生成工具的特性（时长限制、运镜兼容性、动态效果上限、细节渲染能力），优化提示词表述，避免模糊化描述，确保 AI 能精准解析，减少生成偏差；优先选择 AI 易实现的动态和光影效果，同时保留核心视觉诉求。
输出规范：仅输出润色后的完整视频提示词，无任何多余解释、前缀或后缀，语言简洁精准、逻辑清晰，镜头和动态描述连贯，可直接复制用于 AI 视频生成。";

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ChatMessage {
    role: String,
    content: ChatContent,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
#[serde(untagged)]
enum ChatContent {
    Text(String),
    Array(Vec<ContentPart>),
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ContentPart {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<ImageUrl>,
}

#[derive(Debug, serde::Serialize, serde::Deserialize)]
struct ImageUrl {
    url: String,
}

#[derive(Debug, serde::Serialize)]
struct ChatRequest {
    model: String,
    messages: Vec<ChatMessage>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stream: Option<bool>,
}

// Responses API 格式 - 用于图片输入
#[derive(Debug, serde::Serialize)]
struct ResponsesInputContent {
    #[serde(rename = "type")]
    part_type: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    image_url: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    text: Option<String>,
}

#[derive(Debug, serde::Serialize)]
struct ResponsesInput {
    role: String,
    content: Vec<ResponsesInputContent>,
}

#[derive(Debug, serde::Serialize)]
struct ResponsesRequest {
    model: String,
    input: Vec<ResponsesInput>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesResponse {
    output: Option<ResponsesOutput>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesOutput {
    choices: Option<Vec<ResponsesChoice>>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesChoice {
    message: Option<ResponsesMessage>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponsesMessage {
    content: Option<String>,
}

#[derive(Debug, serde::Deserialize)]
struct ChatResponse {
    choices: Option<Vec<Choice>>,
}

#[derive(Debug, serde::Deserialize)]
struct Choice {
    message: Option<ResponseMessage>,
}

#[derive(Debug, serde::Deserialize)]
struct ResponseMessage {
    content: Option<String>,
}

// 构建视频元信息前缀提示词（仅包含必须由用户选择的固定参数）
fn build_video_metadata_prefix(
    duration: Option<&str>,
    resolution: Option<&str>,
    aspect_ratio: Option<&str>,
    is_video_frame: bool,
) -> String {
    let mut parts = Vec::new();
    parts.push("当前视频生成固定参数（由用户选择，AI需遵循）：".to_string());

    if let Some(d) = duration {
        if !d.is_empty() {
            parts.push(format!("- 时长：{}秒", d));
        }
    }
    if let Some(r) = resolution {
        if !r.is_empty() {
            parts.push(format!("- 分辨率：{}", r));
        }
    }
    if let Some(a) = aspect_ratio {
        if !a.is_empty() {
            parts.push(format!("- 画面宽高比：{}", a));
        }
    }
    // 添加首尾帧模式说明
    if is_video_frame {
        parts.push("- 模式：首尾帧视频（图1为首帧，图2为尾帧）".to_string());
    }

    if parts.len() == 1 {
        // 只有标题，没有实际参数
        String::new()
    } else {
        parts.push("以上为用户已选择的固定参数，AI在优化提示词时必须遵循。".to_string());
        parts.join("\n")
    }
}

#[tauri::command]
pub async fn polish_text(request: PolishTextRequest) -> Result<String, String> {
    info!("Polishing text with model: {}, base_url: {}", request.model, request.base_url);

    let model = request.model.clone();
    let has_reference = request.reference_images.as_ref().map(|r| !r.is_empty()).unwrap_or(false);

    let client = reqwest::Client::new();

    // 判断使用 Responses API 还是 Chat API
    // Responses API 使用 /api/v3 基础路径，Chat API 使用 /api/coding
    let is_responses_api = request.base_url.contains("/api/v3") && !request.base_url.contains("/coding");

    // 构建视频元信息前缀
    let video_metadata_prefix = build_video_metadata_prefix(
        request.video_duration.as_deref(),
        request.video_resolution.as_deref(),
        request.video_aspect_ratio.as_deref(),
        request.is_video_frame.unwrap_or(false),
    );

    if is_responses_api {
        // 使用 Responses API 格式
        let endpoint = format!("{}/responses", request.base_url.trim_end_matches('/'));
        info!("[PolishText] using Responses API format, endpoint: {}", endpoint);

        // 如果有视频元信息，构建增强版提示词
        let enhanced_text = if !video_metadata_prefix.is_empty() {
            format!("{}\n\n{}", video_metadata_prefix, request.text)
        } else {
            request.text.clone()
        };

        // 构建用户提示词 - 根据 prompt_type 选择默认模板
        let default_template = match request.prompt_type.as_deref() {
            Some("image") => BACKUP_TEXT_POLISH_TEMPLATE,
            Some("video") | None => BACKUP_VIDEO_POLISH_TEMPLATE,
            _ => BACKUP_VIDEO_POLISH_TEMPLATE,
        };

        let user_text = if let Some(ref custom) = request.custom_prompt {
            if custom.trim().is_empty() {
                // 使用默认模板
                if has_reference {
                    format!("{}\n\n请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", default_template, enhanced_text)
                } else {
                    format!("{}\n\n请润色这个提示词：{}", default_template, enhanced_text)
                }
            } else {
                // 使用用户自定义模板
                if has_reference {
                    format!("{}\n\n请润色这个提示词：{}\n\n参考图片已提供。", custom, enhanced_text)
                } else {
                    format!("{}\n\n请润色这个提示词：{}", custom, enhanced_text)
                }
            }
        } else {
            // 使用默认模板
            if has_reference {
                format!("{}\n\n请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", default_template, enhanced_text)
            } else {
                format!("{}\n\n请润色这个提示词：{}", default_template, enhanced_text)
            }
        };

        // 构建 Responses API 格式的 input
        let mut content_parts = Vec::new();

        // 添加参考图片
        if has_reference {
            for img_url in request.reference_images.as_ref().unwrap_or(&vec![]).iter() {
                content_parts.push(ResponsesInputContent {
                    part_type: "input_image".to_string(),
                    image_url: Some(img_url.clone()),
                    text: None,
                });
            }
        }

        // 添加文本
        content_parts.push(ResponsesInputContent {
            part_type: "input_text".to_string(),
            image_url: None,
            text: Some(user_text),
        });

        let body = ResponsesRequest {
            model: model.clone(),
            input: vec![ResponsesInput {
                role: "user".to_string(),
                content: content_parts,
            }],
        };

        info!("[PolishText] calling Responses API endpoint: {}", endpoint);

        let response = client
            .post(&endpoint)
            .header("Authorization", format!("Bearer {}", request.api_key))
            .header("Content-Type", "application/json")
            .json(&body)
            .send()
            .await
            .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

        let status = response.status();
        let raw_response = response.text().await.unwrap_or_default();

        if !status.is_success() {
            let error_detail = if status.as_u16() >= 500 {
                "服务器内部错误，请稍后重试"
            } else if status.as_u16() == 401 {
                "API密钥无效或已过期"
            } else if status.as_u16() == 403 {
                "API访问被拒绝，请检查密钥权限"
            } else if status.as_u16() == 429 {
                "请求过于频繁，请稍后重试"
            } else {
                "请求参数有误"
            };
            return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
        }

        let resp: ResponsesResponse = serde_json::from_str(&raw_response)
            .map_err(|e| format!("响应格式解析失败: {}", e))?;

        if let Some(output) = resp.output {
            if let Some(choices) = output.choices {
                if let Some(choice) = choices.first() {
                    if let Some(msg) = &choice.message {
                        if let Some(content) = &msg.content {
                            return Ok(content.clone());
                        }
                    }
                }
            }

            return Err("API返回内容为空".to_string());
        } else {
            return Err("API返回内容为空".to_string());
        }
    } else {
        // 使用 Chat API 格式（OpenAI兼容）
        let endpoint = format!("{}/v3/chat/completions", request.base_url.trim_end_matches('/'));

        info!("[PolishText] using Chat API format, endpoint: {}", endpoint);

        // 如果有视频元信息，构建增强版提示词
        let enhanced_text = if !video_metadata_prefix.is_empty() {
            format!("{}\n\n{}", video_metadata_prefix, request.text)
        } else {
            request.text.clone()
        };

        // 构建消息
        let mut messages = Vec::new();

        // 如果有自定义提示词模板，使用它；否则根据 prompt_type 选择默认模板
        let default_template = match request.prompt_type.as_deref() {
            Some("image") => BACKUP_TEXT_POLISH_TEMPLATE,
            Some("video") | None => BACKUP_VIDEO_POLISH_TEMPLATE, // 默认用视频模板
            _ => BACKUP_VIDEO_POLISH_TEMPLATE,
        };

        let (system_content, user_text) = if let Some(ref custom) = request.custom_prompt {
            if custom.trim().is_empty() {
                // 空模板，使用默认模板
                let usr_default = if has_reference {
                    format!("请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
                } else {
                    format!("请润色这个提示词：{}", enhanced_text)
                };
                (default_template.to_string(), usr_default)
            } else {
                // 使用自定义模板
                let sys = custom.trim();
                let usr = if has_reference {
                    format!("请润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
                } else {
                    format!("请润色这个提示词：{}", enhanced_text)
                };
                (sys.to_string(), usr)
            }
        } else {
            // 使用默认模板
            let usr_content = if has_reference {
                format!("请根据参考图片润色这个提示词：{}\n\n参考图片已提供。", enhanced_text)
            } else {
                format!("请润色这个提示词：{}", enhanced_text)
            };
            (default_template.to_string(), usr_content)
        };

        messages.push(ChatMessage {
            role: "system".to_string(),
            content: ChatContent::Text(system_content),
        });

    // 构建用户消息
    let user_content = if has_reference {
        let mut parts = Vec::new();

        // 添加参考图片 - 支持 http/https URL 和 data:image base64
        let mut valid_image_count = 0;
        for img_url in request.reference_images.as_ref().unwrap_or(&vec![]).iter() {
            if img_url.starts_with("http://") || img_url.starts_with("https://") || img_url.starts_with("data:") {
                parts.push(ContentPart {
                    part_type: "image_url".to_string(),
                    text: None,
                    image_url: Some(ImageUrl { url: img_url.clone() }),
                });
                valid_image_count += 1;
            }
        }
        info!("[PolishText] valid images added: {}", valid_image_count);

        let text_part = user_text;
        parts.push(ContentPart {
            part_type: "text".to_string(),
            text: Some(text_part),
            image_url: None,
        });

        ChatContent::Array(parts)
    } else {
        ChatContent::Text(user_text)
    };

    messages.push(ChatMessage {
        role: "user".to_string(),
        content: user_content,
    });

    let body = ChatRequest {
        model: model.clone(),
        messages,
        stream: Some(false),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error_detail = if status.as_u16() >= 500 {
            "服务器内部错误，请稍后重试"
        } else if status.as_u16() == 401 {
            "API密钥无效或已过期"
        } else if status.as_u16() == 403 {
            "API访问被拒绝，请检查密钥权限"
        } else if status.as_u16() == 429 {
            "请求过于频繁，请稍后重试"
        } else {
            "请求参数有误"
        };
        return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
    }

    let resp: ChatResponse = serde_json::from_str(&raw_response)
        .map_err(|e| format!("响应格式解析失败: {}", e))?;

    if let Some(choices) = resp.choices {
        if let Some(choice) = choices.first() {
            if let Some(msg) = &choice.message {
                if let Some(content) = &msg.content {
                    return Ok(content.clone());
                }
            }
        }

        return Err("API返回内容为空".to_string());
        } else {
            return Err("API返回内容为空".to_string());
        }
    }
}

#[tauri::command]
pub async fn test_text_api(
    request: PolishTextRequest,
) -> Result<String, String> {
    info!("Testing text API with model: {}, base_url: {}", request.model, request.base_url);

    let model = request.model.clone();
    let client = reqwest::Client::new();

    // 使用 /v3/chat/completions 端点（OpenAI兼容）
    let endpoint = format!("{}/v3/chat/completions", request.base_url.trim_end_matches('/'));

    let messages = vec![
        ChatMessage {
            role: "user".to_string(),
            content: ChatContent::Text("你是什么模型？请简单介绍一下你自己。".to_string()),
        },
    ];

    let body = ChatRequest {
        model: model.clone(),
        messages,
        stream: Some(false),
    };

    let response = client
        .post(&endpoint)
        .header("Authorization", format!("Bearer {}", request.api_key))
        .header("Content-Type", "application/json")
        .json(&body)
        .send()
        .await
        .map_err(|e| format!("网络请求失败，请检查网络连接: {}", e))?;

    let status = response.status();
    let raw_response = response.text().await.unwrap_or_default();

    if !status.is_success() {
        let error_detail = if status.as_u16() >= 500 {
            "服务器内部错误，请稍后重试"
        } else if status.as_u16() == 401 {
            "API密钥无效或已过期"
        } else if status.as_u16() == 403 {
            "API访问被拒绝，请检查密钥权限"
        } else if status.as_u16() == 429 {
            "请求过于频繁，请稍后重试"
        } else {
            "请求参数有误"
        };
        return Err(format!("API调用失败 [{}]: {} | 错误详情: {}", status, error_detail, raw_response));
    }

    let resp: ChatResponse = serde_json::from_str(&raw_response)
        .map_err(|e| format!("响应格式解析失败: {}", e))?;

    if let Some(choices) = resp.choices {
        if let Some(choice) = choices.first() {
            if let Some(msg) = &choice.message {
                if let Some(content) = &msg.content {
                    return Ok(format!("API连接成功！测试回复: {}", content));
                }
            }
        }
    }

    Err("API返回内容为空".to_string())
}
