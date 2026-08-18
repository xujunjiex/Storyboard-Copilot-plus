import {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  type MouseEvent as ReactMouseEvent,
  type DragEvent as ReactDragEvent,
} from 'react';
import {
  ReactFlow,
  Background,
  MiniMap,
  BackgroundVariant,
  SelectionMode,
  useReactFlow,
  type Connection,
  type EdgeChange,
  type FinalConnectionState,
  type HandleType,
  type NodeChange,
  type OnConnectStartParams,
  type Viewport,
} from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import '@xyflow/react/dist/style.css';

import { useCanvasStore } from '@/stores/canvasStore';
import { useProjectStore } from '@/stores/projectStore';
import { getConfiguredApiKeyCount, useSettingsStore } from '@/stores/settingsStore';
import { canvasAiGateway, canvasEventBus } from '@/features/canvas/application/canvasServices';
import {
  CANVAS_NODE_TYPES,
  type CanvasEdge,
  type CanvasNode,
  type CanvasNodeType,
  DEFAULT_NODE_WIDTH,
} from '@/features/canvas/domain/canvasNodes';
import { prepareNodeImageFromFile } from '@/features/canvas/application/imageData';
import {
  buildGenerationErrorReport,
  CURRENT_RUNTIME_SESSION_ID,
} from '@/features/canvas/application/generationErrorReport';
import { showErrorDialog } from '@/features/canvas/application/errorDialog';
import {
  getConnectMenuNodeTypes,
  nodeHasSourceHandle,
  nodeHasTargetHandle,
} from '@/features/canvas/domain/nodeRegistry';
import { convertAudioToMp3, convertVideoToMp4 } from '@/commands/media';
import { embedStoryboardImageMetadata, autoSaveVideoToProject, autoSaveImageToProject } from '@/commands/image';
import { listModelProviders } from '@/features/canvas/models';
import { nodeTypes } from './nodes';
import { edgeTypes } from './edges';
import { NodeSelectionMenu } from './NodeSelectionMenu';
import { SelectedNodeOverlay } from './ui/SelectedNodeOverlay';
import { CanvasToolbar } from './CanvasToolbar';
import { NodeToolDialog } from './ui/NodeToolDialog';
import { ImageViewerModal } from './ui/ImageViewerModal';
import { MissingApiKeyHint } from '@/features/settings/MissingApiKeyHint';
import { logger } from '@/lib/logger';

const DEFAULT_VIEWPORT: Viewport = { x: 0, y: 0, zoom: 1 };

interface PendingConnectStart {
  nodeId: string;
  handleType: HandleType;
  handleId?: string;
  start?: {
    x: number;
    y: number;
  };
}

interface PreviewConnectionVisual {
  d: string;
  stroke: string;
  strokeWidth: number;
  strokeLinecap: 'butt' | 'round' | 'square';
  left: number;
  top: number;
  width: number;
  height: number;
}

interface ClipboardSnapshot {
  nodes: CanvasNode[];
  edges: CanvasEdge[];
}

interface DuplicateOptions {
  explicitOffset?: { x: number; y: number };
  disableOffsetIteration?: boolean;
  suppressSelect?: boolean;
  suppressPersist?: boolean;
}

interface DuplicateResult {
  firstNodeId: string | null;
  idMap: Map<string, string>;
}

const ALT_DRAG_COPY_Z_INDEX = 2000;
const GENERATION_JOB_POLL_INTERVAL_MS = 1400;

interface GenerationStoryboardMetadata {
  gridRows: number;
  gridCols: number;
  frameNotes: string[];
}

function getNodeSize(node: CanvasNode): { width: number; height: number } {
  const styleWidth = typeof node.style?.width === 'number' ? node.style.width : null;
  const styleHeight = typeof node.style?.height === 'number' ? node.style.height : null;
  return {
    width: node.measured?.width ?? styleWidth ?? DEFAULT_NODE_WIDTH,
    height: node.measured?.height ?? styleHeight ?? 200,
  };
}

function hasRectCollision(
  candidateRect: { x: number; y: number; width: number; height: number },
  nodes: CanvasNode[],
  ignoreNodeIds: Set<string>
): boolean {
  const margin = 18;
  return nodes.some((node) => {
    if (ignoreNodeIds.has(node.id)) {
      return false;
    }
    const size = getNodeSize(node);
    return (
      candidateRect.x < node.position.x + size.width + margin &&
      candidateRect.x + candidateRect.width + margin > node.position.x &&
      candidateRect.y < node.position.y + size.height + margin &&
      candidateRect.y + candidateRect.height + margin > node.position.y
    );
  });
}

function cloneNodeData<T>(value: T): T {
  if (typeof structuredClone === 'function') {
    return structuredClone(value);
  }
  return JSON.parse(JSON.stringify(value)) as T;
}

function isTypingTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  if (!element) {
    return false;
  }
  const tagName = element.tagName.toLowerCase();
  return tagName === 'input' || tagName === 'textarea' || element.isContentEditable;
}

function resolveClipboardImageFile(event: ClipboardEvent): File | null {
  const clipboardItems = event.clipboardData?.items;
  if (!clipboardItems) {
    return null;
  }

  for (const item of Array.from(clipboardItems)) {
    if (!item.type.startsWith('image/')) {
      continue;
    }

    const file = item.getAsFile();
    if (!file) {
      continue;
    }

    const existingName = typeof file.name === 'string' ? file.name.trim() : '';
    if (existingName) {
      return file;
    }

    const subtype = item.type.split('/')[1]?.split('+')[0] || 'png';
    return new File([file], `pasted-image.${subtype}`, {
      type: file.type || item.type,
      lastModified: Date.now(),
    });
  }

  return null;
}

function resolveAllowedNodeTypes(handleType: HandleType, sourceType?: CanvasNodeType): CanvasNodeType[] {
  // videoUpload and audioUpload can only connect to sd2VideoGen
  if (sourceType === CANVAS_NODE_TYPES.videoUpload || sourceType === CANVAS_NODE_TYPES.audioUpload) {
    return [CANVAS_NODE_TYPES.sd2VideoGen];
  }
  // upload can connect to both existing targets AND sd2VideoGen
  if (sourceType === CANVAS_NODE_TYPES.upload) {
    const baseTypes = getConnectMenuNodeTypes(handleType);
    if (!baseTypes.includes(CANVAS_NODE_TYPES.sd2VideoGen)) {
      return [...baseTypes, CANVAS_NODE_TYPES.sd2VideoGen];
    }
    return baseTypes;
  }
  return getConnectMenuNodeTypes(handleType);
}

function canNodeTypeBeManualConnectionSource(type: CanvasNodeType): boolean {
  return (
    type === CANVAS_NODE_TYPES.upload ||
    type === CANVAS_NODE_TYPES.audioUpload ||
    type === CANVAS_NODE_TYPES.videoUpload ||
    type === CANVAS_NODE_TYPES.audioUploadRef ||
    type === CANVAS_NODE_TYPES.videoUploadRef ||
    type === CANVAS_NODE_TYPES.exportImage ||
    type === CANVAS_NODE_TYPES.imageEdit ||
    type === CANVAS_NODE_TYPES.videoFrame ||
    type === CANVAS_NODE_TYPES.videoSingle
  );
}

function canNodeBeManualConnectionSource(nodeId: string | null | undefined, nodes: CanvasNode[]): boolean {
  if (!nodeId) {
    return false;
  }
  const node = nodes.find((item) => item.id === nodeId);
  return node ? canNodeTypeBeManualConnectionSource(node.type) : false;
}

function getClientPosition(event: MouseEvent | TouchEvent): { x: number; y: number } | null {
  if ('clientX' in event && 'clientY' in event) {
    return { x: event.clientX, y: event.clientY };
  }

  const touch = 'changedTouches' in event
    ? event.changedTouches[0] ?? event.touches[0]
    : null;
  if (!touch) {
    return null;
  }

  return { x: touch.clientX, y: touch.clientY };
}

function createPreviewPath(line: PreviewConnectionLine): string {
  const { start, end, handleType } = line;
  const deltaX = end.x - start.x;
  const curveStrength = Math.max(36, Math.min(120, Math.abs(deltaX) * 0.4));
  const handleDirection = handleType === 'source' ? 1 : -1;
  const isReverseDrag = deltaX * handleDirection < 0;
  const effectiveDirection = isReverseDrag ? -handleDirection : handleDirection;
  const startControlX = start.x + effectiveDirection * curveStrength;
  const endControlX = end.x - effectiveDirection * curveStrength;

  return `M ${start.x} ${start.y} C ${startControlX} ${start.y}, ${endControlX} ${end.y}, ${end.x} ${end.y}`;
}

interface PreviewConnectionLine {
  start: { x: number; y: number };
  end: { x: number; y: number };
  handleType: HandleType;
}

export function Canvas() {
  const { t } = useTranslation();
  const reactFlowInstance = useReactFlow();
  const wrapperRef = useRef<HTMLDivElement>(null);
  const suppressNextPaneClickRef = useRef(false);
  const suppressNextEdgeClickRef = useRef(false);

  const [showNodeMenu, setShowNodeMenu] = useState(false);
  const [menuPosition, setMenuPosition] = useState({ x: 0, y: 0 });
  const [flowPosition, setFlowPosition] = useState({ x: 0, y: 0 });
  const [menuAllowedTypes, setMenuAllowedTypes] = useState<CanvasNodeType[] | undefined>(
    undefined
  );
  const [pendingConnectStart, setPendingConnectStart] = useState<PendingConnectStart | null>(
    null
  );
  const [previewConnectionVisual, setPreviewConnectionVisual] =
    useState<PreviewConnectionVisual | null>(null);

  const isRestoringCanvasRef = useRef(true);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const copiedSnapshotRef = useRef<ClipboardSnapshot | null>(null);
  const pasteIterationRef = useRef(0);
  const pasteImageHandledRef = useRef(false);
  const activeGenerationPollNodeIdsRef = useRef(new Set<string>());
  const duplicateNodesRef = useRef<((sourceNodeIds: string[]) => string | null) | null>(null);
  const altDragCopyRef = useRef<{
    sourceNodeIds: string[];
    startPositions: Map<string, { x: number; y: number }>;
    copiedNodeIds: string[];
    sourceToCopyIdMap: Map<string, string>;
  } | null>(null);
  const edgePanGestureRef = useRef<{
    active: boolean;
    pointerId: number;
    startClientX: number;
    startClientY: number;
    startViewportX: number;
    startViewportY: number;
    zoom: number;
    moved: boolean;
  } | null>(null);

  const nodes = useCanvasStore((state) => state.nodes);
  const edges = useCanvasStore((state) => state.edges);
  const history = useCanvasStore((state) => state.history);
  const dragHistorySnapshot = useCanvasStore((state) => state.dragHistorySnapshot);
  const applyNodesChange = useCanvasStore((state) => state.onNodesChange);
  const applyEdgesChange = useCanvasStore((state) => state.onEdgesChange);
  const connectNodes = useCanvasStore((state) => state.onConnect);
  const setCanvasData = useCanvasStore((state) => state.setCanvasData);
  const updateNodeData = useCanvasStore((state) => state.updateNodeData);
  const addNode = useCanvasStore((state) => state.addNode);
  const setSelectedNode = useCanvasStore((state) => state.setSelectedNode);
  const selectedNodeId = useCanvasStore((state) => state.selectedNodeId);
  const deleteEdge = useCanvasStore((state) => state.deleteEdge);
  const deleteNode = useCanvasStore((state) => state.deleteNode);
  const deleteNodes = useCanvasStore((state) => state.deleteNodes);
  const groupNodes = useCanvasStore((state) => state.groupNodes);
  const undo = useCanvasStore((state) => state.undo);
  const redo = useCanvasStore((state) => state.redo);
  const openToolDialog = useCanvasStore((state) => state.openToolDialog);
  const closeToolDialog = useCanvasStore((state) => state.closeToolDialog);
  const setViewportState = useCanvasStore((state) => state.setViewportState);
  const setCanvasViewportSize = useCanvasStore((state) => state.setCanvasViewportSize);
  const imageViewer = useCanvasStore((state) => state.imageViewer);
  const closeImageViewer = useCanvasStore((state) => state.closeImageViewer);
  const navigateImageViewer = useCanvasStore((state) => state.navigateImageViewer);
  const apiKeys = useSettingsStore((state) => state.apiKeys);
  const useUploadFilenameAsNodeTitle = useSettingsStore((state) => state.useUploadFilenameAsNodeTitle);
  const videoApis = useSettingsStore((state) => state.videoApis);
  const snapToGridEnabled = useSettingsStore((state) => state.snapToGridEnabled);
  const snapGridSize = useSettingsStore((state) => state.snapGridSize);
  const providerIds = useMemo(() => listModelProviders().map((provider) => provider.id), []);
  const configuredApiKeyCount = useSettingsStore((state) =>
    getConfiguredApiKeyCount(state.apiKeys, providerIds)
  );

  const getCurrentProject = useProjectStore((state) => state.getCurrentProject);
  const saveCurrentProject = useProjectStore((state) => state.saveCurrentProject);
  const saveCurrentProjectViewport = useProjectStore((state) => state.saveCurrentProjectViewport);
  const cancelPendingViewportPersist = useProjectStore(
    (state) => state.cancelPendingViewportPersist
  );

  const persistCanvasSnapshot = useCallback(() => {
    if (isRestoringCanvasRef.current) {
      return;
    }

    const currentProject = getCurrentProject();
    if (!currentProject) {
      return;
    }

    const currentNodes = useCanvasStore.getState().nodes;
    const currentEdges = useCanvasStore.getState().edges;
    const currentHistory = useCanvasStore.getState().history;
    saveCurrentProject(
      currentNodes,
      currentEdges,
      reactFlowInstance.getViewport(),
      currentHistory
    );
  }, [getCurrentProject, reactFlowInstance, saveCurrentProject]);

  const scheduleCanvasPersist = useCallback(
    (delayMs = 140) => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }

      saveTimerRef.current = setTimeout(() => {
        saveTimerRef.current = null;
        persistCanvasSnapshot();
      }, delayMs);
    },
    [persistCanvasSnapshot]
  );

  useEffect(() => {
    const unsubscribeOpen = canvasEventBus.subscribe('tool-dialog/open', (payload) => {
      openToolDialog(payload);
    });
    const unsubscribeClose = canvasEventBus.subscribe('tool-dialog/close', () => {
      closeToolDialog();
    });

    return () => {
      unsubscribeOpen();
      unsubscribeClose();
    };
  }, [openToolDialog, closeToolDialog]);

  useEffect(() => {
    isRestoringCanvasRef.current = true;
    const project = getCurrentProject();
    if (project) {
      setCanvasData(project.nodes, project.edges, project.history);
      setViewportState(project.viewport ?? DEFAULT_VIEWPORT);
      requestAnimationFrame(() => {
        reactFlowInstance.setViewport(project.viewport ?? DEFAULT_VIEWPORT, { duration: 0 });
      });
    } else {
      setViewportState(DEFAULT_VIEWPORT);
    }
    const restoreTimer = setTimeout(() => {
      isRestoringCanvasRef.current = false;
    }, 0);

    return () => {
      clearTimeout(restoreTimer);
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
        saveTimerRef.current = null;
      }
      closeImageViewer();
      persistCanvasSnapshot();
    };
  }, [
    closeImageViewer,
    getCurrentProject,
    persistCanvasSnapshot,
    reactFlowInstance,
    setCanvasData,
    setViewportState,
  ]);

  useEffect(() => {
    if (isRestoringCanvasRef.current || dragHistorySnapshot) {
      return;
    }

    scheduleCanvasPersist();
  }, [nodes, edges, history, dragHistorySnapshot, scheduleCanvasPersist]);

  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingExportNodes = nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportImage) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingExportNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          const projectId = getCurrentProject()?.id;
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            if (generationProviderId) {
              const providerApiKey = apiKeys[generationProviderId] ?? '';
              if (providerApiKey) {
                await canvasAiGateway.setApiKey(generationProviderId, providerApiKey).catch((error) => {
                  logger.warn('[GenerationJob] set_api_key failed before poll', {
                    nodeId: pendingNode.id,
                    generationProviderId,
                    error,
                  });
                });
              }
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              logger.warn('[GenerationJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'queued' || status.status === 'running') {
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              let localImagePath = status.result;
              if (projectId) {
                try {
                  localImagePath = await autoSaveImageToProject(status.result, projectId);
                  logger.info('[GenerationJob] Generated image auto-saved to project directory:', localImagePath);
                } catch (e) {
                  logger.warn('[GenerationJob] Failed to auto-save image to project directory, using URL:', e);
                }
              }
              const storyboardMetadataRaw = currentData.generationStoryboardMetadata as GenerationStoryboardMetadata | undefined;
              const hasStoryboardMetadata = Boolean(
                storyboardMetadataRaw
                && Number.isFinite(storyboardMetadataRaw.gridRows)
                && Number.isFinite(storyboardMetadataRaw.gridCols)
                && Array.isArray(storyboardMetadataRaw.frameNotes)
              );
              let imageWithMetadata = localImagePath;
              if (hasStoryboardMetadata && storyboardMetadataRaw) {
                imageWithMetadata = await embedStoryboardImageMetadata(localImagePath, {
                  gridRows: Math.max(1, Math.round(storyboardMetadataRaw.gridRows)),
                  gridCols: Math.max(1, Math.round(storyboardMetadataRaw.gridCols)),
                  frameNotes: storyboardMetadataRaw.frameNotes,
                }, projectId).catch((error) => {
                  logger.warn('[GenerationJob] embed storyboard metadata failed', {
                    nodeId: pendingNode.id,
                    error,
                  });
                  return localImagePath;
                });
              }

              updateNodeData(pendingNode.id, {
                imageUrl: imageWithMetadata,
                previewImageUrl: imageWithMetadata,
                aspectRatio: '',
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationClientSessionId: null,
                generationStoryboardMetadata: undefined,
                generationError: null,
                generationErrorDetails: null,
                generationDebugContext: undefined,
              });
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'generation job not found' : 'generation failed');
            const generationClientSessionId = typeof currentData.generationClientSessionId === 'string'
              ? currentData.generationClientSessionId
              : '';
            const shouldShowDialog = generationClientSessionId === CURRENT_RUNTIME_SESSION_ID;
            if (shouldShowDialog) {
              const reportText = buildGenerationErrorReport({
                errorMessage,
                errorDetails: status.error ?? undefined,
                context: currentData.generationDebugContext,
              });
              void showErrorDialog(errorMessage, t('common.error'), status.error ?? undefined, reportText);
            }
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationClientSessionId: null,
              generationStoryboardMetadata: undefined,
              generationError: errorMessage,
              generationErrorDetails: status.error ?? null,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [apiKeys, nodes, updateNodeData]);

  // Polling for export video nodes
  useEffect(() => {
    const sleep = (delayMs: number) =>
      new Promise<void>((resolve) => {
        window.setTimeout(resolve, delayMs);
      });

    const pendingVideoNodes = nodes.filter((node) => {
      if (node.type !== CANVAS_NODE_TYPES.exportVideo) {
        return false;
      }
      const data = node.data as Record<string, unknown>;
      return data.isGenerating === true && typeof data.generationJobId === 'string' && data.generationJobId.length > 0;
    });

    for (const pendingNode of pendingVideoNodes) {
      if (activeGenerationPollNodeIdsRef.current.has(pendingNode.id)) {
        continue;
      }
      activeGenerationPollNodeIdsRef.current.add(pendingNode.id);

      void (async () => {
        try {
          let pollFailureCount = 0;
          const MAX_POLL_FAILURES = 5;
          while (true) {
            const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
            if (!currentNode) {
              break;
            }

            const currentData = currentNode.data as Record<string, unknown>;
            const jobId = typeof currentData.generationJobId === 'string' ? currentData.generationJobId : '';
            const isGenerating = currentData.isGenerating === true;
            if (!jobId || !isGenerating) {
              break;
            }

            const generationProviderId = typeof currentData.generationProviderId === 'string'
              ? currentData.generationProviderId
              : '';
            if (generationProviderId) {
              // For video APIs, key is in videoApis; for others use apiKeys
              let providerApiKey = apiKeys[generationProviderId] ?? '';
              if (!providerApiKey && generationProviderId === 'volcvideo') {
                // Video API key is stored in videoApis array
                const configuredVideoApi = videoApis.find(
                  (api: { apiKey?: string }) => api.apiKey && api.apiKey.length > 0
                );
                providerApiKey = configuredVideoApi?.apiKey ?? '';
              }
              if (providerApiKey) {
                await canvasAiGateway.setApiKey(generationProviderId, providerApiKey).catch((error) => {
                  logger.warn('[VideoJob] set_api_key failed before poll', {
                    nodeId: pendingNode.id,
                    generationProviderId,
                    error,
                  });
                });
              }
            }

            const status = await canvasAiGateway.getGenerateImageJob(jobId).catch((error) => {
              logger.warn('[VideoJob] poll failed', { nodeId: pendingNode.id, jobId, error });
              return null;
            });
            if (!status) {
              pollFailureCount++;
              if (pollFailureCount >= MAX_POLL_FAILURES) {
                logger.error('[VideoJob] poll failed repeatedly, showing error on node', {
                  nodeId: pendingNode.id,
                  jobId,
                  failures: pollFailureCount,
                });
                updateNodeData(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationJobId: null,
                  generationProviderId: null,
                  generationError: '网络请求失败，请检查网络连接后重试',
                });
                break;
              }
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            pollFailureCount = 0;

            if (status.status === 'queued' || status.status === 'running') {
              // Check if there's an error message even when status is running
              if (status.error) {
                logger.warn('[VideoJob] poll returned error:', { nodeId: pendingNode.id, jobId, error: status.error, status: status.status });
                updateNodeData(pendingNode.id, {
                  isGenerating: false,
                  generationStartedAt: null,
                  generationJobId: null,
                  generationProviderId: null,
                  generationError: status.error,
                });
                break;
              }
              await sleep(GENERATION_JOB_POLL_INTERVAL_MS);
              continue;
            }

            // Handle cancelled status - task was successfully cancelled
            if (status.status === 'cancelled') {
              logger.info('[VideoJob] Task was cancelled:', { nodeId: pendingNode.id, jobId });
              // Keep the error message that was set when cancel was clicked, or use default
              const currentNode = useCanvasStore.getState().nodes.find((node) => node.id === pendingNode.id);
              const existingError = (currentNode?.data as Record<string, unknown>)?.generationError as string | undefined;
              updateNodeData(pendingNode.id, {
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationError: existingError || '已取消生成',
              });
              break;
            }

            if (status.status === 'succeeded' && typeof status.result === 'string' && status.result.trim()) {
              // Auto-save video to project directory if project context is available
              const currentProject = getCurrentProject();
              const projectId = currentProject?.id;
              let localVideoPath = status.result;
              if (projectId) {
                try {
                  localVideoPath = await autoSaveVideoToProject(status.result, projectId);
                  logger.info('[VideoJob] Video auto-saved to project directory:', localVideoPath);
                } catch (e) {
                  logger.warn('[VideoJob] Failed to auto-save video to project directory, using URL:', e);
                }
              }
              // If seed is returned from API, use it to update the node
              const isDraft = currentData.draft === true;
              const updateData: Record<string, unknown> = {
                videoUrl: localVideoPath,
                isGenerating: false,
                generationStartedAt: null,
                generationJobId: null,
                generationProviderId: null,
                generationError: null,
              };
              // If this was a draft video, preserve the external task ID (not internal jobId) for generating final video
              if (isDraft && status.external_task_id) {
                updateData.draftTaskId = status.external_task_id;
                logger.info('[VideoJob] Draft video completed, preserving externalTaskId:', status.external_task_id);
              }
              // If API returned a seed value, use it; otherwise keep existing seed
              if (status.seed !== undefined && status.seed !== null) {
                updateData.seed = status.seed;
                logger.info('[VideoJob] Received seed from API:', status.seed);
              }
              updateNodeData(pendingNode.id, updateData);
              break;
            }

            const errorMessage = status.error ?? (status.status === 'not_found' ? 'video generation job not found' : 'video generation failed');
            updateNodeData(pendingNode.id, {
              isGenerating: false,
              generationStartedAt: null,
              generationJobId: null,
              generationProviderId: null,
              generationError: errorMessage,
            });
            break;
          }
        } finally {
          activeGenerationPollNodeIdsRef.current.delete(pendingNode.id);
        }
      })();
    }
  }, [apiKeys, videoApis, nodes, updateNodeData]);

  // 恢复机制：从后端 SQLite 拉取所有未完成的 resumable jobs
  // 用于修复节点 data 中丢失 generationJobId 的情况（app 关闭过早）
  useEffect(() => {
    if (isRestoringCanvasRef.current) return;
    let cancelled = false;
    void (async () => {
      try {
        const jobs = await canvasAiGateway.listResumableGenerationJobs();
        if (cancelled || !Array.isArray(jobs) || jobs.length === 0) return;
        const allNodes = useCanvasStore.getState().nodes;
        for (const job of jobs) {
          if (cancelled) break;
          if (!job.external_task_id) continue;
          // 找到 isGenerating=true 且没有 generationJobId 的 exportImageNode
          const target = allNodes.find((n) => {
            if (n.type !== CANVAS_NODE_TYPES.exportImage) return false;
            const d = n.data as Record<string, unknown>;
            return d.isGenerating === true &&
              (typeof d.generationJobId !== 'string' || (d.generationJobId as string).length === 0);
          });
          if (target) {
            logger.info('[GenerationJob] restoring missing generationJobId from DB', {
              nodeId: target.id, jobId: job.job_id, provider: job.provider_id,
            });
            updateNodeData(target.id, {
              generationJobId: job.job_id,
              generationProviderId: job.provider_id,
            });
          }
        }
      } catch (err) {
        logger.warn('[GenerationJob] listResumableGenerationJobs failed', { error: err });
      }
    })();
    return () => { cancelled = true; };
  }, [updateNodeData]);

  useEffect(() => {
    const element = wrapperRef.current;
    if (!element) {
      return;
    }

    const updateSize = () => {
      const rect = element.getBoundingClientRect();
      setCanvasViewportSize({
        width: Math.max(0, Math.round(rect.width)),
        height: Math.max(0, Math.round(rect.height)),
      });
    };

    updateSize();
    const observer = new ResizeObserver(updateSize);
    observer.observe(element);

    return () => {
      observer.disconnect();
    };
  }, [setCanvasViewportSize]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<CanvasNode>[]) => {
      applyNodesChange(changes);

      const hasDragMove = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          Boolean(change.dragging)
      );
      const hasDragEnd = changes.some(
        (change) =>
          change.type === 'position' &&
          'dragging' in change &&
          change.dragging === false
      );
      const hasResizeMove = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          Boolean(change.resizing)
      );
      const hasResizeEnd = changes.some(
        (change) =>
          change.type === 'dimensions' &&
          'resizing' in change &&
          change.resizing === false
      );
      const hasInteractionMove = hasDragMove || hasResizeMove;
      const hasInteractionEnd = hasDragEnd || hasResizeEnd;

      if (hasInteractionMove) {
        return;
      }

      if (hasInteractionEnd) {
        scheduleCanvasPersist(0);
        return;
      }

      scheduleCanvasPersist();
    },
    [applyNodesChange, scheduleCanvasPersist]
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<CanvasEdge>[]) => {
      applyEdgesChange(changes);
      scheduleCanvasPersist();
    },
    [applyEdgesChange, scheduleCanvasPersist]
  );

  const handleEdgeDoubleClick = useCallback(
    (event: ReactMouseEvent, edge: CanvasEdge) => {
      event.preventDefault();
      event.stopPropagation();
      deleteEdge(edge.id);
      scheduleCanvasPersist(0);
    },
    [deleteEdge, scheduleCanvasPersist]
  );

  const handleEdgeClick = useCallback((event: ReactMouseEvent) => {
    if (!suppressNextEdgeClickRef.current) {
      return;
    }
    suppressNextEdgeClickRef.current = false;
    event.preventDefault();
    event.stopPropagation();
  }, []);

  // 验证连接是否有效
  // 验证连接是否有效
  const isValidConnection = useCallback(
    (connection: Connection | { source?: string; target?: string; sourceHandle?: string | null; targetHandle?: string | null }) => {
      const sourceId = connection.source;
      const targetId = connection.target;

      if (!sourceId || !targetId) {
        return false;
      }

      if (!canNodeBeManualConnectionSource(sourceId, nodes)) {
        return false;
      }

      const sourceNode = nodes.find((n) => n.id === sourceId);
      const targetNode = nodes.find((n) => n.id === targetId);
      if (!sourceNode || !targetNode) {
        return false;
      }

      const sourceIsAudioUpload = sourceNode.type === CANVAS_NODE_TYPES.audioUpload
        || sourceNode.type === CANVAS_NODE_TYPES.audioUploadRef;
      const sourceIsVideoUpload = sourceNode.type === CANVAS_NODE_TYPES.videoUpload
        || sourceNode.type === CANVAS_NODE_TYPES.videoUploadRef;

      if (sourceIsAudioUpload || sourceIsVideoUpload) {
        if (targetNode.type !== CANVAS_NODE_TYPES.sd2VideoGen) {
          return false;
        }
      }

      if (targetNode.type === CANVAS_NODE_TYPES.sd2VideoGen) {
        const mode = ((targetNode.data as { generationMode?: string }).generationMode ?? 'multimodal') as
          'multimodal' | 'edit' | 'extend' | 'websearch';
        const targetHandle = connection.targetHandle ?? 'target-images';
        const limits: Record<'multimodal' | 'edit' | 'extend' | 'websearch', { images: number; audios: number; videos: number }> = {
          multimodal: { images: 9, audios: 3, videos: 3 },
          edit: { images: 9, audios: 0, videos: 1 },
          extend: { images: 0, audios: 0, videos: 3 },
          websearch: { images: 0, audios: 0, videos: 0 },
        };
        const modeLimit = limits[mode];

        if (sourceNode.type === CANVAS_NODE_TYPES.upload) {
          if (targetHandle !== 'target-images' || modeLimit.images <= 0) {
            return false;
          }
          const count = edges.filter((edge) =>
            edge.target === targetId
            && (edge.targetHandle ?? 'target-images') === 'target-images'
          ).length;
          return count < modeLimit.images;
        }

        if (sourceIsAudioUpload) {
          if (targetHandle !== 'target-audios' || modeLimit.audios <= 0) {
            return false;
          }
          const count = edges.filter((edge) =>
            edge.target === targetId
            && (edge.targetHandle ?? '') === 'target-audios'
          ).length;
          return count < modeLimit.audios;
        }

        if (sourceIsVideoUpload) {
          if (targetHandle !== 'target-videos' || modeLimit.videos <= 0) {
            return false;
          }
          const count = edges.filter((edge) =>
            edge.target === targetId
            && (edge.targetHandle ?? '') === 'target-videos'
          ).length;
          return count < modeLimit.videos;
        }

        return false;
      }

      if (targetNode.type === CANVAS_NODE_TYPES.videoFrame) {
        const targetHandle = connection.targetHandle;
        if (targetHandle !== 'target-first' && targetHandle !== 'target-last') {
          return false;
        }
      }

      return true;
    },
    [edges, nodes]
  );

  const handleConnect = useCallback(
    (connection: Connection) => {
      // 先验证连接
      if (!isValidConnection(connection)) {
        return;
      }

      connectNodes(connection);
      scheduleCanvasPersist(0);
    },
    [connectNodes, isValidConnection, scheduleCanvasPersist]
  );

  const handleMoveEnd = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    },
    [getCurrentProject, saveCurrentProjectViewport, setViewportState]
  );

  const handleMove = useCallback(
    (_event: unknown, viewport: Viewport) => {
      setViewportState(viewport);
    },
    [setViewportState]
  );

  const handleMoveStart = useCallback(() => {
    cancelPendingViewportPersist();
  }, [cancelPendingViewportPersist]);

  useEffect(() => {
    const wrapperElement = wrapperRef.current;
    if (!wrapperElement) {
      return;
    }

    const edgePathSelector = '.react-flow__edge-path, .react-flow__edge-interaction';
    const dragThreshold = 4;

    const handlePointerDown = (event: PointerEvent) => {
      if (event.button !== 0) {
        return;
      }

      const target = event.target as HTMLElement | null;
      if (!target) {
        return;
      }

      if (target.closest('.react-flow__edgeupdater')) {
        return;
      }

      const edgePathElement = target.closest(edgePathSelector);
      if (!edgePathElement) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      edgePanGestureRef.current = {
        active: true,
        pointerId: event.pointerId,
        startClientX: event.clientX,
        startClientY: event.clientY,
        startViewportX: viewport.x,
        startViewportY: viewport.y,
        zoom: viewport.zoom,
        moved: false,
      };
      cancelPendingViewportPersist();
    };

    const handlePointerMove = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || !gesture.active || event.pointerId !== gesture.pointerId) {
        return;
      }

      const deltaX = event.clientX - gesture.startClientX;
      const deltaY = event.clientY - gesture.startClientY;

      if (!gesture.moved && Math.hypot(deltaX, deltaY) >= dragThreshold) {
        gesture.moved = true;
      }
      if (!gesture.moved) {
        return;
      }

      suppressNextEdgeClickRef.current = true;
      reactFlowInstance.setViewport(
        {
          x: gesture.startViewportX + deltaX,
          y: gesture.startViewportY + deltaY,
          zoom: gesture.zoom,
        },
        { duration: 0 }
      );
    };

    const completeEdgePanGesture = () => {
      const gesture = edgePanGestureRef.current;
      if (!gesture) {
        return;
      }

      edgePanGestureRef.current = null;
      if (!gesture.moved) {
        return;
      }

      const viewport = reactFlowInstance.getViewport();
      setViewportState(viewport);
      const project = getCurrentProject();
      if (!project || isRestoringCanvasRef.current) {
        return;
      }
      saveCurrentProjectViewport(viewport);
    };

    const handlePointerUp = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    const handlePointerCancel = (event: PointerEvent) => {
      const gesture = edgePanGestureRef.current;
      if (!gesture || event.pointerId !== gesture.pointerId) {
        return;
      }
      completeEdgePanGesture();
    };

    wrapperElement.addEventListener('pointerdown', handlePointerDown, true);
    window.addEventListener('pointermove', handlePointerMove, true);
    window.addEventListener('pointerup', handlePointerUp, true);
    window.addEventListener('pointercancel', handlePointerCancel, true);

    return () => {
      wrapperElement.removeEventListener('pointerdown', handlePointerDown, true);
      window.removeEventListener('pointermove', handlePointerMove, true);
      window.removeEventListener('pointerup', handlePointerUp, true);
      window.removeEventListener('pointercancel', handlePointerCancel, true);
    };
  }, [
    cancelPendingViewportPersist,
    getCurrentProject,
    reactFlowInstance,
    saveCurrentProjectViewport,
    setViewportState,
  ]);

  const selectedNodeIds = useMemo(
    () => nodes.filter((node) => Boolean(node.selected)).map((node) => node.id),
    [nodes]
  );
  const selectedUploadNodeId = useMemo(() => {
    if (selectedNodeIds.length !== 1) {
      return null;
    }
    const selectedNode = nodes.find((node) => node.id === selectedNodeIds[0]);
    if (!selectedNode || selectedNode.type !== CANVAS_NODE_TYPES.upload) {
      return null;
    }
    return selectedNode.id;
  }, [nodes, selectedNodeIds]);

  useEffect(() => {
    if (selectedNodeIds.length === 1) {
      if (selectedNodeId !== selectedNodeIds[0]) {
        setSelectedNode(selectedNodeIds[0]);
      }
      return;
    }

    if (selectedNodeId !== null) {
      setSelectedNode(null);
    }
  }, [selectedNodeId, selectedNodeIds, setSelectedNode]);

  useEffect(() => {
    const handlePaste = (event: ClipboardEvent) => {
      pasteImageHandledRef.current = false;
      if (!selectedUploadNodeId || isTypingTarget(event.target)) {
        return;
      }

      const imageFile = resolveClipboardImageFile(event);
      if (!imageFile) {
        return;
      }

      event.preventDefault();
      pasteImageHandledRef.current = true;
      canvasEventBus.publish('upload-node/paste-image', {
        nodeId: selectedUploadNodeId,
        file: imageFile,
      });
    };

    document.addEventListener('paste', handlePaste);
    return () => {
      document.removeEventListener('paste', handlePaste);
    };
  }, [selectedUploadNodeId]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (isTypingTarget(event.target)) {
        return;
      }

      const commandPressed = event.ctrlKey || event.metaKey;
      const key = event.key.toLowerCase();
      const isUndo = commandPressed && key === 'z' && !event.shiftKey;
      const isRedo = commandPressed && (key === 'y' || (key === 'z' && event.shiftKey));
      const isGroup = commandPressed && key === 'g';
      const isCopy = commandPressed && key === 'c' && !event.shiftKey;
      const isPaste = commandPressed && key === 'v' && !event.shiftKey;

      if (isCopy) {
        if (selectedNodeIds.length === 0) {
          return;
        }
        event.preventDefault();
        const selectedIdSet = new Set(selectedNodeIds);
        copiedSnapshotRef.current = {
          nodes: nodes.filter((node) => selectedIdSet.has(node.id)),
          edges: edges.filter(
            (edge) => selectedIdSet.has(edge.source) && selectedIdSet.has(edge.target)
          ),
        };
        return;
      }

      if (isPaste) {
        if (selectedUploadNodeId) {
          pasteImageHandledRef.current = false;
          window.setTimeout(() => {
            if (pasteImageHandledRef.current) {
              pasteImageHandledRef.current = false;
              return;
            }

            if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
              return;
            }

            void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
          }, 0);
          return;
        }

        if (!copiedSnapshotRef.current || copiedSnapshotRef.current.nodes.length === 0) {
          return;
        }
        event.preventDefault();
        void duplicateNodesRef.current?.(copiedSnapshotRef.current.nodes.map((node) => node.id));
        return;
      }

      if (isUndo || isRedo) {
        event.preventDefault();
        const changed = isUndo ? undo() : redo();
        if (changed) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (isGroup) {
        if (selectedNodeIds.length < 2) {
          return;
        }
        event.preventDefault();
        const createdGroupId = groupNodes(selectedNodeIds);
        if (createdGroupId) {
          scheduleCanvasPersist(0);
        }
        return;
      }

      if (event.key !== 'Delete' && event.key !== 'Backspace') {
        return;
      }

      const idsToDelete = selectedNodeIds.length > 0
        ? selectedNodeIds
        : selectedNodeId
          ? [selectedNodeId]
          : [];
      if (idsToDelete.length === 0) {
        return;
      }

      event.preventDefault();
      if (idsToDelete.length === 1) {
        deleteNode(idsToDelete[0]);
      } else {
        deleteNodes(idsToDelete);
      }
      scheduleCanvasPersist(0);
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [
    edges,
    nodes,
    selectedNodeId,
    selectedNodeIds,
    deleteNode,
    deleteNodes,
    groupNodes,
    undo,
    redo,
    scheduleCanvasPersist,
    selectedUploadNodeId,
  ]);

  const openNodeMenuAtClientPosition = useCallback((clientX: number, clientY: number) => {
    const containerRect = wrapperRef.current?.getBoundingClientRect();
    if (!containerRect) {
      return;
    }

    const flowPos = reactFlowInstance.screenToFlowPosition({
      x: clientX,
      y: clientY,
    });

    setFlowPosition(flowPos);
    setMenuPosition({
      x: clientX - containerRect.left,
      y: clientY - containerRect.top,
    });
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
    setShowNodeMenu(true);
  }, [reactFlowInstance]);

  const handleCanvasDrop = useCallback(
    async (event: ReactDragEvent<HTMLDivElement>) => {
      event.preventDefault();
      event.stopPropagation();

      const fileList = event.dataTransfer?.files;
      if (!fileList || fileList.length === 0) {
        return;
      }

      const imageFiles: File[] = [];
      const audioFiles: File[] = [];
      const videoFiles: File[] = [];
      for (let i = 0; i < fileList.length; i++) {
        const file = fileList[i];
        if (file.type.startsWith('image/')) {
          imageFiles.push(file);
        } else if (file.type.startsWith('audio/')) {
          audioFiles.push(file);
        } else if (file.type.startsWith('video/')) {
          videoFiles.push(file);
        }
      }

      if (imageFiles.length === 0 && audioFiles.length === 0 && videoFiles.length === 0) {
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!containerRect) {
        return;
      }

      const flowPos = reactFlowInstance.screenToFlowPosition({
        x: event.clientX - containerRect.left,
        y: event.clientY - containerRect.top,
      });

      let currentX = flowPos.x;
      const baseY = flowPos.y;

      const projectId = getCurrentProject()?.id;

      for (const file of imageFiles) {
        try {
          const prepared = await prepareNodeImageFromFile(file, 512, projectId);
          const newNodeId = addNode(CANVAS_NODE_TYPES.upload, {
            x: currentX,
            y: baseY,
          }, {
            imageUrl: prepared.imageUrl,
            previewImageUrl: prepared.previewImageUrl ?? null,
            aspectRatio: prepared.aspectRatio,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;

          const newNode = nodes.find((n) => n.id === newNodeId);
          if (newNode) {
            currentX += (newNode.measured?.width ?? DEFAULT_NODE_WIDTH) + 40;
          }
        } catch (error) {
          logger.error('Failed to process dropped image:', error);
        }
      }

      for (const file of audioFiles) {
        try {
          const filePath = (file as File & { path?: string }).path;
          const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
            ? filePath
            : URL.createObjectURL(file);
          const audioUrl = projectId && filePath
            ? await convertAudioToMp3(sourcePath, projectId)
            : sourcePath;
          const newNodeId = addNode(CANVAS_NODE_TYPES.audioUpload, { x: currentX, y: baseY + 170 }, {
            audioUrl,
            sourceFileName: file.name,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;
          currentX += 240;
        } catch (error) {
          logger.error('Failed to process dropped audio:', error);
        }
      }

      for (const file of videoFiles) {
        try {
          const filePath = (file as File & { path?: string }).path;
          const sourcePath = typeof filePath === 'string' && filePath.trim().length > 0
            ? filePath
            : URL.createObjectURL(file);
          const videoUrl = projectId && filePath
            ? await convertVideoToMp4(sourcePath, projectId)
            : sourcePath;
          const newNodeId = addNode(CANVAS_NODE_TYPES.videoUpload, { x: currentX, y: baseY + 330 }, {
            videoUrl,
            sourceFileName: file.name,
            ...(useUploadFilenameAsNodeTitle ? { displayName: file.name } : {}),
          });
          void newNodeId;
          currentX += 260;
        } catch (error) {
          logger.error('Failed to process dropped video:', error);
        }
      }
    },
    [addNode, getCurrentProject, nodes, reactFlowInstance, useUploadFilenameAsNodeTitle]
  );

  const handleCanvasDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    event.preventDefault();
    event.stopPropagation();
  }, []);

  const handlePaneClick = useCallback((event: ReactMouseEvent) => {
    if (suppressNextPaneClickRef.current) {
      suppressNextPaneClickRef.current = false;
      return;
    }

    if (event.detail >= 2) {
      openNodeMenuAtClientPosition(event.clientX, event.clientY);
      return;
    }

    setSelectedNode(null);
    setShowNodeMenu(false);
    setMenuAllowedTypes(undefined);
    setPendingConnectStart(null);
    setPreviewConnectionVisual(null);
  }, [openNodeMenuAtClientPosition, setSelectedNode]);

  const handleNodeSelect = useCallback(
    (type: CanvasNodeType) => {
      const newNodeId = addNode(type, flowPosition);
      if (pendingConnectStart) {
        // Determine the correct target handle based on source node type and target node type
        let targetHandleId = 'target';
        if (type === CANVAS_NODE_TYPES.sd2VideoGen) {
          // sd2VideoGen has multiple target handles: target-images, target-audios, target-videos
          const sourceNode = nodes.find((n) => n.id === pendingConnectStart.nodeId);
          if (sourceNode?.type === CANVAS_NODE_TYPES.videoUpload || sourceNode?.type === CANVAS_NODE_TYPES.videoUploadRef) {
            targetHandleId = 'target-videos';
          } else if (sourceNode?.type === CANVAS_NODE_TYPES.audioUpload || sourceNode?.type === CANVAS_NODE_TYPES.audioUploadRef) {
            targetHandleId = 'target-audios';
          } else {
            targetHandleId = 'target-images';
          }
        } else if (type === CANVAS_NODE_TYPES.videoFrame) {
          targetHandleId = 'target-first';
        }

        if (pendingConnectStart.handleType === 'source') {
          connectNodes({
            source: pendingConnectStart.nodeId,
            target: newNodeId,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
          });
        } else {
          connectNodes({
            source: newNodeId,
            target: pendingConnectStart.nodeId,
            sourceHandle: 'source',
            targetHandle: pendingConnectStart.handleId || targetHandleId,
          });
        }
      }

      scheduleCanvasPersist(0);
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPendingConnectStart(null);
      setPreviewConnectionVisual(null);
    },
    [
      addNode,
      connectNodes,
      flowPosition,
      pendingConnectStart,
      scheduleCanvasPersist,
      setPreviewConnectionVisual,
    ]
  );

  const duplicateNodes = useCallback(
    (sourceNodeIds: string[], options: DuplicateOptions = {}) => {
      const dedupedIds = Array.from(new Set(sourceNodeIds));
      if (dedupedIds.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceNodes = nodes.filter((node) => dedupedIds.includes(node.id));
      if (sourceNodes.length === 0) {
        return null as DuplicateResult | null;
      }

      const sourceIdSet = new Set(sourceNodes.map((node) => node.id));
      const internalEdges = edges.filter(
        (edge) => sourceIdSet.has(edge.source) && sourceIdSet.has(edge.target)
      );

      const baseOffsets = [
        { x: 44, y: 30 },
        { x: 72, y: 8 },
        { x: 18, y: 68 },
        { x: 96, y: 42 },
      ];
      const existingNodes = useCanvasStore.getState().nodes;
      const ignoreNodeIds = new Set<string>();
      const offsetStep = options.disableOffsetIteration ? 0 : pasteIterationRef.current;
      let chosenOffset = options.explicitOffset ?? baseOffsets[0];

      const isOffsetAvailable = (offset: { x: number; y: number }) => sourceNodes.every((node) => {
        const size = getNodeSize(node);
        return !hasRectCollision(
          {
            x: node.position.x + offset.x + offsetStep * 8,
            y: node.position.y + offset.y + offsetStep * 6,
            width: size.width,
            height: size.height,
          },
          existingNodes,
          ignoreNodeIds
        );
      });

      if (!options.explicitOffset) {
        const matchedBaseOffset = baseOffsets.find((offset) => isOffsetAvailable(offset));
        if (matchedBaseOffset) {
          chosenOffset = matchedBaseOffset;
        } else {
          const maxStep = 16;
          for (let step = 1; step <= maxStep; step += 1) {
            const candidate = { x: 24 + step * 26, y: 16 + step * 18 };
            if (isOffsetAvailable(candidate)) {
              chosenOffset = candidate;
              break;
            }
          }
        }
      }

      const idMap = new Map<string, string>();
      const sizeMap = new Map<string, { width: number; height: number }>();
      for (const sourceNode of sourceNodes) {
        const data = cloneNodeData(sourceNode.data);
        if ('isGenerating' in (data as Record<string, unknown>)) {
          (data as { isGenerating?: boolean }).isGenerating = false;
        }
        if ('generationStartedAt' in (data as Record<string, unknown>)) {
          (data as { generationStartedAt?: number | null }).generationStartedAt = null;
        }
        if ('generationJobId' in (data as Record<string, unknown>)) {
          (data as { generationJobId?: string | null }).generationJobId = null;
        }
        if ('generationProviderId' in (data as Record<string, unknown>)) {
          (data as { generationProviderId?: string | null }).generationProviderId = null;
        }
        if ('generationClientSessionId' in (data as Record<string, unknown>)) {
          (data as { generationClientSessionId?: string | null }).generationClientSessionId = null;
        }
        if ('generationStoryboardMetadata' in (data as Record<string, unknown>)) {
          (data as { generationStoryboardMetadata?: unknown }).generationStoryboardMetadata = undefined;
        }
        if ('generationError' in (data as Record<string, unknown>)) {
          (data as { generationError?: string | null }).generationError = null;
        }
        if ('generationErrorDetails' in (data as Record<string, unknown>)) {
          (data as { generationErrorDetails?: string | null }).generationErrorDetails = null;
        }
        if ('generationDebugContext' in (data as Record<string, unknown>)) {
          (data as { generationDebugContext?: unknown }).generationDebugContext = undefined;
        }

        const nextNodeId = addNode(
          sourceNode.type as CanvasNodeType,
          {
            x: sourceNode.position.x + chosenOffset.x + offsetStep * 8,
            y: sourceNode.position.y + chosenOffset.y + offsetStep * 6,
          },
          { ...data }
        );
        idMap.set(sourceNode.id, nextNodeId);
        sizeMap.set(nextNodeId, getNodeSize(sourceNode));
      }

      const sizeSyncChanges = Array.from(sizeMap.entries()).map(([nodeId, size]) => ({
        id: nodeId,
        type: 'dimensions' as const,
        dimensions: { width: size.width, height: size.height },
        resizing: false,
        setAttributes: true,
      }));
      if (sizeSyncChanges.length > 0) {
        applyNodesChange(sizeSyncChanges);
      }

      for (const edge of internalEdges) {
        const nextSource = idMap.get(edge.source);
        const nextTarget = idMap.get(edge.target);
        if (!nextSource || !nextTarget) {
          continue;
        }
        connectNodes({
          source: nextSource,
          target: nextTarget,
          sourceHandle: edge.sourceHandle ?? 'source',
          targetHandle: edge.targetHandle ?? 'target',
        });
      }

      if (!options.disableOffsetIteration) {
        pasteIterationRef.current += 1;
      }
      const firstNodeId = idMap.get(sourceNodes[0].id) ?? null;
      if (firstNodeId && !options.suppressSelect) {
        setSelectedNode(firstNodeId);
      }
      if (!options.suppressPersist) {
        scheduleCanvasPersist(0);
      }
      return { firstNodeId, idMap };
    },
    [addNode, applyNodesChange, connectNodes, edges, nodes, scheduleCanvasPersist, setSelectedNode]
  );

  useEffect(() => {
    duplicateNodesRef.current = (sourceNodeIds: string[]) => duplicateNodes(sourceNodeIds)?.firstNodeId ?? null;
  }, [duplicateNodes]);

  const handleConnectStart = useCallback(
    (event: MouseEvent | TouchEvent, params: OnConnectStartParams) => {
      setShowNodeMenu(false);
      setMenuAllowedTypes(undefined);
      setPreviewConnectionVisual(null);

      if (!params.nodeId || !params.handleType) {
        setPendingConnectStart(null);
        return;
      }

      if (
        params.handleType === 'source'
        && !canNodeBeManualConnectionSource(params.nodeId, nodes)
      ) {
        setPendingConnectStart(null);
        return;
      }

      const containerRect = wrapperRef.current?.getBoundingClientRect();
      const eventTarget = event.target as Element | null;
      const handleElement = eventTarget?.closest?.('.react-flow__handle') as HTMLElement | null;
      const clientPosition = getClientPosition(event);
      let start: { x: number; y: number } | undefined;
      if (containerRect && handleElement) {
        const handleRect = handleElement.getBoundingClientRect();
        start = {
          x: handleRect.left - containerRect.left + handleRect.width / 2,
          y: handleRect.top - containerRect.top + handleRect.height / 2,
        };
      } else if (containerRect && clientPosition) {
        start = {
          x: clientPosition.x - containerRect.left,
          y: clientPosition.y - containerRect.top,
        };
      }

      setPendingConnectStart({
        nodeId: params.nodeId,
        handleType: params.handleType,
        handleId: params.handleId ?? undefined,
        start,
      });
    },
    [nodes]
  );

  const handleNodeDragStart = useCallback(
    (event: ReactMouseEvent, node: CanvasNode) => {
      if (!event.altKey) {
        altDragCopyRef.current = null;
        return;
      }

      const sourceNodeIds = selectedNodeIds.includes(node.id)
        ? selectedNodeIds
        : [node.id];
      if (sourceNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }
      const startPositions = new Map<string, { x: number; y: number }>();
      for (const sourceNodeId of sourceNodeIds) {
        const sourceNode = nodes.find((item) => item.id === sourceNodeId);
        if (!sourceNode) {
          continue;
        }
        startPositions.set(sourceNodeId, {
          x: sourceNode.position.x,
          y: sourceNode.position.y,
        });
      }
      if (startPositions.size === 0) {
        altDragCopyRef.current = null;
        return;
      }

      const duplicateResult = duplicateNodes(sourceNodeIds, {
        explicitOffset: { x: 0, y: 0 },
        disableOffsetIteration: true,
        suppressPersist: true,
        suppressSelect: true,
      });
      if (!duplicateResult) {
        altDragCopyRef.current = null;
        return;
      }

      const copiedNodeIds = sourceNodeIds
        .map((sourceId) => duplicateResult.idMap.get(sourceId))
        .filter((id): id is string => Boolean(id));
      if (copiedNodeIds.length === 0) {
        altDragCopyRef.current = null;
        return;
      }

      // Keep the duplicated nodes visually above the original dragged node.
      useCanvasStore.setState((state) => ({
        nodes: state.nodes.map((currentNode) => {
          if (!copiedNodeIds.includes(currentNode.id)) {
            return currentNode;
          }
          return {
            ...currentNode,
            zIndex: ALT_DRAG_COPY_Z_INDEX,
            style: {
              ...(currentNode.style ?? {}),
              zIndex: ALT_DRAG_COPY_Z_INDEX,
            },
          };
        }),
      }));

      altDragCopyRef.current = {
        sourceNodeIds,
        startPositions,
        copiedNodeIds,
        sourceToCopyIdMap: duplicateResult.idMap,
      };
    },
    [duplicateNodes, nodes, selectedNodeIds]
  );

  const handleNodeDrag = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const deltaX = node.position.x - startPosition.x;
      const deltaY = node.position.y - startPosition.y;

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const moveCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + deltaX, y: sourceStart.y + deltaY },
            dragging: true,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: true;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...moveCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
    },
    [applyNodesChange]
  );

  const handleNodeDragStop = useCallback(
    (_event: ReactMouseEvent, node: CanvasNode) => {
      const altCopyState = altDragCopyRef.current;
      if (!altCopyState) {
        return;
      }
      altDragCopyRef.current = null;

      const startPosition = altCopyState.startPositions.get(node.id);
      if (!startPosition) {
        return;
      }

      const offset = {
        x: node.position.x - startPosition.x,
        y: node.position.y - startPosition.y,
      };

      const restoreSourceChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          if (!sourceStart) {
            return null;
          }
          return {
            id: sourceId,
            type: 'position' as const,
            position: sourceStart,
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const finalizeCopyChanges = altCopyState.sourceNodeIds
        .map((sourceId) => {
          const sourceStart = altCopyState.startPositions.get(sourceId);
          const copyId = altCopyState.sourceToCopyIdMap.get(sourceId);
          if (!sourceStart || !copyId) {
            return null;
          }
          return {
            id: copyId,
            type: 'position' as const,
            position: { x: sourceStart.x + offset.x, y: sourceStart.y + offset.y },
            dragging: false,
          };
        })
        .filter((change): change is {
          id: string;
          type: 'position';
          position: { x: number; y: number };
          dragging: false;
        } => Boolean(change));

      const allChanges = [...restoreSourceChanges, ...finalizeCopyChanges];
      if (allChanges.length > 0) {
        applyNodesChange(allChanges);
      }
      if (altCopyState.copiedNodeIds.length > 0) {
        setSelectedNode(altCopyState.copiedNodeIds[0]);
      }
      scheduleCanvasPersist(0);
    },
    [applyNodesChange, scheduleCanvasPersist, setSelectedNode]
  );

  const handleConnectEnd = useCallback(
    (event: MouseEvent | TouchEvent, connectionState: FinalConnectionState) => {
      if (connectionState.isValid || !pendingConnectStart) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const clientPosition = getClientPosition(event);
      const containerRect = wrapperRef.current?.getBoundingClientRect();
      if (!clientPosition || !containerRect) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const eventTarget = event.target as Element | null;
      const nodeElementFromTarget = eventTarget?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const nodeElementFromPoint = document.elementFromPoint(clientPosition.x, clientPosition.y)
        ?.closest?.('.react-flow__node[data-id]') as HTMLElement | null;
      const dropNodeElement = nodeElementFromTarget ?? nodeElementFromPoint;
      const dropNodeId = dropNodeElement?.dataset?.id ?? null;

      // Find the source node type for filtering allowed target types
      const sourceNodeForFilter =
        pendingConnectStart.handleType === 'source'
          ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
          : dropNodeId
            ? nodes.find((node) => node.id === dropNodeId)
            : null;

      if (dropNodeId && dropNodeId !== pendingConnectStart.nodeId) {
        const sourceNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === pendingConnectStart.nodeId)
            : nodes.find((node) => node.id === dropNodeId);
        const targetNode =
          pendingConnectStart.handleType === 'source'
            ? nodes.find((node) => node.id === dropNodeId)
            : nodes.find((node) => node.id === pendingConnectStart.nodeId);

        if (
          sourceNode &&
          targetNode &&
          canNodeTypeBeManualConnectionSource(sourceNode.type) &&
          nodeHasSourceHandle(sourceNode.type) &&
          nodeHasTargetHandle(targetNode.type)
        ) {
          // For videoFrame nodes, use 'target-first' as default targetHandle
          const isTargetVideoFrame = targetNode.type === CANVAS_NODE_TYPES.videoFrame;
          const defaultTargetHandle = isTargetVideoFrame ? 'target-first' : 'target';
          const targetHandleId = pendingConnectStart.handleType === 'target' && pendingConnectStart.handleId
            ? pendingConnectStart.handleId
            : defaultTargetHandle;
          logger.info('[handleConnectEnd] connecting:', {
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
            pendingHandleType: pendingConnectStart.handleType,
            pendingHandleId: pendingConnectStart.handleId,
            isTargetVideoFrame,
          });
          connectNodes({
            source: sourceNode.id,
            target: targetNode.id,
            sourceHandle: 'source',
            targetHandle: targetHandleId,
          });
          scheduleCanvasPersist(0);
          setPendingConnectStart(null);
          setPreviewConnectionVisual(null);
          return;
        }
      }

      const allowedTypes = resolveAllowedNodeTypes(
        pendingConnectStart.handleType,
        sourceNodeForFilter?.type
      );
      if (allowedTypes.length === 0) {
        setPendingConnectStart(null);
        setPreviewConnectionVisual(null);
        return;
      }

      const endX = clientPosition.x - containerRect.left;
      const endY = clientPosition.y - containerRect.top;
      let startX: number | null = pendingConnectStart.start?.x ?? null;
      let startY: number | null = pendingConnectStart.start?.y ?? null;

      if (startX === null || startY === null) {
        const nodeElement = wrapperRef.current?.querySelector<HTMLElement>(
          `.react-flow__node[data-id="${pendingConnectStart.nodeId}"]`
        );
        const handleElement = nodeElement?.querySelector<HTMLElement>(
          `.react-flow__handle-${pendingConnectStart.handleType}`
        );
        if (handleElement) {
          const handleRect = handleElement.getBoundingClientRect();
          startX = handleRect.left - containerRect.left + handleRect.width / 2;
          startY = handleRect.top - containerRect.top + handleRect.height / 2;
        } else if (nodeElement) {
          const nodeRect = nodeElement.getBoundingClientRect();
          startX =
            pendingConnectStart.handleType === 'source'
              ? nodeRect.right - containerRect.left
              : nodeRect.left - containerRect.left;
          startY = nodeRect.top - containerRect.top + nodeRect.height / 2;
        } else if (connectionState.from) {
          startX = connectionState.from.x;
          startY = connectionState.from.y;
        }
      }

      if (startX === null || startY === null) {
        setPreviewConnectionVisual(null);
      } else {
        setPreviewConnectionVisual({
          d: createPreviewPath({
            start: { x: startX, y: startY },
            end: { x: endX, y: endY },
            handleType: pendingConnectStart.handleType,
          }),
          stroke: 'rgba(255,255,255,0.9)',
          strokeWidth: 1,
          strokeLinecap: 'round',
          left: 0,
          top: 0,
          width: containerRect.width,
          height: containerRect.height,
        });
      }

      const flowPos = reactFlowInstance.screenToFlowPosition(clientPosition);
      setFlowPosition(flowPos);
      setMenuPosition({
        x: clientPosition.x - containerRect.left,
        y: clientPosition.y - containerRect.top,
      });
      setMenuAllowedTypes(allowedTypes);
      suppressNextPaneClickRef.current = true;
      setShowNodeMenu(true);
    },
    [connectNodes, nodes, pendingConnectStart, reactFlowInstance, scheduleCanvasPersist]
  );

  const emptyHint = useMemo(
    () => (
      <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
        <div className="flex max-w-3xl flex-col items-center gap-5 px-6 text-center">
          {configuredApiKeyCount === 0 && <MissingApiKeyHint />}
          <div>
            <div className="mb-2 text-2xl text-text-muted">{t('canvas.emptyHintTitle')}</div>
            <div className="text-sm text-text-muted opacity-60">{t('canvas.emptyHintSubtitle')}</div>
          </div>
        </div>
      </div>
    ),
    [configuredApiKeyCount, t]
  );

  return (
    <div
      ref={wrapperRef}
      className="relative h-full w-full"
      onDrop={handleCanvasDrop}
      onDragOver={handleCanvasDragOver}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={handleNodesChange}
        onEdgesChange={handleEdgesChange}
        onEdgeClick={handleEdgeClick}
        onEdgeDoubleClick={handleEdgeDoubleClick}
        onConnect={handleConnect}
        onConnectStart={handleConnectStart}
        onConnectEnd={handleConnectEnd}
        isValidConnection={isValidConnection}
        onNodeDragStart={handleNodeDragStart}
        onNodeDrag={handleNodeDrag}
        onNodeDragStop={handleNodeDragStop}
        onPaneClick={handlePaneClick}
        onMove={handleMove}
        onMoveStart={handleMoveStart}
        onMoveEnd={handleMoveEnd}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        defaultEdgeOptions={{ type: 'disconnectableEdge' }}
        defaultViewport={DEFAULT_VIEWPORT}
        minZoom={0.1}
        maxZoom={5}
        snapGrid={snapToGridEnabled ? [snapGridSize, snapGridSize] : undefined}
        snapToGrid={snapToGridEnabled}
        selectionOnDrag
        selectionMode={SelectionMode.Partial}
        multiSelectionKeyCode={['Control', 'Meta']}
        selectionKeyCode={['Control', 'Meta']}
        deleteKeyCode={null}
        onlyRenderVisibleElements
        zoomOnDoubleClick={false}
        proOptions={{ hideAttribution: true }}
        className="bg-bg-dark"
      >
        <Background
          variant={snapToGridEnabled ? BackgroundVariant.Lines : BackgroundVariant.Dots}
          gap={snapGridSize}
          size={1}
          color={snapToGridEnabled ? "rgba(59, 130, 246, 0.15)" : "#2a2a2a"}
          lineWidth={0.5}
        />
        <MiniMap
          className="canvas-minimap nopan nowheel !border-border-dark !bg-surface-dark"
          style={{ pointerEvents: 'all', zIndex: 10000 }}
          nodeColor="rgba(120, 120, 120, 0.92)"
          maskColor="rgba(0, 0, 0, 0.62)"
          pannable
          zoomable
        />

        <SelectedNodeOverlay />
      </ReactFlow>

      <CanvasToolbar />

      {nodes.length === 0 && emptyHint}
      {nodes.length > 0 && configuredApiKeyCount === 0 && (
        <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center px-6">
          <MissingApiKeyHint />
        </div>
      )}

      {showNodeMenu && previewConnectionVisual && (
        <svg
          className="pointer-events-none absolute z-40 overflow-visible"
          style={{
            left: previewConnectionVisual.left,
            top: previewConnectionVisual.top,
            width: previewConnectionVisual.width,
            height: previewConnectionVisual.height,
          }}
          width={previewConnectionVisual.width}
          height={previewConnectionVisual.height}
        >
          <path
            className="pointer-events-none"
            d={previewConnectionVisual.d}
            fill="none"
            stroke={previewConnectionVisual.stroke}
            strokeWidth={previewConnectionVisual.strokeWidth}
            strokeLinecap={previewConnectionVisual.strokeLinecap}
          />
        </svg>
      )}

      {showNodeMenu && (
        <NodeSelectionMenu
          position={menuPosition}
          allowedTypes={menuAllowedTypes}
          onSelect={handleNodeSelect}
          onClose={() => {
            setShowNodeMenu(false);
            setMenuAllowedTypes(undefined);
            setPendingConnectStart(null);
            setPreviewConnectionVisual(null);
          }}
        />
      )}

      <NodeToolDialog />

      <ImageViewerModal
        open={imageViewer.isOpen}
        imageUrl={imageViewer.currentImageUrl || ''}
        imageList={imageViewer.imageList}
        currentIndex={imageViewer.currentIndex}
        onClose={closeImageViewer}
        onNavigate={navigateImageViewer}
      />
    </div>
  );
}
