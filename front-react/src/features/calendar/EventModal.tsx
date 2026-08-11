import { App as AntApp, Button, Modal, Popconfirm } from 'antd';
import dayjs from 'dayjs';
import { useMemo, useState } from 'react';

import { EventForm } from './EventForm';
import { useCalendarStore } from '../../stores/calendarStore';
import type { CalendarEvent, EventPayload } from '../../types/event';

interface EventModalProps {
  events: CalendarEvent[];
  onCreate: (payload: EventPayload) => Promise<unknown>;
  onUpdate: (id: string, payload: Partial<EventPayload>) => Promise<unknown>;
  onDelete: (id: string) => Promise<void>;
}

const formId = 'event-form';

export function EventModal({ events, onCreate, onUpdate, onDelete }: EventModalProps) {
  const { message } = AntApp.useApp();
  const { eventModalOpen, eventModalMode, selectedEvent, draftRange, closeEventModal } = useCalendarStore();
  const [submitting, setSubmitting] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const hasConflict = useMemo(() => {
    const start = selectedEvent?.startTime ?? draftRange?.startTime;
    const end = selectedEvent?.endTime ?? draftRange?.endTime;
    if (!start || !end) return false;
    return events.some((event) => {
      if (event.id === selectedEvent?.id) return false;
      return dayjs(event.endTime).isAfter(start) && dayjs(event.startTime).isBefore(end);
    });
  }, [draftRange, events, selectedEvent]);

  const handleSubmit = async (payload: EventPayload) => {
    setSubmitting(true);
    try {
      if (eventModalMode === 'edit' && selectedEvent) {
        await onUpdate(selectedEvent.id, payload);
        message.success('日程已更新');
      } else {
        await onCreate(payload);
        message.success('日程已创建');
      }
      closeEventModal();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '保存日程失败');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async () => {
    if (!selectedEvent) return;
    setDeleting(true);
    try {
      await onDelete(selectedEvent.id);
      message.success('日程已删除');
      closeEventModal();
    } catch (err) {
      message.error(err instanceof Error ? err.message : '删除日程失败');
    } finally {
      setDeleting(false);
    }
  };

  return (
    <Modal
      title={eventModalMode === 'edit' ? '编辑日程' : '新建日程'}
      open={eventModalOpen}
      onCancel={closeEventModal}
      destroyOnHidden
      footer={[
        eventModalMode === 'edit' ? (
          <Popconfirm key="delete" title="确认删除此日程？" okText="删除" cancelText="取消" onConfirm={handleDelete}>
            <Button danger loading={deleting}>
              删除
            </Button>
          </Popconfirm>
        ) : null,
        <Button key="cancel" onClick={closeEventModal}>
          取消
        </Button>,
        <Button key="submit" type="primary" htmlType="submit" form={formId} loading={submitting}>
          保存
        </Button>
      ]}
    >
      <EventForm formId={formId} initialEvent={selectedEvent} draftRange={draftRange} hasConflict={hasConflict} onSubmit={handleSubmit} />
    </Modal>
  );
}
