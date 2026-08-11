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
  rx: number;
  ry: number;
  transform?: string;
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
  groupShift: number;
}

const SVG_WIDTH = 400;
const SVG_HEIGHT = 650;
const STEM_X = 200;
const TOP_Y = 30;
const BOTTOM_Y = 650;
const MAX_VISIBLE_EVENTS = 10;
const TEMPLATE_COUNT = 6;
const CYCLE_SHIFT_Y = 42;

const statusColor: Record<VineEventStatus, string> = {
  normal: '#50994a',
  conflict: '#dc2626',
  approvedConflict: '#eab308',
  done: '#94a3b8'
};

interface VineTemplate {
  side: 'left' | 'right';
  startY: number;
  path: string;
  leaves: VineLeaf[];
  labelX: number;
  labelY: number;
}

const VINE_TEMPLATES: VineTemplate[] = [
  {
    side: 'left',
    startY: 40,
    path: 'M 200 40 c -85 60, -35 130, -65 200 s -50 90, -45 145',
    leaves: [
      { cx: 146, cy: 78, rx: 8, ry: 4.5, transform: 'translate(-2.142852783203125, 25.00000762939453)' },
      {
        cx: 122,
        cy: 136,
        rx: 8,
        ry: 4.5,
        transform: 'translate(46.68784750830963, 32.77599936628117) scale(0.750752827608432)'
      },
      { cx: 110, cy: 202, rx: 8, ry: 4.5 },
      { cx: 126, cy: 274, rx: 8, ry: 4.5 }
    ],
    labelX: 38,
    labelY: 168
  },
  {
    side: 'left',
    startY: 110,
    path: 'M 200 110 c -85 60, -35 130, -35 200 s -35 90, -35 185',
    leaves: [
      { cx: 154, cy: 126, rx: 8, ry: 4.5 },
      { cx: 133, cy: 188, rx: 8, ry: 4.5 },
      { cx: 136, cy: 260, rx: 8, ry: 4.5 },
      { cx: 142, cy: 330, rx: 8, ry: 4.5 }
    ],
    labelX: 38,
    labelY: 246
  },
  {
    side: 'left',
    startY: 220,
    path: 'M 200 220 c -85 60, -35 130, -35 200 s -35 90, -35 185',
    leaves: [
      { cx: 152, cy: 258, rx: 8, ry: 4.5 },
      { cx: 131, cy: 320, rx: 8, ry: 4.5 },
      { cx: 135, cy: 392, rx: 8, ry: 4.5 },
      { cx: 141, cy: 460, rx: 8, ry: 4.5 }
    ],
    labelX: 38,
    labelY: 336
  },
  {
    side: 'right',
    startY: 50,
    path: 'M 200 50 c 62 55, 40 125, 70 165 s -2 100, 2 150',
    leaves: [
      { cx: 252, cy: 84, rx: 8, ry: 4.5, transform: 'translate(-17.142852783203125, -3.5714263916015625)' },
      { cx: 268, cy: 142, rx: 8, ry: 4.5, transform: 'translate(-10.714263916015625, 0)' },
      { cx: 274, cy: 216, rx: 8, ry: 4.5, transform: 'translate(4.285675048828125, 0)' },
      { cx: 270, cy: 286, rx: 8, ry: 4.5, transform: 'translate(2.857147216796875, -3.5714111328125)' }
    ],
    labelX: 238,
    labelY: 154
  },
  {
    side: 'right',
    startY: 60,
    path: 'M 200 60 c 20 65, 30 125, 32 190 s -5 85, 68 195',
    leaves: [
      { cx: 234, cy: 96, rx: 8, ry: 4.5, transform: 'rotate(20 146 78)' },
      { cx: 250, cy: 156, rx: 8, ry: 4.5, transform: 'translate(-2.142852783203125, 25.000015258789062)' },
      { cx: 262, cy: 228, rx: 8, ry: 4.5, transform: 'translate(-2.857147216796875, -19.28570556640625)' },
      { cx: 278, cy: 308, rx: 8, ry: 4.5, transform: 'translate(4.28570556640625, 0)' }
    ],
    labelX: 238,
    labelY: 176
  },
  {
    side: 'right',
    startY: 180,
    path: 'M 200 180 c 20 65, 30 125, 22 190 s 5 85, 38 175',
    leaves: [
      { cx: 232, cy: 214, rx: 8, ry: 4.5 },
      { cx: 246, cy: 276, rx: 8, ry: 4.5 },
      { cx: 254, cy: 348, rx: 8, ry: 4.5 },
      { cx: 266, cy: 418, rx: 8, ry: 4.5 }
    ],
    labelX: 238,
    labelY: 304
  }
];

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

function buildVines(events: VineEvent[], maxEvents: number): VineRenderItem[] {
  const visibleEvents = sortEvents(events).slice(0, maxEvents);

  return visibleEvents.map((event, index) => {
    const template = VINE_TEMPLATES[index % TEMPLATE_COUNT];
    const cycle = Math.floor(index / TEMPLATE_COUNT);
    const groupShift = cycle * CYCLE_SHIFT_Y;
    const status = event.status ?? 'normal';

    return {
      id: event.id,
      event,
      index,
      side: template.side,
      startY: template.startY + groupShift,
      endY: template.startY + groupShift + 200,
      path: template.path,
      labelX: template.labelX,
      labelY: template.labelY + groupShift,
      color: statusColor[status],
      leaves: template.leaves,
      groupShift
    };
  });
}

export function TodayVineTimeline({ events, maxEvents = MAX_VISIBLE_EVENTS, className = '' }: TodayVineTimelineProps) {
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

        <path className="vine-main-base" d="M 200 30 V 650" />
        <path ref={mainVineRef} className="vine-main" d="M 200 30 V 650" />

        {vineList.map((item) => {
          if (!item.activated) {
            return null;
          }

          return (
            <g key={item.event.id} transform={`translate(0 ${item.groupShift})`} className={`vine-event vine-event-${item.side}`}>
              <path
                className="vine-branch"
                d={item.path}
                style={
                  {
                    '--vine-color': item.color,
                    '--delay': '0ms'
                  } as CSSProperties
                }
              />

              {item.leaves.map((leaf, leafIndex) => (
                <ellipse
                  key={`${item.event.id}-leaf-${leafIndex}`}
                  className="vine-leaf"
                  cx={leaf.cx}
                  cy={leaf.cy}
                  rx={leaf.rx}
                  ry={leaf.ry}
                  transform={leaf.transform}
                  style={
                    {
                      '--vine-color': item.color,
                      '--leaf-delay': `${180 + leafIndex * 70}ms`
                    } as CSSProperties
                  }
                />
              ))}

              <foreignObject x={item.labelX} y={item.labelY} width="124" height="54" className="vine-label">
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
