import { Empty, Button } from 'antd';

interface EmptyStateProps {
  description: string;
  actionText?: string;
  onAction?: () => void;
}

export function EmptyState({ description, actionText, onAction }: EmptyStateProps) {
  return (
    <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={description}>
      {actionText ? <Button onClick={onAction}>{actionText}</Button> : null}
    </Empty>
  );
}
