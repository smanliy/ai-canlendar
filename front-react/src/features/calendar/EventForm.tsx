import { Alert, DatePicker, Form, Input, Select } from 'antd';
import dayjs, { Dayjs } from 'dayjs';

import type { CalendarEvent, EventPayload } from '../../types/event';

export interface EventFormValues {
  title: string;
  timeRange: [Dayjs, Dayjs];
  location?: string;
  category: EventPayload['category'];
  priority: EventPayload['priority'];
  note?: string;
  status: EventPayload['status'];
}

interface EventFormProps {
  formId: string;
  initialEvent?: CalendarEvent | null;
  draftRange?: { startTime: string; endTime: string } | null;
  hasConflict: boolean;
  onSubmit: (payload: EventPayload) => Promise<void>;
}

export function EventForm({ formId, initialEvent, draftRange, hasConflict, onSubmit }: EventFormProps) {
  const initialValues: Partial<EventFormValues> = {
    title: initialEvent?.title ?? '',
    timeRange: [
      dayjs(initialEvent?.startTime ?? draftRange?.startTime ?? dayjs().hour(9).minute(0)),
      dayjs(initialEvent?.endTime ?? draftRange?.endTime ?? dayjs().hour(10).minute(0))
    ],
    location: initialEvent?.location,
    category: initialEvent?.category ?? '工作',
    priority: initialEvent?.priority ?? '中',
    note: initialEvent?.note,
    status: initialEvent?.status ?? '未开始'
  };

  const handleFinish = async (values: EventFormValues) => {
    await onSubmit({
      title: values.title,
      startTime: values.timeRange[0].toISOString(),
      endTime: values.timeRange[1].toISOString(),
      location: values.location,
      category: values.category,
      priority: values.priority,
      note: values.note,
      status: values.status
    });
  };

  return (
    <Form id={formId} layout="vertical" initialValues={initialValues} onFinish={handleFinish}>
      {hasConflict ? <Alert className="form-alert" type="warning" showIcon message="当前时间与已有日程冲突，仍可继续保存。" /> : null}
      <Form.Item name="title" label="标题" rules={[{ required: true, message: '标题不能为空' }]}>
        <Input placeholder="请输入日程标题" />
      </Form.Item>
      <Form.Item
        name="timeRange"
        label="时间"
        rules={[
          { required: true, message: '请选择开始和结束时间' },
          {
            validator: (_, value?: [Dayjs, Dayjs]) => {
              if (!value?.[0] || !value?.[1]) return Promise.reject(new Error('请选择开始和结束时间'));
              if (!value[0].isBefore(value[1])) return Promise.reject(new Error('开始时间必须早于结束时间'));
              return Promise.resolve();
            }
          }
        ]}
      >
        <DatePicker.RangePicker showTime format="YYYY-MM-DD HH:mm" className="full-width" />
      </Form.Item>
      <Form.Item name="location" label="地点">
        <Input placeholder="会议室、线上链接或地点" />
      </Form.Item>
      <div className="form-grid">
        <Form.Item name="category" label="分类" rules={[{ required: true, message: '请选择分类' }]}>
          <Select options={['工作', '学习', '生活', '面试'].map((value) => ({ label: value, value }))} />
        </Form.Item>
        <Form.Item name="priority" label="优先级" rules={[{ required: true, message: '请选择优先级' }]}>
          <Select options={['高', '中', '低'].map((value) => ({ label: value, value }))} />
        </Form.Item>
      </div>
      <Form.Item name="status" label="完成状态" rules={[{ required: true, message: '请选择状态' }]}>
        <Select options={['未开始', '进行中', '已完成', '已延期'].map((value) => ({ label: value, value }))} />
      </Form.Item>
      <Form.Item name="note" label="备注">
        <Input.TextArea rows={3} placeholder="补充说明" />
      </Form.Item>
    </Form>
  );
}
