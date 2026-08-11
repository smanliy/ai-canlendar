import { Button, Input, Space } from 'antd';
import { CalendarOutlined, PartitionOutlined, ThunderboltOutlined } from '@ant-design/icons';

import { useAgentStore } from '../../stores/agentStore';

interface AIAssistantPanelProps {
  onGenerate: () => Promise<void>;
}

export function AIAssistantPanel({ onGenerate }: AIAssistantPanelProps) {
  const userInput = useAgentStore((state) => state.userInput);
  const runStatus = useAgentStore((state) => state.runStatus);
  const setUserInput = useAgentStore((state) => state.setUserInput);
  const loading = runStatus === 'running';

  return (
    <section className="panel-block assistant-block">
      <div className="panel-title-row">
        <h3>AI 快捷排期</h3>
      </div>
      <Input.TextArea
        value={userInput}
        onChange={(event) => setUserInput(event.target.value)}
        rows={4}
        placeholder="例如：下周五前完成开题报告，预计 10 小时，每天晚上 7 点后安排"
        disabled={loading}
      />
      <Space wrap className="quick-actions">
        <Button icon={<CalendarOutlined />} disabled={loading}>
          创建日程
        </Button>
        <Button icon={<PartitionOutlined />} disabled={loading}>
          拆解任务
        </Button>
        <Button icon={<ThunderboltOutlined />} disabled={loading}>
          智能排期
        </Button>
      </Space>
      <Button type="primary" block loading={loading} onClick={() => void onGenerate()} disabled={loading}>
        {loading ? 'Agent 正在工作...' : '生成排期方案'}
      </Button>
    </section>
  );
}
