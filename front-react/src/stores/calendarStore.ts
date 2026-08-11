import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import dayjs from 'dayjs';

import type { CalendarEvent } from '../types/event';

export type CalendarView = 'dayGridMonth' | 'timeGridWeek' | 'timeGridDay';
export type EventModalMode = 'create' | 'edit';

interface CalendarState {
  currentDate: string;
  currentView: CalendarView;
  selectedEvent: CalendarEvent | null;
  eventModalOpen: boolean;
  eventModalMode: EventModalMode;
  draftRange: { startTime: string; endTime: string } | null;
  setCurrentDate: (date: string) => void;
  setCurrentView: (view: CalendarView) => void;
  openCreateModal: (range?: { startTime: string; endTime: string }) => void;
  openEditModal: (event: CalendarEvent) => void;
  closeEventModal: () => void;
}

export const useCalendarStore = create<CalendarState>()(
  immer((set) => ({
    currentDate: dayjs().format('YYYY-MM-DD'),
    currentView: 'dayGridMonth',
    selectedEvent: null,
    eventModalOpen: false,
    eventModalMode: 'create',
    draftRange: null,
    setCurrentDate: (date) =>
      set((state) => {
        state.currentDate = date;
      }),
    setCurrentView: (view) =>
      set((state) => {
        state.currentView = view;
      }),
    openCreateModal: (range) =>
      set((state) => {
        state.eventModalMode = 'create';
        state.selectedEvent = null;
        state.draftRange = range ?? null;
        state.eventModalOpen = true;
      }),
    openEditModal: (event) =>
      set((state) => {
        state.eventModalMode = 'edit';
        state.selectedEvent = event;
        state.draftRange = null;
        state.eventModalOpen = true;
      }),
    closeEventModal: () =>
      set((state) => {
        state.eventModalOpen = false;
        state.selectedEvent = null;
        state.draftRange = null;
      })
  }))
);
