import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLogStore } from './store';
import type { Level, LogEntry } from './types';

const ALL_LEVELS: Level[] = ['debug', 'info', 'warn', 'error'];
const LEVEL_COLOR: Record<Level, string> = {
  debug: 'text-gray-400',
  info: 'text-blue-400',
  warn: 'text-yellow-400',
  error: 'text-red-400',
};

const MIN_WIDTH = 320;
const MAX_WIDTH = 1600;
const MIN_HEIGHT = 160;
const MAX_HEIGHT = 900;
const DEFAULT_WIDTH = 480;
const DEFAULT_HEIGHT = 320;

type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export function LogPanel(): JSX.Element | null {
  const { t } = useTranslation();
  const open = useLogStore((s) => s.open);
  const minimized = useLogStore((s) => s.minimized);
  const levelFilter = useLogStore((s) => s.levelFilter);
  const namespaceFilter = useLogStore((s) => s.namespaceFilter);
  const textQuery = useLogStore((s) => s.textQuery);
  const buffer = useLogStore((s) => s.buffer);
  const toggleLevelFilter = useLogStore((s) => s.toggleLevelFilter);
  const setNamespaceFilter = useLogStore((s) => s.setNamespaceFilter);
  const setTextQuery = useLogStore((s) => s.setTextQuery);
  const setMinimized = useLogStore((s) => s.setMinimized);
  const setOpen = useLogStore((s) => s.setOpen);
  const clearBuffer = useLogStore((s) => s.clearBuffer);

  // 尺寸（从 localStorage 恢复，便于跨会话保留）
  const STORAGE_KEY = 'itv.log.panel.size';
  const [size, setSize] = useState<{ w: number; h: number }>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (typeof parsed.w === 'number' && typeof parsed.h === 'number') return parsed;
      }
    } catch {
      // ignore
    }
    return { w: DEFAULT_WIDTH, h: DEFAULT_HEIGHT };
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(size));
    } catch {
      // ignore
    }
  }, [size]);

  // 订阅 ring buffer 变化强制 re-render（zustand 不会 deep watch）
  const [, force] = useState(0);
  useEffect(() => useLogStore.getState().subscribe(() => force((n) => n + 1)), []);

  // 拖拽调整大小
  const dragRef = useRef<{
    edge: ResizeEdge;
    startX: number;
    startY: number;
    startW: number;
    startH: number;
  } | null>(null);

  const handleResizeStart = (edge: ResizeEdge) => (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    dragRef.current = {
      edge,
      startX: e.clientX,
      startY: e.clientY,
      startW: size.w,
      startH: size.h,
    };
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      const dx = e.clientX - drag.startX;
      const dy = e.clientY - drag.startY;
      let nextW = drag.startW;
      let nextH = drag.startH;
      // panel 默认在 right-4 bottom-4，水平方向"右"是固定边
      if (drag.edge.includes('e')) nextW = drag.startW + dx;
      if (drag.edge.includes('w')) nextW = drag.startW - dx;
      if (drag.edge.includes('s')) nextH = drag.startH + dy;
      if (drag.edge.includes('n')) nextH = drag.startH - dy;
      nextW = Math.max(MIN_WIDTH, Math.min(MAX_WIDTH, nextW));
      nextH = Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, nextH));
      setSize({ w: nextW, h: nextH });
    };
    const onUp = () => {
      dragRef.current = null;
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
    return () => {
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
  }, [size.w, size.h]);

  if (!open) return null;

  const allEntries = buffer.entries();
  const namespaces = Array.from(new Set(allEntries.map((e) => e.target))).sort();

  const visible = allEntries.filter((e) => {
    if (!levelFilter.has(e.level)) return false;
    if (namespaceFilter && e.target !== namespaceFilter) return false;
    if (textQuery) {
      const q = textQuery.toLowerCase();
      if (!e.message.toLowerCase().includes(q) &&
          !JSON.stringify(e.fields).toLowerCase().includes(q)) {
        return false;
      }
    }
    return true;
  }).slice().reverse();

  const headerH = 40;
  const displayH = Math.max(MIN_HEIGHT, size.h) - headerH;

  return (
    <div
      data-testid="log-panel"
      className="fixed bottom-4 right-4 z-[9999] bg-zinc-900 text-zinc-100 rounded-lg shadow-2xl flex flex-col"
      style={{
        width: size.w,
        height: minimized ? headerH : size.h,
      }}
    >
      <div className="flex items-center gap-2 px-3 py-2 border-b border-zinc-700 cursor-move select-none" style={{ height: headerH }}>
        <span className="text-sm font-semibold flex-1">{t('logger.panel.title')}</span>
        <span className="text-[10px] text-zinc-500">{size.w}×{size.h}</span>
        <button
          onClick={() => setMinimized(!minimized)}
          className="text-xs px-2 py-1 hover:bg-zinc-800 rounded"
          aria-label={t('logger.panel.minimize')}
        >
          {minimized ? '▢' : '—'}
        </button>
        <button
          onClick={() => setOpen(false)}
          className="text-xs px-2 py-1 hover:bg-zinc-800 rounded"
          aria-label={t('logger.panel.close')}
        >
          ×
        </button>
      </div>

      {!minimized && (
        <>
          <div className="flex items-center gap-1 px-2 py-1 border-b border-zinc-700 text-xs">
            {ALL_LEVELS.map((lv) => (
              <button
                key={lv}
                onClick={() => toggleLevelFilter(lv)}
                className={`px-2 py-0.5 rounded ${
                  levelFilter.has(lv) ? LEVEL_COLOR[lv] + ' bg-zinc-800' : 'text-zinc-600 bg-zinc-900'
                }`}
              >
                {lv}
              </button>
            ))}
            <input
              type="text"
              value={textQuery}
              onChange={(e) => setTextQuery(e.target.value)}
              placeholder={t('logger.panel.search')}
              className="ml-auto px-2 py-0.5 bg-zinc-800 rounded text-xs w-32"
            />
            <button
              onClick={clearBuffer}
              className="px-2 py-0.5 hover:bg-zinc-800 rounded text-xs"
            >
              {t('logger.panel.clear')}
            </button>
          </div>

          <div className="flex flex-wrap gap-1 px-2 py-1 border-b border-zinc-700 text-[10px] max-h-12 overflow-y-auto">
            <button
              onClick={() => setNamespaceFilter(null)}
              className={`px-1.5 py-0.5 rounded ${namespaceFilter === null ? 'bg-zinc-700' : 'hover:bg-zinc-800'}`}
            >
              all
            </button>
            {namespaces.map((ns) => (
              <button
                key={ns}
                onClick={() => setNamespaceFilter(ns)}
                className={`px-1.5 py-0.5 rounded ${namespaceFilter === ns ? 'bg-zinc-700' : 'hover:bg-zinc-800'}`}
              >
                {ns}
              </button>
            ))}
          </div>

          <div
            className="flex-1 overflow-y-auto font-mono text-[11px] leading-tight"
            style={{ height: displayH - 80 }}
          >
            {visible.length === 0 ? (
              <div className="text-zinc-500 text-center py-8">
                {allEntries.length === 0 ? t('logger.panel.empty') : t('logger.panel.noResults')}
              </div>
            ) : (
              visible.map((entry) => <LogLine key={entry.id} entry={entry} />)
            )}
          </div>

          {/* 8 个方向的可拖拽边缘 */}
          <ResizeHandle edge="n" onStart={handleResizeStart} cursor="ns-resize" />
          <ResizeHandle edge="s" onStart={handleResizeStart} cursor="ns-resize" />
          <ResizeHandle edge="e" onStart={handleResizeStart} cursor="ew-resize" />
          <ResizeHandle edge="w" onStart={handleResizeStart} cursor="ew-resize" />
          <ResizeHandle edge="ne" onStart={handleResizeStart} cursor="nesw-resize" />
          <ResizeHandle edge="nw" onStart={handleResizeStart} cursor="nwse-resize" />
          <ResizeHandle edge="se" onStart={handleResizeStart} cursor="nwse-resize" />
          <ResizeHandle edge="sw" onStart={handleResizeStart} cursor="nesw-resize" />
        </>
      )}
    </div>
  );
}

function ResizeHandle({
  edge,
  onStart,
  cursor,
}: {
  edge: ResizeEdge;
  onStart: (e: ResizeEdge) => (ev: React.MouseEvent) => void;
  cursor: string;
}) {
  // 计算位置
  const top = edge.includes('n') ? 0 : edge.includes('s') ? 'auto' : '50%';
  const bottom = edge === 's' || edge === 'se' || edge === 'sw' ? 0 : 'auto';
  const left = edge.includes('w') ? 0 : edge === 'ne' || edge === 'se' ? 'auto' : '50%';
  const right = edge === 'e' || edge === 'ne' || edge === 'se' ? 0 : 'auto';
  // 角点 12x12，边 8x8 透明
  const isCorner = edge.length === 2;
  const style: React.CSSProperties = {
    position: 'absolute',
    top,
    bottom,
    left,
    right,
    width: isCorner ? 12 : 8,
    height: isCorner ? 12 : 8,
    cursor,
    zIndex: 10,
    transform: edge === 'n' || edge === 's' ? 'translateX(-50%)'
      : edge === 'e' || edge === 'w' ? 'translateY(-50%)'
      : undefined,
  };
  return (
    <div
      onMouseDown={onStart(edge)}
      style={style}
      data-resize-handle={edge}
    />
  );
}

function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className="px-2 py-1 border-b border-zinc-800 hover:bg-zinc-800">
      <span className={`font-bold ${LEVEL_COLOR[entry.level]}`}>
        {entry.level.toUpperCase().padEnd(5)}
      </span>
      <span className="text-zinc-500 ml-2">{entry.target}</span>
      <span className="ml-2">{entry.message}</span>
      {Object.keys(entry.fields).length > 0 && (
        <details className="ml-2 mt-1">
          <summary className="text-zinc-500 cursor-pointer">fields</summary>
          <pre className="text-zinc-400 ml-4 whitespace-pre-wrap break-all">
            {JSON.stringify(entry.fields, null, 2)}
          </pre>
        </details>
      )}
    </div>
  );
}
