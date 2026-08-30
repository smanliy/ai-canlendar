import { GlobalOutlined } from '@ant-design/icons';
import { Button, Input, Tag, Typography } from 'antd';
import { type CSSProperties, type KeyboardEvent, type MouseEvent, useState } from 'react';

import type { SchedulePlanOption } from '../../types/agent';
import './PlanOptionDeck.css';

export interface PlanTextAnnotationPayload {
  planCardId: string;
  regionId: string;
  selectedText: string;
  comment: string;
  path?: string;
  kind?: 'title' | 'summary' | 'reason' | 'block_title' | 'block_note';
}

interface PlanOptionDeckProps {
  plans: SchedulePlanOption[];
  selectedPlanId: string | null;
  confirmLoading: boolean;
  onSelectPlan: (planId: string | null) => void;
  onConfirm: () => Promise<void>;
  onAnnotateText?: (payload: PlanTextAnnotationPayload) => Promise<void>;
  onReject: () => void;
}

interface PlanOptionCardProps {
  plan: SchedulePlanOption;
  index: number;
  selected: boolean;
  hasSelection: boolean;
  confirmLoading: boolean;
  onToggle: () => void;
  onConfirm: () => Promise<void>;
  onReject: () => void;
}

interface TextRegionInfo {
  id: string;
  path: string;
  text: string;
  kind: 'title' | 'summary' | 'reason' | 'block_title' | 'block_note';
}

interface ActiveSelection extends Omit<PlanTextAnnotationPayload, 'comment'> {
  top: number;
  left: number;
}

function trimText(value: string | undefined, maxLength: number) {
  const text = (value ?? '').trim();
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function findRegion(plan: SchedulePlanOption, fallback: TextRegionInfo) {
  return (
    plan.editableTextRegions?.find((region) => region.kind === fallback.kind && region.path === fallback.path) ??
    plan.editableTextRegions?.find((region) => region.kind === fallback.kind && region.text === fallback.text) ??
    fallback
  );
}

function buildRegionData(plan: SchedulePlanOption, fallback: TextRegionInfo) {
  const region = findRegion(plan, fallback);
  return {
    'data-plan-card-id': plan.id,
    'data-region-id': region.id,
    'data-region-path': region.path,
    'data-region-kind': region.kind
  };
}

function PlanOptionCard({
  plan,
  index,
  selected,
  hasSelection,
  confirmLoading,
  onToggle,
  onConfirm,
  onReject
}: PlanOptionCardProps) {
  const isCustomPlan = plan.type === 'custom';
  const className = ['deal-plan-card', selected ? 'selected' : '', hasSelection && !selected ? 'muted' : ''].join(' ');

  const cardStyle = {
    '--card-color': plan.color ?? '#2563EB',
    '--card-accent': plan.accent ?? '#0891B2'
  } as CSSProperties;

  const handleCardKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.key !== 'Enter' && event.key !== ' ') return;
    event.preventDefault();
    onToggle();
  };

  return (
    <div className={className} role="button" tabIndex={0} onClick={onToggle} onKeyDown={handleCardKeyDown} style={cardStyle}>
      <div className="deal-card-inner">
        <div className="deal-card-face deal-card-front">
          <div className="deal-card-kicker">{isCustomPlan ? '调整便签' : `方案 ${index + 1}`}</div>
          <strong
            {...buildRegionData(plan, {
              id: `${plan.id}:title`,
              path: 'name',
              text: plan.name,
              kind: 'title'
            })}
          >
            {plan.name}
          </strong>
          <p
            {...buildRegionData(plan, {
              id: `${plan.id}:summary`,
              path: 'summary',
              text: plan.summary ?? '',
              kind: 'summary'
            })}
          >
            {plan.summary}
          </p>
          <div className="deal-card-meta">
            <Tag>{plan.totalHours}h</Tag>
            <span>{plan.deadline}</span>
          </div>
          <div className="deal-card-items">
            {isCustomPlan ? (
              <div className="deal-card-custom-copy">
                选中需要调整的文字并添加批注。
              </div>
            ) : (
              plan.items.map((item, itemIndex) => (
                <div key={item.id} className="deal-card-item">
                  <Typography.Text
                    strong
                    {...buildRegionData(plan, {
                      id: `${plan.id}:item:${item.id}:title`,
                      path: `items.${itemIndex}.title`,
                      text: item.title,
                      kind: 'block_title'
                    })}
                  >
                    {item.title}
                  </Typography.Text>
                  <span>
                    {item.date} · {item.timeRange} · {item.durationHours}h
                  </span>
                  {item.evidence?.length ? (
                    <div className="deal-card-evidence-list">
                      {item.evidence.slice(0, 2).map((source, sourceIndex) => (
                        <a
                          className="deal-card-evidence"
                          href={source.url}
                          key={`${source.url ?? source.title}-${sourceIndex}`}
                          onClick={(event) => event.stopPropagation()}
                          rel="noreferrer"
                          target="_blank"
                          title={source.url}
                        >
                          <GlobalOutlined />
                          <span>
                            {source.query ? <em>搜索“{trimText(source.query, 28)}”</em> : null}
                            <strong>{trimText(source.title || source.url, 34)}</strong>
                            {source.snippet ? <small>{trimText(source.snippet, 72)}</small> : null}
                          </span>
                        </a>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
          <div className="deal-card-actions" onClick={(event) => event.stopPropagation()}>
            <Button type="primary" size="small" loading={confirmLoading && selected} onClick={() => void onConfirm()}>
              接受
            </Button>
            <Button size="small" danger onClick={onReject}>
              拒绝
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}

function readRegionElement(node: Node | null): HTMLElement | null {
  const element = node instanceof HTMLElement ? node : node?.parentElement;
  return element?.closest<HTMLElement>('[data-plan-card-id][data-region-id]') ?? null;
}

export function PlanOptionDeck({ plans, selectedPlanId, confirmLoading, onSelectPlan, onConfirm, onAnnotateText, onReject }: PlanOptionDeckProps) {
  const hasSelection = Boolean(selectedPlanId);
  const [activeSelection, setActiveSelection] = useState<ActiveSelection | null>(null);
  const [annotationDraft, setAnnotationDraft] = useState('');
  const [annotationOpen, setAnnotationOpen] = useState(false);

  const handleTogglePlan = (planId: string) => {
    const nextPlanId = selectedPlanId === planId ? null : planId;
    onSelectPlan(nextPlanId);
  };

  const handleReject = () => {
    onSelectPlan(null);
    onReject();
  };

  const clearAnnotation = () => {
    setActiveSelection(null);
    setAnnotationDraft('');
    setAnnotationOpen(false);
    window.getSelection()?.removeAllRanges();
  };

  const handleMouseUp = (event: MouseEvent<HTMLDivElement>) => {
    if (!onAnnotateText) return;
    const selection = window.getSelection();
    const selectedText = selection?.toString().trim() ?? '';
    if (!selection || selection.rangeCount === 0 || !selectedText) {
      if (!annotationOpen) setActiveSelection(null);
      return;
    }

    const anchorRegion = readRegionElement(selection.anchorNode);
    const focusRegion = readRegionElement(selection.focusNode);
    if (!anchorRegion || !focusRegion || anchorRegion.dataset.regionId !== focusRegion.dataset.regionId) {
      if (!annotationOpen) setActiveSelection(null);
      return;
    }

    const planCardId = anchorRegion.dataset.planCardId;
    const regionId = anchorRegion.dataset.regionId;
    if (!planCardId || !regionId) return;

    const range = selection.getRangeAt(0);
    const rect = range.getBoundingClientRect();
    setActiveSelection({
      planCardId,
      regionId,
      selectedText,
      path: anchorRegion.dataset.regionPath,
      kind: anchorRegion.dataset.regionKind as ActiveSelection['kind'],
      top: Math.max(12, rect.top - 42),
      left: Math.max(12, Math.min(rect.left + rect.width / 2 - 28, window.innerWidth - 88))
    });
    setAnnotationOpen(false);
    event.stopPropagation();
  };

  const handleSubmitAnnotation = async () => {
    if (!activeSelection || !annotationDraft.trim() || !onAnnotateText) return;
    await onAnnotateText({
      planCardId: activeSelection.planCardId,
      regionId: activeSelection.regionId,
      selectedText: activeSelection.selectedText,
      comment: annotationDraft.trim(),
      path: activeSelection.path,
      kind: activeSelection.kind
    });
    clearAnnotation();
  };

  return (
    <div className={`deal-plan-stage count-${plans.length} ${hasSelection ? 'has-selection' : ''}`} onMouseUp={handleMouseUp}>
      {plans.map((plan, index) => (
        <PlanOptionCard
          key={plan.id}
          plan={plan}
          index={index}
          selected={selectedPlanId === plan.id}
          hasSelection={hasSelection}
          confirmLoading={confirmLoading}
          onToggle={() => handleTogglePlan(plan.id)}
          onConfirm={onConfirm}
          onReject={handleReject}
        />
      ))}
      {activeSelection ? (
        <div
          className="deal-annotation-popover"
          style={{ top: activeSelection.top, left: activeSelection.left }}
          onClick={(event) => event.stopPropagation()}
        >
          {annotationOpen ? (
            <div className="deal-annotation-editor">
              <Input.TextArea
                autoFocus
                rows={3}
                value={annotationDraft}
                onChange={(event) => setAnnotationDraft(event.target.value)}
                placeholder="写下这段的修改意见"
              />
              <div className="deal-annotation-editor-actions">
                <Button size="small" onClick={clearAnnotation}>
                  取消
                </Button>
                <Button size="small" type="primary" disabled={!annotationDraft.trim()} onClick={() => void handleSubmitAnnotation()}>
                  提交
                </Button>
              </div>
            </div>
          ) : (
            <Button size="small" type="primary" onClick={() => setAnnotationOpen(true)}>
              批注
            </Button>
          )}
        </div>
      ) : null}
    </div>
  );
}
