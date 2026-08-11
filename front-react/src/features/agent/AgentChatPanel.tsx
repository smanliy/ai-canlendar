import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined, SendOutlined } from '@ant-design/icons';
import { Alert, Button, Input, Space } from 'antd';

import { useAgentStore } from '../../stores/agentStore';
import { PlanOptionDeck } from './PlanOptionDeck';

interface AgentChatPanelProps {
  onGenerate: () => Promise<void>;
  onConfirm: () => Promise<void>;
  onRevise: () => Promise<void>;
  onReject: () => void;
  variant?: 'compact' | 'primary';
}

const statusLabel = {
  pending: 'pending',
  running: 'Loading',
  success: 'success',
  failed: 'failed'
};

const statusIcon = {
  pending: <span className="agent-step-dot" />,
  running: <LoadingOutlined className="agent-step-loading" />,
  success: <CheckCircleFilled className="agent-step-success" />,
  failed: <CloseCircleFilled className="agent-step-failed" />
};

export function AgentChatPanel({ onGenerate, onConfirm, onRevise, onReject, variant = 'compact' }: AgentChatPanelProps) {
  const userInput = useAgentStore((state) => state.userInput);
  const revisionInput = useAgentStore((state) => state.revisionInput);
  const runStatus = useAgentStore((state) => state.runStatus);
  const steps = useAgentStore((state) => state.steps);
  const planOptions = useAgentStore((state) => state.planOptions);
  const selectedPlanId = useAgentStore((state) => state.selectedPlanId);
  const conflicts = useAgentStore((state) => state.conflicts);
  const confirmLoading = useAgentStore((state) => state.confirmLoading);
  const setUserInput = useAgentStore((state) => state.setUserInput);
  const setRevisionInput = useAgentStore((state) => state.setRevisionInput);
  const selectPlan = useAgentStore((state) => state.selectPlan);
  const loading = runStatus === 'running';

  return (
    <section className={`panel-block agent-chat-panel ${variant === 'primary' ? 'agent-chat-primary' : ''}`}>
      <div className="panel-title-row">
        <h3>AI 排期对话</h3>
        <span>{runStatus === 'idle' ? '待输入' : runStatus}</span>
      </div>

      <div className="chat-window">
        <div className="chat-message assistant">
          <strong>ChronoAgent</strong>
          <p>告诉我你的目标、截止时间、预计耗时和偏好时间。我会先分析上下文，再给你六张可选方案卡。</p>
        </div>

        {userInput ? (
          <div className="chat-message user">
            <strong>你</strong>
            <p>{userInput}</p>
          </div>
        ) : null}

        {runStatus !== 'idle' ? (
          <div className="chat-message assistant">
            <strong>ChronoAgent</strong>
            <div className="agent-step-list">
              {steps.map((step) => (
                <button className="agent-step-row" key={step.id} type="button">
                  {statusIcon[step.status]}
                  <span>{step.name}</span>
                  <em>{statusLabel[step.status]}</em>
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {planOptions.length > 0 ? (
          <div className="chat-message assistant">
            <strong>ChronoAgent</strong>
            <p>我发给你六张方案卡。默认显示编号牌背；点击后翻到正面查看具体方案和操作按钮，再次点击同一张会翻回编号。</p>
            {conflicts.length > 0 ? <Alert type="warning" showIcon message={`检测到 ${conflicts.length} 个时间冲突，已推荐替代时段`} /> : null}
            <PlanOptionDeck
              plans={planOptions}
              selectedPlanId={selectedPlanId}
              confirmLoading={confirmLoading}
              onSelectPlan={selectPlan}
              onConfirm={onConfirm}
              onRevise={onRevise}
              onReject={onReject}
            />
            <Space className="chat-plan-actions" wrap>
              <Input.TextArea
                rows={3}
                value={revisionInput}
                onChange={(event) => setRevisionInput(event.target.value)}
                placeholder="输入修改意见，例如：周三晚上不要安排，尽量放到周末上午"
              />
              <Button onClick={() => void onRevise()} disabled={confirmLoading || loading}>
                提交修改意见并重新生成
              </Button>
            </Space>
          </div>
        ) : null}
      </div>

      <div className="chat-input-area">
        <Input.TextArea
          value={userInput}
          onChange={(event) => setUserInput(event.target.value)}
          rows={3}
          placeholder="例如：下周五前完成开题报告，预计 10 小时，每天晚上 7 点后安排"
          disabled={loading}
        />
        <Button type="primary" icon={<SendOutlined />} loading={loading} onClick={() => void onGenerate()}>
          {loading ? 'Agent 正在工作...' : '发送'}
        </Button>
      </div>
    </section>
  );
}
