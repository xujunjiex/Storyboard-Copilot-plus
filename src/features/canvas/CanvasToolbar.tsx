import { memo, useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import {
  ZoomIn,
  ZoomOut,
  Maximize2,
  Grid3X3,
  ScrollText,
} from 'lucide-react';
import { useReactFlow } from '@xyflow/react';

import { useCanvasStore } from '@/stores/canvasStore';
import { useSettingsStore } from '@/stores/settingsStore';
import { openSettingsDialog } from '@/features/settings/settingsEvents';
import { useLogStore } from '@/lib/logger';

interface CanvasToolbarProps {
  isLocked?: boolean;
}

export const CanvasToolbar = memo(({ isLocked = false }: CanvasToolbarProps) => {
  const { t } = useTranslation();
  const { zoomIn, zoomOut, fitView } = useReactFlow();
  const clearCanvas = useCanvasStore((state) => state.clearCanvas);
  const snapToGridEnabled = useSettingsStore((state) => state.snapToGridEnabled);
  const setSnapToGridEnabled = useSettingsStore((state) => state.setSnapToGridEnabled);
  const [showClearConfirm, setShowClearConfirm] = useState(false);

  const handleClearClick = useCallback(() => {
    if (isLocked) return;
    setShowClearConfirm(true);
  }, [isLocked]);

  const handleClearConfirm = useCallback(() => {
    clearCanvas();
    setShowClearConfirm(false);
  }, [clearCanvas]);

  const handleClearCancel = useCallback(() => {
    setShowClearConfirm(false);
  }, []);

  return (
    <>
      <div className="absolute left-1/2 top-4 z-10 flex -translate-x-1/2 items-center gap-2 rounded-lg border border-border-dark bg-surface-dark px-2 py-1.5 shadow-lg">
        <button
          onClick={() => zoomIn()}
          disabled={isLocked}
          className="rounded p-1.5 transition-colors hover:bg-bg-dark disabled:opacity-50"
          title={t('canvas.toolbar.zoomIn')}
        >
          <ZoomIn className="h-4 w-4 text-text-muted" />
        </button>

        <button
          onClick={() => zoomOut()}
          disabled={isLocked}
          className="rounded p-1.5 transition-colors hover:bg-bg-dark disabled:opacity-50"
          title={t('canvas.toolbar.zoomOut')}
        >
          <ZoomOut className="h-4 w-4 text-text-muted" />
        </button>

        <button
          onClick={() => fitView({ padding: 0.2 })}
          className="rounded p-1.5 transition-colors hover:bg-bg-dark"
          title={t('canvas.toolbar.fitView')}
        >
          <Maximize2 className="h-4 w-4 text-text-muted" />
        </button>

        <div className="h-6 w-px bg-border-dark" />

        <button
          onClick={() => setSnapToGridEnabled(!snapToGridEnabled)}
          className={`rounded p-1.5 transition-colors ${snapToGridEnabled ? 'bg-accent/20 text-accent' : 'hover:bg-bg-dark text-text-muted'}`}
          title={t('canvas.toolbar.snapToGrid')}
        >
          <Grid3X3 className="h-4 w-4" />
        </button>

        <button
          onClick={() => openSettingsDialog({ category: 'logging' })}
          className="rounded p-1.5 transition-colors hover:bg-bg-dark text-text-muted"
          title={t('canvas.toolbar.loggerSettings')}
        >
          <ScrollText className="h-4 w-4" />
        </button>

        <button
          onClick={() => useLogStore.getState().toggleOpen()}
          className="rounded p-1.5 transition-colors hover:bg-bg-dark text-text-muted"
          title={t('canvas.toolbar.loggerToggle')}
          data-testid="canvas-toolbar-logger-toggle"
        >
          <svg className="h-4 w-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
            <polyline points="14 2 14 8 20 8" />
            <line x1="16" y1="13" x2="8" y2="13" />
            <line x1="16" y1="17" x2="8" y2="17" />
            <polyline points="10 9 9 9 8 9" />
          </svg>
        </button>

        <button
          onClick={handleClearClick}
          disabled={isLocked}
          className="rounded p-1.5 transition-colors hover:bg-red-500/10 disabled:opacity-50"
          title={t('common.delete')}
        >
          <svg className="h-4 w-4 text-red-500" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
            <polyline points="3 6 5 6 21 6"></polyline>
            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
          </svg>
        </button>
      </div>

      {showClearConfirm && (
        <div
          className="fixed inset-0 z-[100] flex items-center justify-center"
          style={{ backgroundColor: 'rgba(0, 0, 0, 0.5)' }}
          onClick={handleClearCancel}
        >
          <div
            className="rounded-lg border border-border-dark bg-surface-dark p-6 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <h3 className="mb-4 text-lg font-medium text-text-dark">
              {t('canvas.clearConfirm.title', '确认清空画布？')}
            </h3>
            <p className="mb-4 text-sm text-text-muted">
              {t('canvas.clearConfirm.message', '此操作不可撤销，所有节点和连线都将被删除。')}
            </p>
            <div className="flex gap-2">
              <button
                onClick={handleClearCancel}
                className="flex-1 rounded-lg border border-border-dark bg-bg-dark px-4 py-2 text-sm text-text-dark hover:bg-border-dark/50"
              >
                {t('common.cancel', '取消')}
              </button>
              <button
                onClick={handleClearConfirm}
                className="flex-1 rounded-lg bg-red-500 px-4 py-2 text-sm text-white hover:bg-red-600"
              >
                {t('common.confirm', '确认删除')}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
});

CanvasToolbar.displayName = 'CanvasToolbar';
