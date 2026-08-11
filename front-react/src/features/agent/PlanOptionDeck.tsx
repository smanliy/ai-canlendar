import { Button, Tag, Typography } from 'antd';
import { useState, type CSSProperties } from 'react';

import type { SchedulePlanOption } from '../../types/agent';
import './PlanOptionDeck.css';

interface PlanOptionDeckProps {
  plans: SchedulePlanOption[];
  selectedPlanId: string | null;
  confirmLoading: boolean;
  onSelectPlan: (planId: string | null) => void;
  onConfirm: () => Promise<void>;
  onRevise: () => Promise<void>;
  onReject: () => void;
}

interface PlanOptionCardProps {
  plan: SchedulePlanOption;
  index: number;
  total: number;
  selected: boolean;
  flipped: boolean;
  hasSelection: boolean;
  confirmLoading: boolean;
  onToggle: () => void;
  onConfirm: () => Promise<void>;
  onRevise: () => Promise<void>;
  onReject: () => void;
}

function PlanOptionCard({
  plan,
  index,
  total,
  selected,
  flipped,
  hasSelection,
  confirmLoading,
  onToggle,
  onConfirm,
  onRevise,
  onReject
}: PlanOptionCardProps) {
  const cardOffset = index - (total - 1) / 2;
  const isCustomPlan = plan.type === 'custom';
  const className = ['deal-plan-card', selected ? 'selected' : '', flipped ? 'flipped' : '', hasSelection && !selected ? 'muted' : ''].join(' ');

  // CSS Variables let the stylesheet fan out, color, and stack any number of cards without hardcoded selectors.
  const cardStyle = {
    '--i': cardOffset,
    '--card-z': index + 1,
    '--card-color': plan.color ?? '#2563EB',
    '--card-accent': plan.accent ?? '#0891B2'
  } as CSSProperties;

  return (
    <button className={className} type="button" onClick={onToggle} style={cardStyle}>
      <div className="deal-card-inner">
        <div className="deal-card-face deal-card-back">
          <span className="deal-card-number">{index + 1}</span>
          <small>{isCustomPlan ? 'Custom' : 'Option'}</small>
        </div>
        <div className="deal-card-face deal-card-front">
          <div className="deal-card-kicker">Option {index + 1}</div>
          <strong>{plan.name}</strong>
          <p>{plan.summary}</p>
          <div className="deal-card-meta">
            <Tag>{plan.totalHours}h</Tag>
            <span>{plan.deadline}</span>
          </div>
          <div className="deal-card-items">
            {isCustomPlan ? (
              <div className="deal-card-custom-copy">
                在下方输入你的修改意见，例如“不要安排上午”或“保留周末”，然后提交重新生成。
              </div>
            ) : (
              plan.items.map((item) => (
                <div key={item.id} className="deal-card-item">
                  <Typography.Text strong>{item.title}</Typography.Text>
                  <span>
                    {item.date} · {item.timeRange} · {item.durationHours}h
                  </span>
                </div>
              ))
            )}
          </div>
          <div className="deal-card-actions" onClick={(event) => event.stopPropagation()}>
            <Button type="primary" size="small" loading={confirmLoading && selected} onClick={() => void (isCustomPlan ? onRevise() : onConfirm())}>
              {isCustomPlan ? '提交修改' : '接受'}
            </Button>
            <Button size="small" danger onClick={onReject}>
              拒绝
            </Button>
          </div>
        </div>
      </div>
    </button>
  );
}

export function PlanOptionDeck({ plans, selectedPlanId, confirmLoading, onSelectPlan, onConfirm, onRevise, onReject }: PlanOptionDeckProps) {
  const [flippedPlanId, setFlippedPlanId] = useState<string | null>(null);
  const hasSelection = Boolean(selectedPlanId);

  const handleTogglePlan = (planId: string) => {
    // Clicking the opened card again resets the whole deck to the colored-number state.
    const nextPlanId = flippedPlanId === planId ? null : planId;
    onSelectPlan(nextPlanId);
    setFlippedPlanId(nextPlanId);
  };

  const handleReject = () => {
    onSelectPlan(null);
    setFlippedPlanId(null);
    onReject();
  };

  return (
    <div className={`deal-plan-stage ${hasSelection ? 'has-selection' : ''}`}>
      {plans.map((plan, index) => (
        <PlanOptionCard
          key={plan.id}
          plan={plan}
          index={index}
          total={plans.length}
          selected={selectedPlanId === plan.id}
          flipped={flippedPlanId === plan.id}
          hasSelection={hasSelection}
          confirmLoading={confirmLoading}
          onToggle={() => handleTogglePlan(plan.id)}
          onConfirm={onConfirm}
          onRevise={onRevise}
          onReject={handleReject}
        />
      ))}
    </div>
  );
}
