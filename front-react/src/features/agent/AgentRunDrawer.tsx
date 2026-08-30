import { Drawer, Descriptions } from 'antd';

import { useAgentStore } from '../../stores/agentStore';
import type { TokenUsage } from '../../types/agent';
import type { AgentRunStep } from '../../types/agent';

interface AgentRunDrawerProps {
  open: boolean;
  step: AgentRunStep | null;
  onClose: () => void;
}

const stringify = (value: unknown) => JSON.stringify(value ?? {}, null, 2);

function readUsage(step: AgentRunStep): TokenUsage | null {
  const fromStep = step.llmUsage;
  if (fromStep) return fromStep;
  if (!step.output || typeof step.output !== 'object') return null;
  const usage = (step.output as { llmUsage?: TokenUsage | null }).llmUsage ?? null;
  return usage;
}

export function AgentRunDrawer({ open, step, onClose }: AgentRunDrawerProps) {
  const currentRunId = useAgentStore((state) => state.currentRunId);
  const runStatus = useAgentStore((state) => state.runStatus);
  const userInput = useAgentStore((state) => state.userInput);
  const usage = step ? readUsage(step) : null;

  return (
    <Drawer title="Agent Run 详情" open={open} onClose={onClose} width={520}>
      {step ? (
        <div className="run-drawer-body">
          <Descriptions column={1} size="small" bordered>
            <Descriptions.Item label="RunId">{currentRunId ?? '未生成'}</Descriptions.Item>
            <Descriptions.Item label="当前状态">{runStatus}</Descriptions.Item>
            <Descriptions.Item label="用户原始输入">{userInput || '暂无输入'}</Descriptions.Item>
            <Descriptions.Item label="当前节点名称">{step.name}</Descriptions.Item>
            <Descriptions.Item label="LLM Token">
              {usage ? `${usage.promptTokens}/${usage.completionTokens}/${usage.totalTokens}` : '无'}
            </Descriptions.Item>
            <Descriptions.Item label="错误信息">{step.error ?? '无'}</Descriptions.Item>
            <Descriptions.Item label="创建时间">{step.createdAt}</Descriptions.Item>
            <Descriptions.Item label="更新时间">{step.updatedAt}</Descriptions.Item>
          </Descriptions>
          <section>
            <h4>节点输入 JSON</h4>
            <pre>{stringify(step.input)}</pre>
          </section>
          <section>
            <h4>节点输出 JSON</h4>
            <pre>{stringify(step.output)}</pre>
          </section>
        </div>
      ) : null}
    </Drawer>
  );
}
