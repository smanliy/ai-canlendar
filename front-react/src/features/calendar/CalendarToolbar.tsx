import { Alert, Spin } from 'antd';

interface CalendarToolbarProps {
  loading: boolean;
  error: string | null;
}

export function CalendarToolbar({ loading, error }: CalendarToolbarProps) {
  if (error) {
    return <Alert className="calendar-state" type="error" showIcon message={error} />;
  }
  if (loading) {
    return (
      <div className="calendar-loading">
        <Spin size="small" />
        <span>正在加载日程...</span>
      </div>
    );
  }
  return null;
}
