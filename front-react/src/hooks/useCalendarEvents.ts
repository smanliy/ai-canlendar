import { useCallback, useEffect, useMemo, useState } from 'react';
import { App as AntApp } from 'antd';

import { eventApi } from '../services/eventApi';
import type { CalendarEvent, EventPayload } from '../types/event';

export function useCalendarEvents() {
  const { message } = AntApp.useApp();
  const [events, setEvents] = useState<CalendarEvent[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchEvents = useCallback(async (start?: string, end?: string) => {
    setLoading(true);
    setError(null);
    try {
      const result = await eventApi.getEvents(start, end);
      setEvents(result);
    } catch (err) {
      const errorMessage = err instanceof Error ? err.message : '加载日程失败';
      setError(errorMessage);
      message.error(errorMessage);
    } finally {
      setLoading(false);
    }
  }, [message]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  useEffect(() => {
    const handleChanged = () => {
      void fetchEvents();
    };
    window.addEventListener('chrono-calendar-events-changed', handleChanged);
    return () => {
      window.removeEventListener('chrono-calendar-events-changed', handleChanged);
    };
  }, [fetchEvents]);

  const createEvent = useCallback(async (payload: EventPayload) => {
    const created = await eventApi.createEvent(payload);
    setEvents((prev) => [...prev, created]);
    return created;
  }, []);

  const updateEvent = useCallback(async (id: string, payload: Partial<EventPayload>) => {
    const updated = await eventApi.updateEvent(id, payload);
    setEvents((prev) => prev.map((event) => (event.id === id ? updated : event)));
    return updated;
  }, []);

  const deleteEvent = useCallback(async (id: string) => {
    await eventApi.deleteEvent(id);
    setEvents((prev) => prev.filter((event) => event.id !== id));
  }, []);

  const bulkCreateEvents = useCallback(async (items: EventPayload[]) => {
    const created = await eventApi.bulkCreateEvents(items);
    setEvents((prev) => [...prev, ...created]);
    return created;
  }, []);

  return useMemo(
    () => ({ events, loading, error, fetchEvents, createEvent, updateEvent, deleteEvent, bulkCreateEvents }),
    [events, loading, error, fetchEvents, createEvent, updateEvent, deleteEvent, bulkCreateEvents]
  );
}
