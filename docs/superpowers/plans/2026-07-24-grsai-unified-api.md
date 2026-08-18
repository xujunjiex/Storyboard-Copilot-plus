# Grsai 统一 API 适配 — 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 GrsaiProvider 从旧的 `/v1/draw/nano-banana` + code/data 包装迁移到统一的 `/v1/api/generate` API，并新增 gpt-image-2 / gpt-image-2-vip 两个图像模型。

**Architecture:** 后端统一请求体 `GrsaiGenerateRequestBody` + 扁平 JSON 响应解析 + GET 轮询；前端扩展 `ImageModelRuntimeContext` 支持动态分辨率过滤；现有 nano-banana-2 补全比例。

**Tech Stack:** Rust (Tauri 2) + TypeScript (React, Zustand, @xyflow/react)

**Spec:** `docs/superpowers/specs/2026-07-24-grsai-unified-api-design.md`

## Global Constraints

- 所有 Grsai 模型（nano-banana + gpt-image-2）共用 `POST /v1/api/generate` 端点
- 轮询统一为 `GET /v1/api/result?id=xxx`
- 响应统一为扁平 JSON（无 code/data 包装）
- 图生图字段统一为 `images`（非 `urls`）
- gpt-image-2-vip 的 `1:3`/`3:1` 比例不支持 4K
- nano-banana-2 额外支持 1:4/4:1/1:8/8:1 比例
- API Key 共用，前端 `ProviderApiKeys['grsai']`

---

### Task 1: 后端 GrsaiProvider 统一重构

**Files:**
- Modify: `src-tauri/src/ai/providers/grsai/mod.rs`

**Interfaces:**
- Produces: `GrsaiProvider` implements `AIProvider` trait (submit_task, poll_task, generate)
- Produces: `GrsaiGenerateRequestBody` struct, `resolve_gpt_image_2_vip_dimensions` fn

- [ ] **Step 1: 替换常量**

Replace lines 16-17:
```rust
const DRAW_ENDPOINT_PATH: &str = "/v1/draw/nano-banana";
const RESULT_ENDPOINT_PATH: &str = "/v1/draw/result";
```
→
```rust
const GENERATE_ENDPOINT_PATH: &str = "/v1/api/generate";
const RESULT_ENDPOINT_PATH: &str = "/v1/api/result";
```
Keep `DEFAULT_BASE_URL`, `DEFAULT_PRO_MODEL`, `POLL_INTERVAL_MS` unchanged.

- [ ] **Step 2: 扩展 SUPPORTED_MODELS**

Replace lines 22-30:
```rust
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
```

- [ ] **Step 3: 替换请求体结构体**

Replace `DrawRequestBody` (lines 81-92):
```rust
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
```

- [ ] **Step 4: 新增辅助函数**

Insert after `encode_reference_for_grsai` (before `GrsaiGenerateRequestBody`):

```rust
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
}
```

- [ ] **Step 5: 删除 resolve_task_payload**

Delete lines 141-156 (`fn resolve_task_payload`). The new flat JSON API doesn't need code/data unwrapping.

- [ ] **Step 6: 重写 normalize_requested_model**

Replace lines 109-131:
```rust
fn normalize_requested_model(&self, request: &GenerateRequest) -> String {
    let requested = request
        .model
        .split_once('/')
        .map(|(_, model)| model.to_string())
        .unwrap_or_else(|| request.model.clone());

    // gpt-image-2 系列直接返回（不需要 variant 解析）
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
```

- [ ] **Step 7: 重写 request_draw → request_generate (unified)**

Replace the `request_draw` method (lines 168-228):
```rust
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
```

- [ ] **Step 8: 重写 poll_result_once → poll_once (GET + 扁平 JSON)**

Replace lines 230-277:
```rust
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

    // 扁平 JSON 响应：直接提取结果
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
```

- [ ] **Step 9: 更新 poll_result_until_complete 内部调用**

Replace `self.poll_result_once(task_id)` → `self.poll_once(task_id)` inside `poll_result_until_complete` (line 281):
```rust
match self.poll_once(task_id).await? {
```

- [ ] **Step 10: 重写 AIProvider impl 的 submit_task / poll_task / generate**

Replace lines 327-370 (entire impl block for these three methods):

```rust
async fn submit_task(&self, request: GenerateRequest) -> Result<ProviderTaskSubmission, AIError> {
    let model = self.normalize_requested_model(&request);
    let generate_response = self.request_generate(&request, model).await?;

    // 扁平 JSON 响应：直接解析（无 code/data 包装）
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
```

- [ ] **Step 11: 更新 list_models**

Replace lines 310-315:
```rust
fn list_models(&self) -> Vec<String> {
    vec![
        "grsai/nano-banana-2".to_string(),
        "grsai/nano-banana-pro".to_string(),
        "grsai/gpt-image-2".to_string(),
        "grsai/gpt-image-2-vip".to_string(),
    ]
}
```

- [ ] **Step 12: Rust 编译检查**

```bash
cd src-tauri && cargo check
```
Expected: `Finished dev profile` (可能有一些 unused import warnings，但不是 errors)

- [ ] **Step 13: Commit**

```bash
git add src-tauri/src/ai/providers/grsai/mod.rs
git commit -m "refactor(grsai): migrate to unified /v1/api/generate endpoint, add gpt-image-2 support

- Replace /v1/draw/nano-banana + /v1/draw/result with unified endpoints
- Remove code/data response wrapper (flat JSON now)
- Switch polling from POST {id} to GET ?id=xxx
- Add gpt-image-2 / gpt-image-2-vip model routing
- Add gpt-image-2-vip aspect ratio → pixel dimension mapping table
- Unify request body (urls→images, add optional imageSize)"
```

---

### Task 2: 前端类型扩展 + 调用点更新

**Files:**
- Modify: `src/features/canvas/models/types.ts`
- Modify: `src/features/canvas/nodes/ImageEditNode.tsx`
- Modify: `src/features/canvas/nodes/StoryboardGenNode.tsx`

**Interfaces:**
- Produces: `ImageModelRuntimeContext.aspectRatio?: string` (optional, backward-compatible)

- [ ] **Step 1: 扩展 ImageModelRuntimeContext**

In `src/features/canvas/models/types.ts`, add `aspectRatio?: string`:

Find:
```typescript
export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
}
```

Replace with:
```typescript
export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
  /** Currently selected aspect ratio — used by resolveResolutions to filter available resolutions */
  aspectRatio?: string;
}
```

- [ ] **Step 2: ImageEditNode — 传入 aspectRatio**

In `src/features/canvas/nodes/ImageEditNode.tsx`, find line 313:
```typescript
() => resolveImageModelResolutions(selectedModel, { extraParams: effectiveExtraParams }),
```

Replace with:
```typescript
() => resolveImageModelResolutions(selectedModel, {
  extraParams: effectiveExtraParams,
  aspectRatio: selectedAspectRatio.value,
}),
```

Also find the `selectedResolution` call on line 318:
```typescript
() => resolveImageModelResolution(selectedModel, data.size, { extraParams: effectiveExtraParams }),
```

Replace with:
```typescript
() => resolveImageModelResolution(selectedModel, data.size, {
  extraParams: effectiveExtraParams,
  aspectRatio: selectedAspectRatio.value,
}),
```

- [ ] **Step 3: StoryboardGenNode — 传入 aspectRatio**

In `src/features/canvas/nodes/StoryboardGenNode.tsx`, find line 675:
```typescript
() => resolveImageModelResolutions(selectedModel, { extraParams: effectiveExtraParams }),
```

Replace with:
```typescript
() => resolveImageModelResolutions(selectedModel, {
  extraParams: effectiveExtraParams,
  aspectRatio: selectedAspectRatio.value,
}),
```

Also find the `resolveImageModelResolution` call on line 679-682:
```typescript
return resolveImageModelResolution(selectedModel, nodeData.size, {
  extraParams: effectiveExtraParams,
});
```

Replace with:
```typescript
return resolveImageModelResolution(selectedModel, nodeData.size, {
  extraParams: effectiveExtraParams,
  aspectRatio: selectedAspectRatio.value,
});
```

- [ ] **Step 4: TS 类型检查**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/canvas/models/types.ts src/features/canvas/nodes/ImageEditNode.tsx src/features/canvas/nodes/StoryboardGenNode.tsx
git commit -m "feat: add aspectRatio to ImageModelRuntimeContext for dynamic resolution filtering"
```

---

### Task 3: 前端模型定义更新

**Files:**
- Modify: `src/features/canvas/models/image/grsai/nanoBanana2.ts`
- Create: `src/features/canvas/models/image/grsai/gptImage2.ts`

**Interfaces:**
- Produces: `ImageModelDefinition` for `grsai/gpt-image-2`, `grsai/gpt-image-2-vip`
- Produces: Updated `ImageModelDefinition` for `grsai/nano-banana-2`

- [ ] **Step 1: 更新 nano-banana-2 比例**

In `src/features/canvas/models/image/grsai/nanoBanana2.ts`, find the `NANO_BANANA_ASPECT_RATIOS` constant and replace:
```typescript
const NANO_BANANA_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
] as const;
```
→
```typescript
const NANO_BANANA_ASPECT_RATIOS = [
  '1:1',
  '16:9',
  '9:16',
  '4:3',
  '3:4',
  '3:2',
  '2:3',
  '5:4',
  '4:5',
  '21:9',
  '1:4',
  '4:1',
  '1:8',
  '8:1',
] as const;
```

- [ ] **Step 2: 新建 gptImage2.ts**

Create `src/features/canvas/models/image/grsai/gptImage2.ts`:

```typescript
import type { ImageModelDefinition, ResolutionOption } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';

export const GRSAI_GPT_IMAGE_2_MODEL_ID = 'grsai/gpt-image-2';
export const GRSAI_GPT_IMAGE_2_VIP_MODEL_ID = 'grsai/gpt-image-2-vip';

const GPT_IMAGE_2_ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4',
  '3:2', '2:3', '5:4', '4:5', '21:9',
  '9:21', '1:2', '2:1',
] as const;

const GPT_IMAGE_2_VIP_ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4',
  '3:2', '2:3', '5:4', '4:5', '21:9',
  '9:21', '1:3', '3:1', '2:1', '1:2',
] as const;

const ALL_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

const LIMITED_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

const SINGLE_1K_RESOLUTION: ResolutionOption[] = [
  { value: '1K', label: '1K' },
];

function resolveGptImage2VipResolutions(aspectRatio?: string): ResolutionOption[] {
  if (aspectRatio === '1:3' || aspectRatio === '3:1') {
    return LIMITED_RESOLUTIONS;
  }
  return ALL_RESOLUTIONS;
}

export const imageModel1: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: 'grsai',
  description: 'GPT Image 2 图像生成与编辑',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: GPT_IMAGE_2_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: SINGLE_1K_RESOLUTION,
  pricing: createGrsaiPointsPricing(() => 600),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};

export const imageModel2: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 VIP',
  providerId: 'grsai',
  description: 'GPT Image 2 VIP 图像生成与编辑（1K-4K）',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: GPT_IMAGE_2_VIP_ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: ALL_RESOLUTIONS,
  resolveResolutions: ({ aspectRatio }) => resolveGptImage2VipResolutions(aspectRatio),
  pricing: createGrsaiPointsPricing(() => 1300),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式（VIP）' : '生成模式（VIP）',
  }),
};
```

> **注意**: `registry.ts` 使用 `import.meta.glob` 查找 `{ imageModel: ImageModelDefinition }`。一个文件只能导出一个名为 `imageModel` 的变量。但是这里有两个模型，所以需要调整策略。

- [ ] **Step 3: 确认 registry 兼容性**

`registry.ts` 中 glob 模式为: `import.meta.glob<{ imageModel: ImageModelDefinition }>('./image/**/*.ts', { eager: true })`

每个文件只能导出一个 `imageModel`。需要拆分为两个文件：
- `src/features/canvas/models/image/grsai/gptImage2.ts` → 导出 `imageModel` (gpt-image-2)
- `src/features/canvas/models/image/grsai/gptImage2Vip.ts` → 导出 `imageModel` (gpt-image-2-vip)

所以修改 Step 2 的方案：拆成两个文件。

- [ ] **Step 3a: 新建 gptImage2.ts（GPT Image 2 标准版）**

```typescript
import type { ImageModelDefinition } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';

export const GRSAI_GPT_IMAGE_2_MODEL_ID = 'grsai/gpt-image-2';

const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4',
  '3:2', '2:3', '5:4', '4:5', '21:9',
  '9:21', '1:2', '2:1',
] as const;

export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2',
  providerId: 'grsai',
  description: 'GPT Image 2 图像生成与编辑',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: [{ value: '1K', label: '1K' }],
  pricing: createGrsaiPointsPricing(() => 600),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式' : '生成模式',
  }),
};
```

- [ ] **Step 3b: 新建 gptImage2Vip.ts（GPT Image 2 VIP版）**

```typescript
import type { ImageModelDefinition, ResolutionOption } from '../../types';
import { createGrsaiPointsPricing } from '@/features/canvas/pricing';

export const GRSAI_GPT_IMAGE_2_VIP_MODEL_ID = 'grsai/gpt-image-2-vip';

const ASPECT_RATIOS = [
  '1:1', '16:9', '9:16', '4:3', '3:4',
  '3:2', '2:3', '5:4', '4:5', '21:9',
  '9:21', '1:3', '3:1', '2:1', '1:2',
] as const;

const ALL_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
  { value: '4K', label: '4K' },
];

const LIMITED_RESOLUTIONS: ResolutionOption[] = [
  { value: '1K', label: '1K' },
  { value: '2K', label: '2K' },
];

function resolveVipResolutions(aspectRatio?: string): ResolutionOption[] {
  return (aspectRatio === '1:3' || aspectRatio === '3:1')
    ? LIMITED_RESOLUTIONS
    : ALL_RESOLUTIONS;
}

export const imageModel: ImageModelDefinition = {
  id: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
  mediaType: 'image',
  displayName: 'GPT Image 2 VIP',
  providerId: 'grsai',
  description: 'GPT Image 2 VIP 图像生成与编辑（1K-4K）',
  eta: '30s',
  expectedDurationMs: 30000,
  defaultAspectRatio: '1:1',
  defaultResolution: '1K',
  aspectRatios: ASPECT_RATIOS.map((value) => ({ value, label: value })),
  resolutions: ALL_RESOLUTIONS,
  resolveResolutions: ({ aspectRatio }) => resolveVipResolutions(aspectRatio),
  pricing: createGrsaiPointsPricing(() => 1300),
  resolveRequest: ({ referenceImageCount }) => ({
    requestModel: GRSAI_GPT_IMAGE_2_VIP_MODEL_ID,
    modeLabel: referenceImageCount > 0 ? '编辑模式（VIP）' : '生成模式（VIP）',
  }),
};
```

- [ ] **Step 4: TS 类型检查**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 5: Commit**

```bash
git add src/features/canvas/models/image/grsai/nanoBanana2.ts src/features/canvas/models/image/grsai/gptImage2.ts src/features/canvas/models/image/grsai/gptImage2Vip.ts
git commit -m "feat: add gpt-image-2 / gpt-image-2-vip models, update nano-banana-2 ratios

- nano-banana-2: add 1:4/4:1/1:8/8:1 aspect ratios per unified API
- gpt-image-2: 600 points, 13 ratios, 1K only
- gpt-image-2-vip: 1300 points, 15 ratios, dynamic resolutions (1:3/3:1 without 4K)"
```

---

### Task 4: 验证 + 收尾

- [ ] **Step 1: TS 全量类型检查**

```bash
npx tsc --noEmit
```
Expected: no errors.

- [ ] **Step 2: Rust 全量检查**

```bash
cd src-tauri && cargo check
```
Expected: `Finished dev profile`.

- [ ] **Step 3: 启动应用手工测试**

```bash
npm run tauri dev
```

验证项：
1. 设置页面 → Grsai API Key 已配置
2. 选择 `gpt-image-2` 模型 → 显示 13 个比例、1K 分辨率
3. 输入提示词、点击生成 → 任务成功
4. 选择 `gpt-image-2-vip` 模型 → 显示 15 个比例
5. 选 `1:3` 比例 → 分辨率仅显示 1K/2K（不显示 4K）
6. 选 `16:9` 比例 → 分辨率显示 1K/2K/4K
7. 选 `nano-banana-2` → 显示 14 个比例（含 1:4, 1:8）

- [ ] **Step 4: 最终 commit（如有遗漏）**

```bash
git status
# 确认无遗漏文件
```
