import { CheckCircleFilled, CloseCircleFilled, LoadingOutlined } from '@ant-design/icons';
import { Timeline } from 'antd';

import type { AgentRunStep } from '../../types/agent';

interface AgentRunTimelineProps {
  steps: AgentRunStep[];
  onStepClick: (step: AgentRunStep) => void;
}

const dotByStatus = {
  pending: <span className="timeline-dot pending" />,
  running: <LoadingOutlined className="timeline-running" />,
  success: <CheckCircleFilled className="timeline-success" />,
  failed: <CloseCircleFilled className="timeline-failed" />
};

export function AgentRunTimeline({ steps, onStepClick }: AgentRunTimelineProps) {
  return (
    <section className="panel-block timeline-block">
      <div className="panel-title-row">
        <h3>Agent 执行过程</h3>
      </div>
      <Timeline
        className="agent-timeline"
        items={steps.map((step) => ({
          dot: dotByStatus[step.status],
          children: (
            <button className="timeline-step" type="button" onClick={() => onStepClick(step)}>
              <span>{step.name}</span>
              <em>{step.status}</em>
            </button>
          )
        }))}
      />
    </section>
  );
}
