import FullCalendar from '@fullcalendar/react';
import type { CSSProperties } from 'react';
import { useEffect, useMemo, useRef, useState } from 'react';

import { CalendarMain } from '../features/calendar/CalendarMain';
import { EventModal } from '../features/calendar/EventModal';
import { useCalendarEvents } from '../hooks/useCalendarEvents';
import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import { useCalendarStore } from '../stores/calendarStore';
import type { CalendarEvent } from '../types/event';
import { formatTimeRange, isSameDay } from '../utils/date';

interface CalendarWorkspacePageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

function toTime(value: string) {
  const time = new Date(value).getTime();
  return Number.isNaN(time) ? 0 : time;
}

function isSameMonth(date: string, target: string) {
  const sourceDate = new Date(date);
  const targetDate = new Date(target);
  if (Number.isNaN(sourceDate.getTime()) || Number.isNaN(targetDate.getTime())) return false;
  return sourceDate.getFullYear() === targetDate.getFullYear() && sourceDate.getMonth() === targetDate.getMonth();
}

function formatMonthLabel(value: string) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '当前月份';
  return `${date.getFullYear()}年${date.getMonth() + 1}月`;
}

function CalendarIndexPanel({ events, currentDate }: { events: CalendarEvent[]; currentDate: string }) {
  const [coverLifted, setCoverLifted] = useState(false);
  const [coverPumpCount, setCoverPumpCount] = useState(0);
  const [coverPumpBurst, setCoverPumpBurst] = useState(0);
  const [coverPopped, setCoverPopped] = useState(false);
  const today = new Date().toISOString();
  const monthEvents = useMemo(
    () => events.filter((event) => isSameMonth(event.startTime, currentDate)).sort((a, b) => toTime(a.startTime) - toTime(b.startTime)),
    [currentDate, events]
  );
  const todayEvents = useMemo(() => events.filter((event) => isSameDay(event.startTime, today)), [events, today]);
  const completedCount = monthEvents.filter((event) => event.status === '已完成').length;
  const upcomingEvents = monthEvents.filter((event) => toTime(event.endTime) >= Date.now()).slice(0, 4);
  const categoryCounts = monthEvents.reduce<Record<string, number>>((result, event) => {
    const category = event.category || '未分类';
    result[category] = (result[category] ?? 0) + 1;
    return result;
  }, {});
  const categoryItems = Object.entries(categoryCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
  const coverPumpLevel = Math.min(coverPumpCount, 8);

  useEffect(() => {
    if (!coverPopped) return undefined;
    const timer = window.setTimeout(() => {
      setCoverLifted(true);
    }, 820);
    return () => window.clearTimeout(timer);
  }, [coverPopped]);

  const handleCoverToggle = () => {
    setCoverLifted((value) => {
      if (value) {
        setCoverPumpCount(0);
        setCoverPumpBurst(0);
        setCoverPopped(false);
      }
      return !value;
    });
  };

  const handleCoverPump = () => {
    if (coverPopped) return;
    setCoverPumpBurst((value) => value + 1);
    if (coverPumpCount >= 8) {
      setCoverPopped(true);
      return;
    }
    setCoverPumpCount((value) => value + 1);
  };

  return (
    <aside
      className={`calendar-index-panel ${coverLifted ? 'cover-lifted' : ''} ${coverPopped ? 'cover-popped' : ''}`}
      style={{ '--cover-pump': coverPumpLevel } as CSSProperties}
    >
      <button className="calendar-cover-toggle" type="button" onClick={handleCoverToggle} aria-pressed={coverLifted}>
        <span>{coverLifted ? '放下封面' : '翻开封面'}</span>
      </button>
      <section className="calendar-index-cover" aria-hidden={coverLifted}>
        <div className="calendar-cover-rings" aria-hidden="true">
          <span />
          <span />
          <span />
        </div>
        <div className="calendar-cover-label-row">
          <span>month cover</span>
          <em>focus sheet</em>
        </div>
        <strong>{formatMonthLabel(currentDate)}</strong>
        <h3>今天也把时间拿回来一点。</h3>
        <p>先看全局，再处理下一件小事。翻开封面后检查本月索引、接下来安排和分类密度。</p>
        <button className="calendar-cover-pet" type="button" onClick={handleCoverPump} aria-label="给自己打气">
          {coverPopped ? (
            <div className="calendar-cover-confetti" key={`confetti-${coverPumpBurst}`} aria-hidden="true">
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
              <span />
            </div>
          ) : null}
          <div className="calendar-cover-balloon">
            <span />
          </div>
          <div className="calendar-cover-pump" key={`pump-${coverPumpBurst}`}>
            <i />
          </div>
          {coverPumpBurst > 0 ? (
            <span className="calendar-cover-plus-one" key={`plus-${coverPumpBurst}`}>
              {coverPopped ? '嘭!' : '+1'}
            </span>
          ) : null}
          <div className="calendar-cover-pet-body">
            <span className="pet-ear pet-ear-left" />
            <span className="pet-ear pet-ear-right" />
            <span className="pet-face" />
            <span className="pet-paw pet-paw-left" />
            <span className="pet-paw pet-paw-right" />
          </div>
        </button>
        <div className="calendar-cover-boost">{coverPopped ? '封面翻开中' : `打气值 ${coverPumpLevel}/8`}</div>
        <div className="calendar-cover-checks" aria-hidden="true">
          <span>scan month</span>
          <span>pick next</span>
          <span>keep moving</span>
        </div>
      </section>
      <section className="calendar-index-hero">
        <span>calendar index</span>
        <strong>{formatMonthLabel(currentDate)}</strong>
        <p>这一页只看日历本身：事件密度、分类和接下来要发生的安排。</p>
      </section>

      <section className="calendar-index-stats" aria-label="日历统计">
        <div>
          <span>本月日程</span>
          <strong>{monthEvents.length}</strong>
        </div>
        <div>
          <span>今天</span>
          <strong>{todayEvents.length}</strong>
        </div>
        <div>
          <span>已完成</span>
          <strong>{completedCount}</strong>
        </div>
      </section>

      <section className="calendar-index-section">
        <div className="calendar-index-title-row">
          <h3>接下来</h3>
          <span>{upcomingEvents.length}/4</span>
        </div>
        <div className="calendar-next-list">
          {upcomingEvents.length > 0 ? (
            upcomingEvents.map((event) => (
              <div className="calendar-next-item" key={event.id}>
                <strong>{event.title}</strong>
                <span>{formatTimeRange(event.startTime, event.endTime)}</span>
              </div>
            ))
          ) : (
            <div className="calendar-index-empty">当前月份后续没有安排。</div>
          )}
        </div>
      </section>

      <section className="calendar-index-section">
        <div className="calendar-index-title-row">
          <h3>分类密度</h3>
          <span>{categoryItems.length}</span>
        </div>
        <div className="calendar-category-meter-list">
          {categoryItems.length > 0 ? (
            categoryItems.map(([category, count]) => (
              <div className="calendar-category-meter" key={category}>
                <span>{category}</span>
                <div>
                  <i style={{ width: `${Math.max(18, (count / Math.max(monthEvents.length, 1)) * 100)}%` }} />
                </div>
                <em>{count}</em>
              </div>
            ))
          ) : (
            <div className="calendar-index-empty">本月还没有分类数据。</div>
          )}
        </div>
      </section>
    </aside>
  );
}

export function CalendarWorkspacePage({ activePage, onNavigate }: CalendarWorkspacePageProps) {
  const calendarRef = useRef<FullCalendar>(null);
  const currentDate = useCalendarStore((state) => state.currentDate);
  const currentView = useCalendarStore((state) => state.currentView);
  const setCurrentDate = useCalendarStore((state) => state.setCurrentDate);
  const openCreateModal = useCalendarStore((state) => state.openCreateModal);

  const { events, loading, error, createEvent, updateEvent, deleteEvent } = useCalendarEvents();

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.changeView(currentView);
  }, [currentView]);

  useEffect(() => {
    const api = calendarRef.current?.getApi();
    if (!api) return;
    api.gotoDate(currentDate);
  }, [currentDate]);

  const handleToday = () => {
    const api = calendarRef.current?.getApi();
    api?.today();
    setCurrentDate(api?.getDate().toISOString() ?? new Date().toISOString());
  };

  const handlePrev = () => {
    const api = calendarRef.current?.getApi();
    api?.prev();
    setCurrentDate(api?.getDate().toISOString() ?? currentDate);
  };

  const handleNext = () => {
    const api = calendarRef.current?.getApi();
    api?.next();
    setCurrentDate(api?.getDate().toISOString() ?? currentDate);
  };

  return (
    <AppLayout
      activePage={activePage}
      title="日历"
      showCalendarControls
      onNavigate={onNavigate}
      onToday={handleToday}
      onPrev={handlePrev}
      onNext={handleNext}
      onCreate={() => openCreateModal()}
    >
      <main className="workspace-main">
        <div className="calendar-column">
          <CalendarMain calendarRef={calendarRef} events={events} loading={loading} error={error} onUpdate={updateEvent} />
        </div>
        <CalendarIndexPanel events={events} currentDate={currentDate} />
      </main>
      <EventModal events={events} onCreate={createEvent} onUpdate={updateEvent} onDelete={deleteEvent} />
    </AppLayout>
  );
}
