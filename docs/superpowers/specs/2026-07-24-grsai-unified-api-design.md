# Grsai 统一 API 适配设计

日期: 2026-07-24 | 版本: 1.0

## 背景

Grsai 将 nano-banana 和 gpt-image-2 两套 API 统一到了同一个端点：
- **生成**: `POST /v1/api/generate`
- **查询**: `GET /v1/api/result?id=xxx`
- **Auth**: `Authorization: Bearer sk-xxx`
- **响应**: 扁平 JSON `{id, status(running|violation|succeeded|failed), results[{url}], progress, error}`

现有后端仍使用旧端点（`/v1/draw/nano-banana` + POST `/v1/draw/result` + code/data 包装），需要统一重构并新增 gpt-image-2 系列模型。

## 后端设计

### GrsaiProvider 重构（`src-tauri/src/ai/providers/grsai/mod.rs`）

**删除**:
- `DRAW_ENDPOINT_PATH`（`/v1/draw/nano-banana`）
- `RESULT_ENDPOINT_PATH`（`/v1/draw/result`）
- `resolve_task_payload`（code/data 解包函数）
- `DrawRequestBody`（旧请求体结构）

**新增**:
```rust
const GENERATE_ENDPOINT_PATH: &str = "/v1/api/generate";
const RESULT_ENDPOINT_PATH: &str = "/v1/api/result";
```

**统一请求体**:
```rust
#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct GrsaiGenerateRequestBody {
    model: String,
    prompt: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    images: Option<Vec<String>>,
    aspect_ratio: String,
    reply_type: String,          // 固定 "json"
    #[serde(skip_serializing_if = "Option::is_none")]
    image_size: Option<String>,  // 仅 nano-banana 系列发送
}
```

**模型路由** (`normalize_requested_model`):
```
gpt-image-2 / gpt-image-2-vip → 构建 GptImage 请求体（images + aspectRatio，无 imageSize）
nano-banana-*                  → 构建请求体（images + aspectRatio + imageSize）
```

**gpt-image-2 aspectRatio**:
- `gpt-image-2`: 直接传前端选择的比率字符串（如 "16:9"）
- `gpt-image-2-vip`: 从 `GenerateRequest.aspect_ratio` + `GenerateRequest.size` 查映射表得到像素值（如 "16:9"+"2K" → "2048x1152"）

**gpt-image-2-vip 分辨率映射表**: 15 个比例 × 最多 3 个分辨率，从 API 文档逐项提取（1:3/3:1 无 4K）。

**轮询改造**: POST `{"id": "xxx"}` → GET `?id=xxx`，响应统一为扁平 JSON。

**状态处理新增**: `violation` 状态映射为 `Failed("content violation")`。

**SUPPORTED_MODELS** 更新:
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

**list_models** 更新:
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

**复用**:
- `encode_reference_for_grsai`: 不变，base64/URL 编码格式相同
- `extract_result_url`: 不变，`results[0].url` 结构相同
- API Key 管理: 共用 `Arc<RwLock<Option<String>>>`

## 前端设计

### 1. `ImageModelRuntimeContext` 扩展（`types.ts`）

```typescript
export interface ImageModelRuntimeContext {
  extraParams?: Record<string, unknown>;
  aspectRatio?: string;   // 新增，用于动态过滤分辨率
}
```

### 2. 调用点更新（`ImageEditNode.tsx` + `StoryboardGenNode.tsx`）

```typescript
resolveImageModelResolutions(selectedModel, {
  extraParams: effectiveExtraParams,
  aspectRatio: selectedAspectRatio.value,
})
```

### 3. nano-banana-2 模型更新（`image/grsai/nanoBanana2.ts`）

aspectRatios 从 10 个扩展到 14 个（新增 1:4, 4:1, 1:8, 8:1），resolutions 不变。

### 4. nano-banana-pro 模型（`image/grsai/nanoBananaPro.ts`）

无需改动（10 个比例，resolutions 按 variant 过滤逻辑不变）。

### 5. 新建 gpt-image-2 模型（`image/grsai/gptImage2.ts`）

**gpt-image-2**（600 积分）:
- aspectRatios: 13 个（1:1, 16:9, 9:16, 4:3, 3:4, 3:2, 2:3, 5:4, 4:5, 21:9, 9:21, 1:2, 2:1）
- resolutions: 仅 1K（无需动态过滤）
- defaultAspectRatio: '1:1', defaultResolution: '1K'

**gpt-image-2-vip**（1300 积分）:
- aspectRatios: 15 个（标准 13 个 + 1:3, 3:1）
- resolutions: `resolveResolutions({ aspectRatio })` 动态过滤
  - `1:3`, `3:1` → `[1K, 2K]`
  - 其他 → `[1K, 2K, 4K]`
- defaultAspectRatio: '1:1', defaultResolution: '1K'

## 完整模型参数对照

| 模型 | ratios | resolutions | 调用 aspectRatio | 调用 imageSize | 积分 |
|------|--------|-------------|-------------------|----------------|------|
| nano-banana-2 | 14 | 1K/2K/4K | 比率字符串 | 1K/2K/4K | 1300 |
| nano-banana-pro | 10 | 按variant | 比率字符串 | 1K/2K/4K | 按variant |
| gpt-image-2 | 13 | 1K | 比率字符串 | 不发 | 600 |
| gpt-image-2-vip | 15 | 动态(1:3/3:1无4K) | 像素值(查表) | 不发 | 1300 |

## 改动文件清单

| 文件 | 操作 | 说明 |
|------|------|------|
| `src-tauri/src/ai/providers/grsai/mod.rs` | 改 | 统一端点、请求体、轮询，删除 code/data 解包 |
| `src/features/canvas/models/types.ts` | 改 | ImageModelRuntimeContext +aspectRatio |
| `src/features/canvas/nodes/ImageEditNode.tsx` | 改 | 传 aspectRatio 到 resolveResolutions |
| `src/features/canvas/nodes/StoryboardGenNode.tsx` | 改 | 同上 |
| `src/features/canvas/models/image/grsai/nanoBanana2.ts` | 改 | aspectRatios 补 4 个比例 |
| `src/features/canvas/models/image/grsai/gptImage2.ts` | 新建 | gpt-image-2 + gpt-image-2-vip 定义 |

## 验证

1. `npx tsc --noEmit` — TS 类型检查
2. `cd src-tauri && cargo check` — Rust 编译
3. 功能：文生图 / 图生图 / 异步轮询 / 违规失败处理 / gpt-image-2-vip 分辨率动态过滤
