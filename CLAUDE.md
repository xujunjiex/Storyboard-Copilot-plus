# CLAUDE.md

## 1. 项目目标与技术栈

- 产品目标：基于节点画布进行图片/视频上传、AI 生成、提示词润色与视频创作流程。
- 前端：React + TypeScript + Zustand + @xyflow/react + TailwindCSS。
- 后端：Tauri 2 + Rust（命令式接口）+ SQLite（rusqlite，WAL）。
- 关键原则：解耦、可扩展、可回归验证、自动持久化、交互性能优先。

## 2. 代码库浏览顺序

建议按以下顺序理解项目：

1. 入口与全局状态
- `src/App.tsx`
- `src/stores/projectStore.ts`
- `src/stores/canvasStore.ts`

2. 画布主流程
- `src/features/canvas/Canvas.tsx`
- `src/features/canvas/domain/canvasNodes.ts`
- `src/features/canvas/domain/nodeRegistry.ts`
- `src/features/canvas/NodeSelectionMenu.tsx`

3. 节点与覆盖层
- `src/features/canvas/nodes/*.tsx`
- `src/features/canvas/nodes/ImageEditNode.tsx`
- `src/features/canvas/nodes/VideoGenNode.tsx`（视频生成：单图/首尾帧）
- `src/features/canvas/nodes/VideoResultNode.tsx`（视频结果展示）
- `src/features/canvas/nodes/GroupNode.tsx`
- `src/features/canvas/ui/SelectedNodeOverlay.tsx`
- `src/features/canvas/ui/NodeActionToolbar.tsx`
- `src/features/canvas/ui/NodeToolDialog.tsx`
- `src/features/canvas/ui/nodeControlStyles.ts`
- `src/features/canvas/ui/nodeToolbarConfig.ts`

4. 工具体系（重点）
- `src/features/canvas/tools/types.ts`
- `src/features/canvas/tools/builtInTools.ts`
- `src/features/canvas/ui/tool-editors/*`
- `src/features/canvas/application/toolProcessor.ts`

5. 模型与供应商适配
- `src/features/canvas/models/types.ts`
- `src/features/canvas/models/registry.ts`
- `src/features/canvas/models/image/*`
- `src/features/canvas/models/providers/*`

6. Tauri 命令与持久化
- `src/commands/*.ts`
- `src/commands/projectState.ts`
- `src-tauri/src/commands/*.rs`
- `src-tauri/src/commands/project_state.rs`
- `src-tauri/src/lib.rs`

## 3. 开发工作流

1. 明确变更范围
- 先界定是 UI 变更、节点行为变更、工具逻辑变更、模型适配变更，还是持久化/性能变更。

2. 沿着数据流改动
- UI 输入 -> Store -> 应用服务 -> 基础设施（命令/API）-> 持久化。
- 禁止跨层“偷改”状态；尽量只在对应层处理对应职责。

3. 小步提交与即时验证
- 每次改动后做轻量检查（见第 6 节），通过后再继续。

4. 最后做一次完整构建
- 在功能收尾或大改合并前运行完整构建。

5. 发布快捷口令
- 当用户明确说“推送更新”时，默认执行一次补丁版本发布：基于上一个 release/tag 自动递增 patch 版本号，汇总代码变动生成 Markdown 更新日志，完成版本同步、发布提交、annotated tag 与远端推送；如用户额外指定 minor/major 或自定义说明，则按用户要求覆盖默认行为。
- 自动生成的更新日志正文只保留 `## 新增`、`## 优化`、`## 修复` 等二级标题分组与对应列表项；不要额外输出 `# vx.y.z` 标题、`基于某个 tag 之后的若干提交整理` 说明或 `## 完整提交` 区块，空分组可省略。

## 4. 架构与解耦标准

### 4.1 依赖与边界

- 模块间优先依赖接口/类型，不直接依赖具体实现细节。
- 跨模块通信优先使用事件总线或明确的 service/port。
- 展示层（UI）不直接耦合基础设施层（Tauri/API 调用）；通过应用层中转。

### 4.2 单一职责

- 一个文件只做一个业务概念；无法用三句话说清职责就应拆分。
- 工具 UI、工具数据结构、工具执行逻辑应分离（已采用：editor / annotation codec / processor）。

### 4.3 文件规模控制

- 舒适区：类 <= 400 行，脚本 <= 300 行。
- 警戒线：800 行，必须评估拆分。
- 强制拆分：1000 行（纯数据定义除外）。

### 4.4 层间通信

- 使用 DTO/纯数据对象，避免双向引用。
- Store 不应直接承担重业务逻辑；业务逻辑放应用层。

### 4.5 AI Provider 异步任务模式

- AI 任务采用 submit → poll → get result 三段式流程，由 `ProviderTaskHandle.task_id` 关联。
- `supports_task_resume()` 返回 true 时可中断后恢复，否则需一次性完成。
- 参考：`src-tauri/src/ai/mod.rs` 中的 `AIProvider` trait、`ProviderTaskSubmission`、`ProviderTaskPollResult`。

### 4.6 节点注册单一真相源

- 节点类型、默认数据、菜单展示、连线能力统一在 `domain/nodeRegistry.ts` 声明，不在 `Canvas.tsx` / `canvasStore.ts` 重复硬编码。
- `connectivity` 为连线能力配置源：
  - `sourceHandle` / `targetHandle`：是否具备输入输出端口。
  - `connectMenu.fromSource` / `connectMenu.fromTarget`：从输出端或输入端拉线时，是否允许出现在“创建节点菜单”。
- 菜单候选节点必须由注册表函数统一推导（如 `getConnectMenuNodeTypes`），禁止在 UI 层手写类型白名单。
- 内部衍生节点（如切割结果 `storyboardSplit`、导出节点）默认 `connectMenu` 关闭，只能由应用流程自动创建。

### 4.7 润色服务架构

所有润色功能统一使用文本API（textApis），根据节点类型选择对应模板：

| 节点类型 | 模板类型 | 模板来源 |
|---------|---------|---------|
| 图片节点（ImageEditNode） | image | 设置页面 - 图片API配置 |
| 上传节点描述（UploadNode） | image | 设置页面 - 图片API配置 |
| 视频节点（VideoGenNode） | video | 各视频API配置的 `polishPrompt`（用户自定义）或 `defaultPolishPrompt`（默认模板） |

**视频模型默认模板：**

| 模型 | 默认模板 |
|---|---|
| Seedance 2.0 / 2.0 Fast | `DEFAULT_VIDEO_SD10_POLISH_PROMPT` |
| Seedance 1.5 Pro | `DEFAULT_VIDEO_SD15_PROMPT` |

**相关文件：**
- `src/features/canvas/infrastructure/textPolishService.ts` - 润色服务调用入口
- `src-tauri/src/commands/ai.rs` 中的 `polish_text` 命令 - Rust 后端实现
- `src/stores/settingsStore.ts` - `imagePolishPrompt`（图片模板）；视频模板改为 `VideoApiConfig.polishPrompt` / `VideoApiConfig.defaultPolishPrompt`

**API 调用规则：**
- 所有润色使用 textApis（不是 videoApis）
- base_url、api_key、model_id 全部来自用户配置，无硬编码
- `prompt_type` 字段决定使用哪种默认模板（image 或 video）

## 5. UI/交互规范

- 复用统一 UI 组件：`src/components/ui/primitives.tsx`。
- 风格统一使用设计变量和 token（`index.css`），避免散落硬编码样式。
- 输入框、工具条、弹窗保持与节点对齐，交互动画保持一致。
- 节点底部控制条（模型/比例/生成/导出等）尺寸样式统一从 `src/features/canvas/ui/nodeControlStyles.ts` 引用，禁止在各节点散落硬编码一套新尺寸。
- 节点工具条（NodeToolbar）位置、对齐、偏移统一从 `src/features/canvas/ui/nodeToolbarConfig.ts` 引用；禁止通过 `left/translate` 等绝对定位覆盖跟随逻辑。
- 选中覆盖层 `SelectedNodeOverlay` 只承载轻量通用覆盖能力（如工具条），节点核心业务输入区应内聚到节点组件本体（例如 `ImageEditNode`）。
- 对话框支持“打开/关闭”过渡，避免突兀闪烁。
- 明暗主题要可读，避免高饱和蓝色抢占焦点（导航图已优化为灰黑系）。
- 快捷键应避开输入态（`input/textarea/contentEditable`）避免误触。

## 6. 命令与验证

### 6.1 常用开发命令

```bash
# 前端开发
npm run dev

# Tauri 联调
npm run tauri dev

# 自动发布（默认建议配合 docs/releases/vx.y.z.md 使用）
npm run release -- patch --notes-file docs/releases/v{version}.md
```

### 6.2 快速检查（优先执行）

```bash
# TS 类型检查
npx tsc --noEmit

# Rust 快速检查
cd src-tauri && cargo check
```

### 6.3 测试命令

```bash
# 前端测试（需先停止 dev server）
npm run test

# Playwright 端到端测试
npx playwright test
```

### 6.4 收尾检查

# Rust 快速检查
cd src-tauri && cargo check
```

### 6.4 收尾检查

```bash
# 前端完整构建
npm run build

# 触发一次正式发布（会同步版本、提交、打 tag、推送）
npm run release -- patch --notes-file docs/releases/v0.2.1.md
```

说明：
- 日常迭代不要求每次都完整打包，先走 `tsc --noEmit` + 关键路径手测。
- 影响打包、依赖、入口、持久化、Tauri 命令时，再执行完整构建。
- 发布说明优先落到 `docs/releases/vx.y.z.md`，再通过 `npm run release` 或“推送更新”口令触发发布。
- `docs/releases/vx.y.z.md` 的默认格式同样只保留二级标题分组和列表正文，不写额外总标题、范围说明和完整提交清单。

## 7. 性能实践

- 禁止在拖拽每一帧执行重持久化或重计算。
- 节点拖拽中不要写盘；拖拽结束再保存（项目已按该策略优化）。
- 大图片场景避免重复 `dataURL` 转换；节点渲染优先使用 `previewImageUrl`，模型/工具处理使用原图 `imageUrl`。
- 项目整量持久化（nodes/edges/history）使用防抖 + 空闲调度（idle callback）队列，避免与交互争用主线程。
- viewport 持久化走独立轻量队列与独立命令（`update_project_viewport_record`），不要回退到整项目 upsert。
- 视口更新要做归一化与阈值比较（epsilon），过滤微小抖动写入。
- 优先使用 `useMemo/useCallback` 控制重渲染；避免把大对象直接塞进依赖导致抖动。
- 画布交互优先“流畅”而非“实时全量持久化”，可使用短延迟合并保存。

## 8. 模型与工具扩展规范

### 8.1 新模型接入

- 一模型一文件，放到 `src/features/canvas/models/image/<provider>/`。
- 在模型定义中声明：
  - `displayName`
  - `providerId`
  - 支持分辨率/比例
  - 默认参数
  - 请求映射函数 `resolveRequest`

**Provider 匹配规则** (`resolve_provider_for_model`)：
1. 显式前缀优先：如 `volcvideo/doubao-seedance-xxx` 直接命中对应 provider
2. 无前缀时：遍历所有 provider 的 `supports_model()`，返回第一个匹配的
3. `VolcVideoProvider` 的 `supports_model` 匹配所有 `doubao-seedance-*` 变体

**视频生成流程（submit → poll → get result）**：
- `VideoGenNode` 调用 `submitGenerateImageJob` 获取 `jobId`
- 创建 `exportVideo` 节点，Canvas 在 `videoApis` 中按**模型精确匹配**查找 API key（忽略 enabled 标志）
- `Canvas` polling 监听 `exportVideo` 节点的 `generationJobId`，轮询直到完成

### 8.2 视频节点体系

| 节点类型 | 说明 |
|---|---|
| `videoSingle` | 单图参考生成视频节点（手动拖入画布） |
| `videoFrame` | 首尾帧视频生成节点（target-first / target-last 两个 handle） |
| `exportVideo` | 视频结果展示节点（由生成节点自动创建，不手动创建） |

- 生成节点（`videoSingle`/`videoFrame`）提交任务后自动创建 `exportVideo` 节点
- `exportVideo` 节点的 polling 在 `Canvas.tsx` 的 `pendingVideoNodes` effect 中处理
- `videoFrame` 的两个 handle：`target-first`（首帧）、`target-last`（尾帧）
- `graphImageResolver.collectInputImages` 对 `videoFrame` 按 handle 分开收集 `[firstFrameImage, lastFrameImage]`，对 `videoSingle` 收集所有输入图片返回单张数组
- API 层面：`videoFrame` 传入 2 张图片并分配 `first_frame`/`last_frame` role，`videoSingle` 传入 1 张图片 role 为 `None`

**图片规范化规则**：
- 润色模型（KIE/FAL）：直接使用 `data:` URL 或已有 HTTP URL，不做转换
- 视频生成模型：本地图片（`asset://`、`file://`、裸路径）必须上传到 `litterbox.catbox.moe` 获取公网 HTTP URL；公网 URL 直接透传
- `isLikelyLocalImagePath()` 对 `data:`、`http:`、`https:`、`blob:`、`tauri:`、`file://` 返回 `false`，这些不触发 VOD 上传

**Draft Mode 样片模式**（SD 1.5 pro 专属）：
1. 生成样片：勾选"样片模式"，生成 draft 视频（480p，不可与尾帧/离线推理混用）
2. 样片完成后：火山引擎返回的 `external_task_id`（格式 `cgt-xxx`）存入 `exportVideo` 节点的 `draftTaskId`，显示"生成正式视频"按钮
3. 生成正式：点击按钮，创建新 `exportVideo` 节点并连接，提交带 `draft_task_id` 的任务（分辨率固定 720p，不继承草稿 480p）

**SD 2.0 专属视频生成节点**（规划中）：

| 节点类型 | 说明 |
|---|---|
| `sd2ImageUpload` | SD 2.0 图片上传节点（显示缩略图和"图1"标签） |
| `sd2AudioUpload` | SD 2.0 音频上传节点（显示文件名和"音频1"标签，无预览） |
| `sd2VideoUpload` | SD 2.0 视频上传节点（显示视频缩略图和"视频1"标签） |
| `sd2VideoGen` | SD 2.0 专属视频生成节点，支持四种模式： |
| | - 多模态参考：文本1 + 图片0-9 + 视频0-3 + 音频0-3 |
| | - 编辑视频：文本1 + 图片0-9 + 视频1 + 音频0 |
| | - 延长拼接：文本1 + 图片0 + 视频2-3 + 音频0 |
| | - 联网搜索：文本1 + 图片0 + 视频0 + 音频0 |

**SD 2.0 模型 ID**：
- `doubao-seedance-2-0-260128`（Seedance 2.0）
- `doubao-seedance-2-0-fast-260128`（Seedance 2.0 Fast）

**SD 2.0 功能差异**：

| 功能 | SD 2.0 | SD 2.0 Fast | SD 1.5 Pro |
|------|--------|-------------|-----------|
| 分辨率 1080p | ✓ | ✗ | ✓ |
| generateAudio | ✓ | ✓ | ✓ |
| 样片模式 (draft) | ✗ | ✗ | ✓ |
| 联网搜索 | ✓ | ✓ | ✗ |
| 多模态参考 | ✓ | ✓ | ✗ |
| service_tier | ✗ | ✗ | ✗ |

### 8.3 新工具接入

1. 在 `tools/types.ts` 声明能力（如 editor kind）。
2. 在 `tools/builtInTools.ts` 注册插件。
3. 在 `ui/tool-editors/` 新增对应编辑器。
4. 在 `application/toolProcessor.ts` 接入执行逻辑。
5. 保证产物仍走“处理后生成新节点”链路，不覆盖原节点。

### 8.4 新节点接入

1. 在 `domain/canvasNodes.ts` 增加类型与数据结构（必要时增加类型守卫）。
2. 在 `domain/nodeRegistry.ts` 注册定义：`createDefaultData`、`capabilities`、`connectivity`。
3. 在 `nodes/index.ts` 注册渲染组件。
4. 明确手动创建策略：
   - 可手动创建：配置 `connectMenu.fromSource/fromTarget`。
   - 仅流程创建：关闭 `connectMenu`，由工具/应用服务触发。
5. 如新增分组/父子节点行为，必须同步验证删除、解组、连线清理与历史快照。
6. 节点内控制条优先复用 `nodeControlStyles.ts` 里的统一尺寸 token；若需特化，基于统一 token 小幅覆盖，不新建一整套尺寸体系。
7. 节点工具条必须复用 `nodeToolbarConfig.ts`，并验证两点：
   - 拖拽节点时工具条随节点同步移动。
   - 多种节点尺寸下工具条仍保持相对居中（不出现固定在画布某处的情况）。

## 9. 持久化规范

### 9.1 项目文件夹结构

每个项目创建时自动生成目录结构：
```
{projectDir}/
├── _project.json          # 项目元数据（UUID、项目名称）
├── uploads/               # 用户上传的原始图片
└── outputs/
    ├── images/            # AI 生成的图片
    └── videos/            # AI 生成的视频
```

项目路径通过 `create_project_dirs` 创建，`delete_project_record` 删除时同步清理。

- 项目数据通过 `projectStore` 自动持久化，不要求手动保存。
- 重启默认进入项目页；进入项目时恢复上次 viewport。
- 当前持久化后端为 SQLite，库文件位于 Tauri `app_data_dir/projects.db`。
- `projects` 表核心字段：`nodes_json`、`edges_json`、`viewport_json`、`history_json`、`node_count`。
- 前端持久化采用双通道：
  - 整项目快照：`upsert_project_record`（防抖 + idle 调度）。
  - 视口快照：`update_project_viewport_record`（轻量更新、独立防抖）。
- 图片去重：图片数据存在 `imagePool` 字典中，节点通过 `__img_ref__<pool_key>` 引用。新增图片字段（如 `previewImageUrl`）需同步更新编解码映射。
- 变更 SQLite 表结构时：
  - 必须在 `ensure_projects_table` 中做自愈（`PRAGMA table_info` + `ALTER TABLE`）。
  - 开发阶段可不兼容旧的临时草稿格式，但不能破坏当前 `projects.db` 的基本可读性。

## 10. 已知坑点

- **Tauri 重编译前必须关闭旧进程**：`cargo build` 时会尝试覆写 `target/debug/storyboard-copilot.exe`，如果旧进程未关闭会导致 `拒绝访问 (os error 5)`。重编前执行 `taskkill //F //IM storyboard-copilot.exe` 确保旧进程已终止。
- **图片 URL 格式**：`asset://`、`file://`、`blob:` 等本地协议需要通过 VOD 上传才能给视频生成 API 使用。`isLikelyLocalImagePath` 决定是否走上传流程。
- **`asset://` 排除问题**：`imageData.ts` 中 `isLikelyLocalImagePath` 不能排除 `asset://`，否则图片跳过 VOD 上传导致后端 `source_to_url` 失败。
- **Provider 匹配失败**：`VolcVideoProvider::supports_model` 必须覆盖所有火山视频模型名称，否则请求会路由到其他 provider 而报 "API key not set"。
- **VideoSubmitContent 的 role**：`first_frame`/`last_frame` 按 content 数组**实际位置**分配（用 `content.is_empty()`），而非原始索引。
- **Video API Key 查找**：不再依赖 `enabled` 字段，按 `modelId` 精确匹配，找不到则用任意有 key 的配置。
- **取消功能已移除**：视频生成节点没有取消按钮，任务一旦提交只能等待完成或失败。
- **视频生成图片上传竞态**：`upload_image_to_volc_vod` 临时文件用 `process_id` 命名，并发上传会碰撞。必须加 nanosecond 时间戳确保唯一：`format!("upload_{}_{}.{}", process_id, unique_id, ext)`
- **videoFrame 连线规则**：`videoFrame` 节点有 `target-first`（首帧，35%位置）和 `target-last`（尾帧，65%位置）两个 handle，连线创建时必须用 `target-first`，不能用 `target`；`videoSingle` 用单个 `target` handle
- **草稿视频 external_task_id**：`exportVideo` 节点的 `draftTaskId` 必须存火山引擎返回的 external task ID（格式 `cgt-xxx`），不是内部 `jobId`。新生成的草稿视频才会存储正确的 external task ID，旧视频需重新生成。
- **正式视频分辨率**：生成正式视频时固定使用 720p，不继承草稿视频的 480p。
- **handleGenerateFinal 执行顺序**：点击"生成正式视频"后，先创建新节点（`isGenerating: true`），再调用 API 提交正式视频生成任务，API 失败时在新建节点上显示错误信息（从 JSON 的 `message` 字段提取）
- **draft_task 模式 audio 参数**：从草稿生成正式视频时，不应发送 `generate_audio` 参数，草稿视频已包含音频设置。`volcvideo.rs` 中通过检查 `draft_task_id.is_none()` 来区分。
- **视频 polling 失败处理**：`Canvas.tsx` 中 polling 连续失败 5 次后会在节点上显示"网络请求失败"错误，不再无限静默重试。
- **本地视频播放**：`VideoResultNode` 使用 `resolveVideoDisplayUrl(data.videoUrl)` 转换本地路径，使 Tauri webview 能播放项目目录下的视频文件。参考：`src/features/canvas/application/imageData.ts`。
- **uploads 目录不可删除**：`{projectDir}/uploads/` 是画布图的数据源之一（节点 `imagePool` 可能直接引用 `uploads/` 下的绝对路径），删除后画布图片显示破图。删除前需先确认项目数据已全部迁移到 imagePool。
- **gpt-image-2 字段差异**：`gpt-image-2` 端点**没有** `imageSize` 字段（用 `#[serde(skip_serializing_if)]` 省略），只支持 `aspectRatio`（比例字符串或 1K 像素值）。`gpt-image-2-vip` 则把 ratio+resolution 查表映射为像素值。`nano-banana` 有 `imageSize`。
- **Grsai 端点统一化**：nano-banana 和 gpt-image-2 都用 `POST /v1/api/generate`（不再是旧的 `/v1/draw/nano-banana`），响应扁平 JSON 无 `code`/`data` 包装；查询走 `GET /v1/api/result?id=xxx`。
- **参考图尺寸压缩**：`encode_reference_for_grsai` 必须把参考图长边压缩到 ≤ 1K（1024px）再 base64，否则 Grsai 端点返回 400 "Parameter data type error"。JPEG 保持 JPEG q=85，PNG/WebP/GIF 统一转 JPEG。uploads 物理文件本身不被压缩（compress 只发生在 `encode_reference_for_grsai` 里）。
- **生成节点 generationJobId 必须有值**：`Canvas.tsx` 轮询过滤条件 `data.generationJobId.length > 0` —— app 关闭过早时节点上 `generationJobId=""` 永远不轮询。Canvas 启动时调 `listResumableGenerationJobs`（查后端 SQLite `ai_generation_jobs` 表）回填空 `generationJobId` 的 exportImageNode。
- **前端日志监控缺失**：Rust `tracing::error!` 写到 `storyboard.log` 文件但**不回传**前端 `LogPanel`。修复：后端用 `app.emit("backend:ai-error", ...)` 推 Tauri event，前端 `src/lib/logger/index.ts` `ensureBackendErrorListener()` 订阅并 append 到 LogStore。

## 11. 提交前检查清单

- 功能路径可用（至少手测 1 条主路径 + 1 条异常路径）。
- 无明显性能回退（拖拽、缩放、输入响应）。
- 轻量检查通过：`npx tsc --noEmit`，Rust 改动则 `cargo check`。
- 大改或发布前：`npm run build`。
- 如为正式发布，确认 `docs/releases/vx.y.z.md` 已更新，并与本次 tag/版本号一致。
- 新增约束/行为变化需同步更新文档。

## 12. i18n 规范

- i18n 入口：`src/i18n/index.ts`
- 语言文件：`src/i18n/locales/zh.json`、`src/i18n/locales/en.json`
- 组件中统一使用 `useTranslation()` + `t('key.path')`，避免硬编码中英文文案。

### 12.1 Key 命名

- 使用模块化层级命名：`project.title`、`node.menu.uploadImage`、`common.save`。
- 避免把中文句子直接作为 key；key 必须稳定、可复用、可检索。
- 通用文案优先放 `common.*`，页面专属文案放对应模块前缀。

### 12.2 新增文案流程

1. 先在 `zh.json` 增加新 key。
2. 同步在 `en.json` 增加相同 key（不要缺语言键）。
3. 代码里只引用 key，不写 fallback 字面量。

### 12.3 动态值与复数

- 动态值用插值：`t('xxx', { count, name })`。
- 数量相关场景使用 i18next 复数规则，不手写字符串拼接。
- 数字/时间等先格式化，再传给 `t`。

### 12.4 最低验证

- 切换中英文后，不出现未翻译 key 泄露（例如直接显示 `project.title`）。
- 新增 key 在中英语言包均存在。
- 关键按钮、提示、错误文案在两种语言下都可读不截断。

## 13. 设置页面菜单结构

设置页面使用以下分类（SettingsCategory）：
- `general` - 通用设置
- `imageApis` - 图片API（AI 图片供应商的 API Key 配置 + 全局图片提示词润色模板）
- `textApis` - 文本API（文本润色服务 API 配置）
- `videoApis` - 视频API（视频生成服务 API 配置）
- `pricing` - 价格
- `appearance` - 外观
- `experimental` - 实验
- `about` - 关于

---

## 14. 日志系统概览

**位置**：项目根 `logs/storyboard.log.YYYY-MM-DD`（通过 `CARGO_MANIFEST_DIR.parent()` 定位项目根，不用 `$TEMP`）。日切保留 14 天（`commands/cleanup::cleanup_old_logs`）。

**写入链路**：Rust 业务 `tracing::info!/warn!/error!` + 前端 `logger.error/info/warn`（走 `append_frontend_log` Tauri 命令）→ `tracing_subscriber` → `tracing_appender::rolling::daily` → 磁盘文件。Frontend `logger.error` 走 `useLogStore.appendEntry()` 写到内存 RingBuffer（容量 500）→ `LogPanel` 实时显示。

**前后端桥接（重要）**：Rust `tracing::error!` **不**会自动显示在 LogPanel。必须显式 `app.emit("backend:ai-error", ...)`，前端 `src/lib/logger/index.ts` 的 `ensureBackendErrorListener()` 订阅后 append 到 LogStore。修改 Provider 错误处理时同时加 tracing + emit。**调试 AI 报错的标准流程**：触发请求 → `tail -f logs/storyboard.log.$(date +%Y-%m-%d)` → 搜 `GRSAI Error` / `AI Backend Error`。**不要只盯着 `grsai_debug.log` 那种独立文件**——它跟日志管理器不是同一个体系。

**关键文件**：
- `src-tauri/src/lib.rs:21-42` `resolve_log_dir()` 决定日志目录（必须走项目根）
- `src-tauri/src/commands/cleanup.rs` 14 天清理策略（`KEEP_DAYS = 14`）
- `src-tauri/src/commands/logging.rs` `append_frontend_log` Tauri 命令 + `open_log_dir` 命令（设置里"打开日志目录"按钮调用）
- `src/lib/logger/store.ts` 前端 LogStore（Zustand RingBuffer）
- `src/lib/logger/transport.ts` 前端 Transport（200ms 批量 flush 到 Rust）
- `src/lib/logger/index.ts` `backend:ai-error` 事件桥接监听器（模块加载时自动启动）

## 15. Grsai / gpt-image-2 适配规范

**统一端点**：所有 Grsai 模型都用 `POST /v1/api/generate` + `GET /v1/api/result?id=xxx`，**不再用** `/v1/draw/nano-banana` + POST `/v1/draw/result`。响应扁平 JSON，无 `code/data` 包装。base URL 复用 `https://grsai.dakka.com.cn`（DEFAULT_BASE_URL）。

**模型路由**（`src-tauri/src/ai/providers/grsai/mod.rs`）：`is_gpt_image_2_model` 判断走 gpt-image-2 分支，`is_gpt_vip` 判断走像素值查表。`normalize_requested_model` 保留 nano-banana-pro 子变体选择。`list_models()` 列出 `grsai/nano-banana-2`、`grsai/nano-banana-pro`、`grsai/gpt-image-2`、`grsai/gpt-image-2-vip`。`supports_model` 对 `grsai/*` 前缀全开。

**字段差异**（核心）：

| 模型 | model | prompt | images | aspectRatio | imageSize | replyType | aspectRatio 含义 | imageSize 含义 |
|------|-------|--------|--------|-------------|-----------|-----------|------------------|----------------|
| nano-banana-* | ✓ | ✓ | ✓ (base64/url) | ✓ (auto/比率) | ✓ (1K/2K/4K) | ✓ | 比例字符串 | 单独分辨率字段 |
| gpt-image-2 | ✓ | ✓ | ✓ (base64/url) | ✓ (比例或 1K 像素) | ❌ 省略 | ✓ | 直接传比率字符串 | N/A |
| gpt-image-2-vip | ✓ | ✓ | ✓ (base64/url) | ✓ (查表像素值) | ❌ 省略 | ✓ | 查表得 `"2048x1152"` | N/A |

**gpt-image-2-vip aspectRatio 查表**：Rust `resolve_gpt_image_2_vip_dimensions(aspect_ratio, size)` 15 个比例 × 最多 3 个分辨率，1:3/3:1 无 4K（API 不支持）。`resolutions: ["1K", "2K", "4K"]` 通过 `resolveResolutions({aspectRatio})` 动态过滤，1:3/3:1 选 [1K, 2K]，其他选 [1K, 2K, 4K]。前端模型文件 `src/features/canvas/models/image/grsai/gptImage2Vip.ts`。

**图片压缩（强制）**：`encode_reference_for_grsai` 内 `compress_to_max_edge(bytes, 1024)`，Lanczos3 缩放、JPEG q=85 重新编码。1MB+ 的大图必须缩到 1K（1024px 长边）以下才能过 API 校验。失败时降级用原图（记录 warning）。uploads 物理文件本身不会被压缩，只在发送给 API 的那一刻压缩。**新增参考图支持时不要漏掉这个压缩步骤**。

**轮询**：`poll_once` 用 `GET ?id=xxx`，响应解析为扁平 JSON。`status: "running"` → 继续；`"violation"` / `"failed"` → 失败；其他（如 `"expired"` 未知状态）→ 返回 `Err(Provider)`。HTTP 4xx 也返回 `Err`。`get_generate_image_job` 收到 `Err` 时把 DB 状态更新为 `failed` 并把 error 推给前端。**任务过期场景**目前会变成 generic error 提示。

**前端模型定义**：gpt-image-2 标准版 600 积分，gpt-image-2-vip 1300 积分（`createGrsaiPointsPricing`）。每模型一个文件，glob `import.meta.glob<{ imageModel }>` 限制单文件单导出。文件名约定 `gptImage2.ts` + `gptImage2Vip.ts`。`resolveRequest` 返回 `requestModel` = 完整 ID（含 `grsai/` 前缀）。

**新增 Grsai 模型**的标准流程：1) 改 `SUPPORTED_MODELS` 列表 + `list_models` 2) `normalize_requested_model` 加分支 3) 如需查表像素值加 `resolve_xxx_dimensions` 4) 前端 `models/image/grsai/` 新增文件 5) `registry.ts` 自动发现无需改。改完跑 `npx tsc --noEmit && cd src-tauri && cargo check`。**发布前手动测一条路径 + 一条异常路径**（如：默认参数、故意删 API key 报错）。**重新发布版本**走 `npm run release -- patch --notes-file docs/releases/vX.Y.Z.md`。日志写到 `docs/superpowers/specs/` 和 `docs/superpowers/plans/`。

## 16. 异步任务恢复机制（重启后继续轮询）

**问题**：app 关闭过早时 `exportImageNode` 上 `generationJobId` 字段还没写入（`submitGenerateImageJob` 异步返回前就退出），节点卡在 `isGenerating=true` 但 `generationJobId=""`。`Canvas.tsx` 第 447 行的轮询过滤 `data.generationJobId.length > 0` 永远不通过。**用户感觉"一直等待输出"**。

**恢复流程**：Canvas 挂载 effect → 调 `canvasAiGateway.listResumableGenerationJobs()`（新 Tauri 命令 `list_resumable_generation_jobs`）→ 后端查 SQLite `ai_generation_jobs` 表里 `status IN ('running', 'queued') AND resumable=1` 的所有 job → 返回 `{job_id, provider_id, external_task_id, status, created_at}` → 前端扫 `isGenerating=true` 且 `generationJobId` 为空的 exportImageNode → 写入 `generationJobId` + `generationProviderId` → 触发原轮询 effect（依赖 `nodes` 变化）→ `get_generate_image_job` 调 `provider.poll_task` → 查 Grsai `GET /v1/api/result?id=xxx` → 填充 `imageUrl` 写回 SQLite → 节点 `isGenerating=false, imageUrl=xxx` → 显示结果。**`grsai/nano-banana-2` 这种 resumable=true 的模型都能恢复**；`ppio/bltcy` 等 `resumable=false` 的不行（app 退出后 `get_generate_image_job` 会标为 `failed "job interrupted by app restart"`）。**新模型要支持恢复**必须 `supports_task_resume()` 返回 `true`。**给节点加新 job 字段时**也必须在 addNode 时一并传完整 data，不能依赖后续 updateNodeData（如果中断会丢）。新生成节点建议 addNode 时直接传一个临时 jobId 占位。

---

如与用户明确要求冲突，以用户要求优先；如与运行时安全冲突，以安全优先。
