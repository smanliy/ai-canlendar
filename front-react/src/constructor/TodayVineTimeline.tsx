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
  x: number;
  y: number;
  rotate: number;
  scale: number;
  mirror?: boolean;
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
const MAX_VISIBLE_EVENTS = 10;

const statusColor: Record<VineEventStatus, string> = {
  normal: '#50994a',
  conflict: '#dc2626',
  approvedConflict: '#eab308',
  done: '#94a3b8'
};

interface VineTemplate {
  side: 'left' | 'right';
  startY: number;
  endY: number;
  path: string;
  leaves: VineLeaf[];
  labelX: number;
  labelY: number;
}

const VINE_TEMPLATES: VineTemplate[] = [
  {
    side: 'left',
    startY: 56,
    endY: 110,
    path: 'M 200 56 C 174 48, 157 67, 143 84 C 126 106, 103 111, 72 104',
    leaves: [
      { x: 170, y: 60, rotate: -154, scale: 0.72, mirror: true },
      { x: 139, y: 88, rotate: -22, scale: 0.62 },
      { x: 106, y: 107, rotate: -168, scale: 0.52, mirror: true }
    ],
    labelX: 18,
    labelY: 26
  },
  {
    side: 'right',
    startY: 112,
    endY: 166,
    path: 'M 200 112 C 228 106, 244 126, 256 145 C 270 168, 298 172, 332 154',
    leaves: [
      { x: 231, y: 117, rotate: 18, scale: 0.68 },
      { x: 258, y: 148, rotate: 154, scale: 0.58, mirror: true },
      { x: 299, y: 163, rotate: -10, scale: 0.5 }
    ],
    labelX: 252,
    labelY: 84
  },
  {
    side: 'left',
    startY: 174,
    endY: 224,
    path: 'M 200 174 C 178 178, 164 190, 151 205 C 130 230, 103 224, 63 235',
    leaves: [
      { x: 171, y: 187, rotate: -144, scale: 0.6, mirror: true },
      { x: 147, y: 211, rotate: -18, scale: 0.72 },
      { x: 104, y: 226, rotate: -165, scale: 0.5, mirror: true },
      { x: 78, y: 235, rotate: 8, scale: 0.44 }
    ],
    labelX: 18,
    labelY: 146
  },
  {
    side: 'right',
    startY: 232,
    endY: 287,
    path: 'M 200 232 C 222 239, 231 259, 253 264 C 282 270, 294 306, 337 289',
    leaves: [
      { x: 222, y: 241, rotate: 28, scale: 0.52 },
      { x: 254, y: 263, rotate: 164, scale: 0.66, mirror: true },
      { x: 293, y: 292, rotate: 22, scale: 0.54 },
      { x: 320, y: 294, rotate: -18, scale: 0.46 }
    ],
    labelX: 252,
    labelY: 206
  },
  {
    side: 'left',
    startY: 294,
    endY: 347,
    path: 'M 200 294 C 167 292, 155 306, 139 324 C 118 348, 90 345, 58 361',
    leaves: [
      { x: 166, y: 301, rotate: -156, scale: 0.7, mirror: true },
      { x: 139, y: 326, rotate: -24, scale: 0.58 },
      { x: 101, y: 348, rotate: -172, scale: 0.62, mirror: true }
    ],
    labelX: 18,
    labelY: 266
  },
  {
    side: 'right',
    startY: 352,
    endY: 403,
    path: 'M 200 352 C 234 344, 242 366, 260 382 C 279 399, 309 398, 343 415',
    leaves: [
      { x: 232, y: 354, rotate: 16, scale: 0.7 },
      { x: 261, y: 383, rotate: 158, scale: 0.56, mirror: true },
      { x: 303, y: 400, rotate: 14, scale: 0.5 }
    ],
    labelX: 252,
    labelY: 326
  },
  {
    side: 'left',
    startY: 414,
    endY: 468,
    path: 'M 200 414 C 181 420, 164 429, 151 447 C 133 471, 104 482, 67 469',
    leaves: [
      { x: 173, y: 424, rotate: -148, scale: 0.56, mirror: true },
      { x: 151, y: 448, rotate: -12, scale: 0.64 },
      { x: 116, y: 476, rotate: -166, scale: 0.48, mirror: true },
      { x: 82, y: 471, rotate: 6, scale: 0.42 }
    ],
    labelX: 18,
    labelY: 386
  },
  {
    side: 'right',
    startY: 475,
    endY: 526,
    path: 'M 200 475 C 222 466, 246 485, 257 505 C 272 531, 304 539, 334 520',
    leaves: [
      { x: 229, y: 478, rotate: 8, scale: 0.52 },
      { x: 258, y: 506, rotate: 160, scale: 0.68, mirror: true },
      { x: 300, y: 532, rotate: 18, scale: 0.54 },
      { x: 323, y: 522, rotate: -16, scale: 0.42 }
    ],
    labelX: 252,
    labelY: 448
  },
  {
    side: 'left',
    startY: 535,
    endY: 586,
    path: 'M 200 535 C 170 531, 163 553, 142 566 C 119 580, 91 574, 60 594',
    leaves: [
      { x: 169, y: 541, rotate: -152, scale: 0.62, mirror: true },
      { x: 142, y: 567, rotate: -18, scale: 0.7 },
      { x: 101, y: 578, rotate: -164, scale: 0.46, mirror: true }
    ],
    labelX: 18,
    labelY: 508
  },
  {
    side: 'right',
    startY: 594,
    endY: 630,
    path: 'M 200 594 C 224 591, 239 607, 259 619 C 281 632, 310 629, 339 617',
    leaves: [
      { x: 227, y: 600, rotate: 18, scale: 0.56 },
      { x: 260, y: 620, rotate: 154, scale: 0.62, mirror: true },
      { x: 305, y: 626, rotate: -2, scale: 0.48 }
    ],
    labelX: 252,
    labelY: 566
  }
];

const DEMO_EVENTS: VineEvent[] = [
  { id: 'demo-vine-1', title: '晨间复盘', startTime: '2026-08-23T08:30:00+08:00', endTime: '2026-08-23T09:00:00+08:00' },
  { id: 'demo-vine-2', title: 'TS 类型系统', startTime: '2026-08-23T09:20:00+08:00', endTime: '2026-08-23T10:10:00+08:00' },
  { id: 'demo-vine-3', title: '刷面试题', startTime: '2026-08-23T10:30:00+08:00', endTime: '2026-08-23T11:20:00+08:00' },
  { id: 'demo-vine-4', title: '整理错题', startTime: '2026-08-23T11:30:00+08:00', endTime: '2026-08-23T12:00:00+08:00' },
  { id: 'demo-vine-5', title: '项目源码阅读', startTime: '2026-08-23T14:00:00+08:00', endTime: '2026-08-23T14:50:00+08:00' },
  { id: 'demo-vine-6', title: '组件设计练习', startTime: '2026-08-23T15:10:00+08:00', endTime: '2026-08-23T16:00:00+08:00' },
  { id: 'demo-vine-7', title: '接口字段梳理', startTime: '2026-08-23T16:20:00+08:00', endTime: '2026-08-23T16:50:00+08:00' },
  { id: 'demo-vine-8', title: '晚间黄金时间', startTime: '2026-08-23T19:00:00+08:00', endTime: '2026-08-23T20:00:00+08:00' },
  { id: 'demo-vine-9', title: '模拟面试', startTime: '2026-08-23T20:20:00+08:00', endTime: '2026-08-23T21:10:00+08:00' },
  { id: 'demo-vine-10', title: '明日计划', startTime: '2026-08-23T21:30:00+08:00', endTime: '2026-08-23T22:00:00+08:00' }
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
    const template = VINE_TEMPLATES[index % VINE_TEMPLATES.length];
    const status = event.status ?? 'normal';

    return {
      id: event.id,
      event,
      index,
      side: template.side,
      startY: template.startY,
      endY: template.endY,
      path: template.path,
      labelX: template.labelX,
      labelY: template.labelY,
      color: statusColor[status],
      leaves: template.leaves,
      groupShift: 0
    };
  });
}

function getPathEndPoint(path: string) {
  const numbers = path.match(/-?\d+(?:\.\d+)?/g)?.map(Number) ?? [];

  return {
    x: numbers[numbers.length - 2] ?? 200,
    y: numbers[numbers.length - 1] ?? 30
  };
}

function fillTimelineEvents(events: VineEvent[], maxEvents: number) {
  const sortedEvents = sortEvents(events).slice(0, maxEvents);
  if (sortedEvents.length >= maxEvents) {
    return sortedEvents;
  }

  const usedIds = new Set(sortedEvents.map((event) => event.id));
  const fillers = DEMO_EVENTS.filter((event) => !usedIds.has(event.id)).slice(0, maxEvents - sortedEvents.length);
  return [...sortedEvents, ...fillers];
}

export function TodayVineTimeline({ events, maxEvents = MAX_VISIBLE_EVENTS, className = '' }: TodayVineTimelineProps) {
  const sanitizedEvents = useMemo(() => events.filter(isValidEvent), [events]);
  const timelineEvents = useMemo(() => fillTimelineEvents(sanitizedEvents, maxEvents), [sanitizedEvents, maxEvents]);
  const visibleEvents = useMemo(() => sortEvents(timelineEvents).slice(0, maxEvents), [timelineEvents, maxEvents]);
  const vines = useMemo(() => buildVines(timelineEvents, maxEvents), [timelineEvents, maxEvents]);
  const hiddenCount = Math.max(timelineEvents.length - visibleEvents.length, 0);

  const { mainVineRef, vineList } = useVineGrowProgress(vines);

  return (
    <section className={`today-vine-card ${className}`}>
      <div className="today-vine-header">
        <div>
          <h3>今日安排</h3>
          <p>藤条按事件顺序生长，冲突事件会高亮显示。</p>
        </div>
        <span>
          {visibleEvents.length}/{timelineEvents.length}
        </span>
      </div>

      <svg className="today-vine-svg" width={SVG_WIDTH} height={SVG_HEIGHT} viewBox={`0 0 ${SVG_WIDTH} ${SVG_HEIGHT}`} role="img">
        <title>今日安排藤条时间线</title>

        <path ref={mainVineRef} className="vine-main" d="M 202 30 C 196 128, 207 210, 200 306 C 194 404, 207 510, 198 626" />

        {vineList.map((item) => {
          if (!item.activated) {
            return null;
          }

          const tipPoint = getPathEndPoint(item.path);

          return (
            <g key={item.event.id} className={`vine-event vine-event-${item.side}`}>
              <path
                className="vine-branch"
                d={item.path}
                style={
                  {
                    '--vine-color': item.color,
                    '--delay': `${item.index * 35}ms`
                  } as CSSProperties
                }
              />

              {item.leaves.map((leaf, leafIndex) => (
                <g
                  key={`${item.event.id}-leaf-${leafIndex}`}
                  className="vine-leaf-shell"
                  style={
                    {
                      '--vine-color': item.color,
                      '--leaf-delay': `${180 + item.index * 45 + leafIndex * 70}ms`,
                      '--leaf-x': leaf.x,
                      '--leaf-y': leaf.y,
                      '--leaf-rotate': `${leaf.rotate}deg`,
                      '--leaf-scale': leaf.scale,
                      '--leaf-mirror': leaf.mirror ? -1 : 1
                    } as CSSProperties
                  }
                >
                  <path className="vine-leaf" d="M 0 0 C 7 -8, 17 -8, 22 0 C 15 7, 6 6, 0 0 Z" />
                  <path className="vine-leaf-vein" d="M 3 0 C 8 -1, 14 -1, 19 0" />
                </g>
              ))}

              <circle
                className="vine-tip"
                cx={tipPoint.x}
                cy={tipPoint.y}
                r="2.2"
                style={
                  {
                    '--vine-color': item.color,
                    '--tip-delay': `${320 + item.index * 50}ms`
                  } as CSSProperties
                }
              />

              <foreignObject x={item.labelX} y={item.labelY} width="130" height="48" className="vine-label">
                <div
                  className="vine-label-box"
                  style={
                    {
                      '--label-delay': `${260 + item.index * 55}ms`
                    } as CSSProperties
                  }
                >
                  <strong>{item.event.title}</strong>
                  <span>{formatTimeRange(item.event)}</span>
                </div>
              </foreignObject>
            </g>
          );
        })}
      </svg>

      {sanitizedEvents.length < maxEvents ? <div className="today-vine-more">已补足示例藤条用于视觉预览</div> : null}
      {hiddenCount > 0 ? <div className="today-vine-more">还有 {hiddenCount} 个事件未展示</div> : null}
    </section>
  );
}
