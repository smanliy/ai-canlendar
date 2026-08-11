import { Alert, Button, List, Space, Typography } from 'antd';

import { useAgentStore } from '../../stores/agentStore';

interface PlanPreviewProps {
  onConfirm: () => Promise<void>;
  onRegenerate: () => Promise<void>;
  onCancel: () => void;
}

export function PlanPreview({ onConfirm, onRegenerate, onCancel }: PlanPreviewProps) {
  const plan = useAgentStore((state) => state.plan);
  const conflicts = useAgentStore((state) => state.conflicts);
  const confirmLoading = useAgentStore((state) => state.confirmLoading);

  if (!plan) return null;

  return (
    <section className="panel-block plan-block">
      <div className="panel-title-row">
        <h3>推荐排期方案</h3>
      </div>
      <div className="plan-summary">
        <strong>{plan.taskName}</strong>
        <span>截止时间：{plan.deadline}</span>
        <span>预计总时长：{plan.totalHours} 小时</span>
      </div>
      {conflicts.length > 0 ? <Alert type="warning" showIcon message={`检测到 ${conflicts.length} 个时间冲突，已推荐替代时段`} /> : null}
      <List
        className="plan-list"
        dataSource={plan.items}
        renderItem={(item) => (
          <List.Item>
            <div className="plan-item">
              <Typography.Text strong>{item.title}</Typography.Text>
              <span>
                {item.date} · {item.timeRange} · {item.durationHours}h
              </span>
            </div>
          </List.Item>
        )}
      />
      <div className="plan-actions">
        <Button type="primary" loading={confirmLoading} onClick={() => void onConfirm()}>
          确认写入日历
        </Button>
        <Space>
          <Button onClick={() => void onRegenerate()} disabled={confirmLoading}>
            重新生成
          </Button>
          <Button onClick={onCancel} disabled={confirmLoading}>
            取消
          </Button>
        </Space>
      </div>
    </section>
  );
}
