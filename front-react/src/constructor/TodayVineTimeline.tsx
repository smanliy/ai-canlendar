import { useMemo } from 'react';
import type { CSSProperties } from 'react';

import './TodayVineTimeline.css';
import { useVineGrowProgress } from './useVineGrowProgress';

export type VineEventStatus = 'normal' | 'conflict' | 'approvedConflict' | 'done';

export interface VineEvent {
  id: string;
  title: string;
  startTime: string;
  endTime: string;
  status?: VineEventStatus;
  category?: string;
  priority?: string;
}

interface TodayVineTimelineProps {
  events: VineEvent[];
  maxEvents?: number;
  className?: string;
}

interface VineLeaf {
  cx: number;
  cy: number;
  rotate: number;
}

interface VineRenderItem {
  id: string;
  event: VineEvent;
  index: number;
  side: 'left' | 'right';
  startY: number;
  endY: number;
  path: string;
  labelX: number;
  labelY: number;
  color: string;
  leaves: VineLeaf[];
}

const SVG_WIDTH = 400;
const SVG_HEIGHT = 600;
const STEM_X = 200;
const TOP_Y = 45;
const BOTTOM_Y = 555;

const statusColor: Record<VineEventStatus, string> = {
  normal: '#50994a',
  conflict: '#dc2626',
  approvedConflict: '#eab308',
  done: '#94a3b8'
};

function isValidEvent(event: VineEvent) {
  return Number.isFinite(new Date(event.startTime).getTime()) && Number.isFinite(new Date(event.endTime).getTime());
}

function formatTimeRange(event: VineEvent) {
  const start = new Date(event.startTime);
  const end = new Date(event.endTime);

  if (!isValidEvent(event)) {
    return '';
  }

  const startText = `${String(start.getHours()).padStart(2, '0')}:${String(start.getMinutes()).padStart(2, '0')}`;
  const endText = `${String(end.getHours()).padStart(2, '0')}:${String(end.getMinutes()).padStart(2, '0')}`;

  return `${startText} - ${endText}`;
}

function sortEvents(events: VineEvent[]) {
  return [...events].sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
}

function buildBranchPath(side: 'left' | 'right', startY: number, endY: number) {
  if (side === 'left') {
    return `M ${STEM_X} ${startY} C 145 ${startY + 35}, 130 ${startY + 80}, 120 ${endY}`;
  }

  return `M ${STEM_X} ${startY} C 255 ${startY + 35}, 270 ${startY + 80}, 280 ${endY}`;
}

function buildLeaves(side: 'left' | 'right', startY: number, endY: number): VineLeaf[] {
  const direction = side === 'left' ? -1 : 1;
  const baseX = side === 'left' ? 150 : 250;

  return [0.28, 0.52, 0.76].map((ratio, index) => ({
    cx: baseX + direction * index * 9,
    cy: startY + (endY - startY) * ratio,
    rotate: direction * (18 + index * 4)
  }));
}

function buildVines(events: VineEvent[], maxEvents: number): VineRenderItem[] {
  const visibleEvents = sortEvents(events).slice(0, maxEvents);
  const count = Math.max(visibleEvents.length, 1);
  const gap = (BOTTOM_Y - TOP_Y) / count;

  return visibleEvents.map((event, index) => {
    const side = index % 2 === 0 ? 'left' : 'right';
    const startY = TOP_Y + index * gap + 8;
    const endY = Math.min(startY + Math.max(68, gap * 0.72), BOTTOM_Y);
    const status = event.status ?? 'normal';
    const labelX = side === 'left' ? 28 : 248;
    const labelY = endY - 8;

    return {
      id: event.id,
      event,
      index,
      side,
      startY,
      endY,
      path: buildBranchPath(side, startY, endY),
      labelX,
      labelY,
      color: statusColor[status],
      leaves: buildLeaves(side, startY, endY)
    };
  });
}

export function TodayVineTimeline({ events, maxEvents = 10, className = '' }: TodayVineTimelineProps) {
  const sanitizedEvents = useMemo(() => events.filter(isValidEvent), [events]);
  const visibleEvents = useMemo(() => sortEvents(sanitizedEvents).slice(0, maxEvents), [sanitizedEvents, maxEvents]);
  const vines = useMemo(() => buildVines(sanitizedEvents, maxEvents), [sanitizedEvents, maxEvents]);
  const hiddenCount = Math.max(sanitizedEvents.length - visibleEvents.length, 0);

  const { mainVineRef, vineList } = useVineGrowProgress(vines);

  return (
    <section className={`today-vine-card ${className}`}>
      <div className="today-vine-header">
        <div>
          <h3>今日安排</h3>
          <p>藤条按事件顺序生长，冲突事件会高亮显示。</p>
        </div>
        <span>
          {visibleEvents.length}/{sanitizedEvents.length}
        </span>
      </div>

      <svg className="today-vine-svg" width={SVG_WIDTH} height={SVG_HEIGHT} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img">
        <title>今日安排藤条时间线</title>

        <path className="vine-main-base" d={`M ${STEM_X} ${TOP_Y - 15} V ${BOTTOM_Y + 15}`} />
        <path ref={mainVineRef} className="vine-main" d={`M ${STEM_X} ${TOP_Y - 15} V ${BOTTOM_Y + 15}`} />

        {vineList.map((item) => {
          if (!item.activated) {
            return null;
          }

          const branchDelay = 0;
          const leafDelay = 180;
          const labelDelay = 320;

          return (
            <g key={item.event.id} className={`vine-event vine-event-${item.side}`}>
              <path
                className="vine-branch"
                d={item.path}
                style={
                  {
                    '--vine-color': item.color,
                    '--delay': `${branchDelay}ms`
                  } as CSSProperties
                }
              />

              {item.leaves.map((leaf, leafIndex) => (
                <ellipse
                  key={`${item.event.id}-leaf-${leafIndex}`}
                  className="vine-leaf"
                  cx={leaf.cx}
                  cy={leaf.cy}
                  rx="8"
                  ry="4.5"
                  transform={`rotate(${leaf.rotate} ${leaf.cx} ${leaf.cy})`}
                  style={
                    {
                      '--vine-color': item.color,
                      '--leaf-delay': `${leafDelay + leafIndex * 90}ms`
                    } as CSSProperties
                  }
                />
              ))}

              <foreignObject
                x={item.labelX}
                y={item.labelY}
                width="124"
                height="54"
                className="vine-label"
                style={
                  {
                    '--label-delay': `${labelDelay}ms`
                  } as CSSProperties
                }
              >
                <div className="vine-label-box">
                  <strong>{item.event.title}</strong>
                  <span>{formatTimeRange(item.event)}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>

      {sanitizedEvents.length === 0 ? <div className="today-vine-more">今天还没有安排</div> : null}
      {hiddenCount > 0 ? <div className="today-vine-more">还有 {hiddenCount} 个事件未展示</div> : null}
    </section>
  );
}
