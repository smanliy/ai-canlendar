import {
  DatabaseOutlined,
  LoadingOutlined,
  PlusOutlined,
  ReloadOutlined,
  StopOutlined
} from '@ant-design/icons';
import { Alert, Button, Input, Popconfirm, Select, Space, Spin, Switch, Table, Tag, Tabs, Timeline, message } from 'antd';
import dayjs from 'dayjs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import { agentApi } from '../services/agentApi';
import { eventApi } from '../services/eventApi';
import type { AgentCheckpoint, AgentJob, AgentJobDetail, AgentJobEvent, AgentJobStatus } from '../types/agent';
import { listenAgentJobCreated } from '../utils/agentJobEvents';

interface AgentOpsPageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

const { TextArea } = Input;

const STATUS_LABEL: Record<AgentJobStatus, string> = {
  queued: '排队中',
  running: '执行中',
  waiting_user: '待确认',
  succeeded: '已完成',
  failed: '失败',
  canceled: '已取消'
};

const STATUS_COLOR: Record<AgentJobStatus, string> = {
  queued: 'gold',
  running: 'processing',
  waiting_user: 'orange',
  succeeded: 'green',
  failed: 'red',
  canceled: 'default'
};

function formatDateTime(value: string | null | undefined) {
  if (!value) return '—';
  return dayjs(value).format('YYYY-MM-DD HH:mm:ss');
}

function typeLabel(value: string) {
  if (value === 'schedule_plan') return 'schedule plan';
  if (value === 'resume_decision') return 'resume decision';
  if (value === 'annotate_plan') return 'annotate plan';
  return value;
}

function safeStringify(value: unknown) {
  try {
    return JSON.stringify(value ?? null, null, 2);
  } catch {
    return String(value);
  }
}

function summarizeInput(value: unknown) {
  if (!value || typeof value !== 'object') return safeStringify(value);
  const record = value as Record<string, unknown>;
  const input = typeof record.input === 'string' ? record.input : '';
  const clarification = record.clarificationJson && typeof record.clarificationJson === 'object' ? '含 clarificationJson' : '';
  return `${input || 'JSON payload'}${clarification ? ` · ${clarification}` : ''}`;
}

function checkpointTypeLabel(checkpoint: AgentCheckpoint | null) {
  if (!checkpoint) return '无 checkpoint';
  const labels: Record<AgentCheckpoint['type'], string> = {
    required_fields: '补全字段',
    schedule_decision: '排期决策',
    conflict_decision: '冲突决策',
    final_confirm: '最终确认',
    annotation_review: '批注复核'
  };
  return labels[checkpoint.type];
}

function eventTone(event: AgentJobEvent) {
  if (event.level === 'error') return 'error';
  if (event.level === 'warn') return 'warning';
  return 'default';
}

export function AgentOpsPage({ activePage, onNavigate }: AgentOpsPageProps) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [selectedJobId, setSelectedJobId] = useState<string | null>(null);
  const [selectedJob, setSelectedJob] = useState<AgentJobDetail | null>(null);
  const [events, setEvents] = useState<AgentJobEvent[]>([]);
  const [loadingJobs, setLoadingJobs] = useState(true);
  const [loadingDetail, setLoadingDetail] = useState(false);
  const [creating, setCreating] = useState(false);
  const [filterStatus, setFilterStatus] = useState<AgentJobStatus | 'all'>('all');
  const [query, setQuery] = useState('');
  const [sampleInput, setSampleInput] = useState('帮我安排明天下午 2 小时复习，优先放在黄金时间。');
  const [forceNew, setForceNew] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const streamingJobRef = useRef<string | null>(null);

  const filteredJobs = useMemo(() => {
    const text = query.trim().toLowerCase();
    return jobs.filter((job) => {
      if (filterStatus !== 'all' && job.status !== filterStatus) return false;
      if (!text) return true;
      const blob = [
        job.id,
        job.runId,
        job.type,
        job.status,
        job.idempotencyKey ?? '',
        summarizeInput(job.input)
      ]
        .join(' ')
        .toLowerCase();
      return blob.includes(text);
    });
  }, [filterStatus, jobs, query]);

  const summary = useMemo(() => {
    const total = jobs.length;
    const queued = jobs.filter((job) => job.status === 'queued').length;
    const running = jobs.filter((job) => job.status === 'running').length;
    const waiting = jobs.filter((job) => job.status === 'waiting_user').length;
    const failed = jobs.filter((job) => job.status === 'failed').length;
    return { total, queued, running, waiting, failed };
  }, [jobs]);

  const loadJobs = useCallback(
    async (keepSelection = true, silent = false) => {
      if (!silent) {
        setLoadingJobs(true);
      }
      setError(null);
      try {
        const nextJobs = await agentApi.listJobs();
        setJobs(nextJobs);
        setSelectedJobId((current) => {
          if (keepSelection && current && nextJobs.some((job) => job.id === current)) {
            return current;
          }
          return nextJobs[0]?.id ?? null;
        });
      } catch (loadError) {
        const messageText = loadError instanceof Error ? loadError.message : '加载任务队列失败';
        setError(messageText);
      } finally {
        if (!silent) {
          setLoadingJobs(false);
        }
      }
    },
    []
  );

  const loadDetail = useCallback(async (jobId: string, silent = false) => {
    if (!silent) {
      setLoadingDetail(true);
    }
    setError(null);
    try {
      const [job, jobEvents] = await Promise.all([agentApi.getJob(jobId), agentApi.listJobEvents(jobId)]);
      setSelectedJob(job);
      setEvents(jobEvents);
    } catch (loadError) {
      const messageText = loadError instanceof Error ? loadError.message : '加载任务详情失败';
      setError(messageText);
      setSelectedJob(null);
      setEvents([]);
    } finally {
      if (!silent) {
        setLoadingDetail(false);
      }
    }
  }, []);

  const upsertJob = useCallback((job: AgentJob) => {
    setJobs((current) => {
      const next = current.some((item) => item.id === job.id)
        ? current.map((item) => (item.id === job.id ? { ...item, ...job } : item))
        : [job, ...current];
      return next.sort((left, right) => right.createdAt.localeCompare(left.createdAt));
    });
  }, []);

  useEffect(() => {
    void loadJobs();
  }, [loadJobs]);

  useEffect(() => {
    if (!selectedJobId) {
      setSelectedJob(null);
      setEvents([]);
      return;
    }
    void loadDetail(selectedJobId);
  }, [loadDetail, selectedJobId]);

  useEffect(() => {
    if (!selectedJobId && filteredJobs.length > 0) {
      setSelectedJobId(filteredJobs[0].id);
    }
  }, [filteredJobs, selectedJobId]);

  useEffect(() => listenAgentJobCreated((job) => {
    upsertJob(job);
    if (!selectedJobId) {
      setSelectedJobId(job.id);
    }
  }), [selectedJobId, upsertJob]);

  useEffect(() => {
    if (!selectedJobId || !selectedJob) {
      return;
    }

    if (['succeeded', 'failed', 'canceled'].includes(selectedJob.status)) {
      streamingJobRef.current = null;
      return;
    }

    if (streamingJobRef.current === selectedJobId) {
      return;
    }

    streamingJobRef.current = selectedJobId;
    const controller = new AbortController();
    let active = true;

    void agentApi
      .streamJobEvents(
        selectedJobId,
        (eventName, payload) => {
          if (!active) return;

          if (eventName === 'job:state') {
            const nextJob = payload as AgentJobDetail;
            setSelectedJob(nextJob);
            setJobs((current) => current.map((item) => (item.id === nextJob.id ? { ...item, ...nextJob } : item)));
            return;
          }

          if (eventName === 'done') {
            void loadDetail(selectedJobId, true);
            void loadJobs(true, true);
            return;
          }

          if (eventName === 'error') {
            const payloadRecord = payload as { message?: string };
            setError(payloadRecord.message ?? '读取 job 事件流失败');
            return;
          }

          const record = payload as AgentJobEvent;
          setEvents((current) => {
            if (current.some((item) => item.id === record.id)) {
              return current;
            }
            return [...current, record].sort((left, right) => left.createdAt.localeCompare(right.createdAt));
          });

          if (eventName === 'job:waiting_user' || eventName === 'job:succeeded' || eventName === 'job:failed') {
            void loadDetail(selectedJobId, true);
            void loadJobs(true, true);
          }
        },
        controller.signal
      )
      .catch((streamError) => {
        if (controller.signal.aborted) return;
        streamingJobRef.current = null;
        setError(streamError instanceof Error ? streamError.message : '读取 job 事件流失败');
      });

    return () => {
      active = false;
      controller.abort();
      streamingJobRef.current = null;
    };
  }, [loadDetail, loadJobs, selectedJob, selectedJobId]);

  const handleCreateSampleJob = async () => {
    setCreating(true);
    try {
      const created = await agentApi.createJob({ input: sampleInput, forceNew });
      upsertJob(created);
      message.success('测试任务已创建');
      setSelectedJobId(created.id);
    } catch (createError) {
      message.error(createError instanceof Error ? createError.message : '创建任务失败');
    } finally {
      setCreating(false);
    }
  };

  const handleCancelJob = async () => {
    if (!selectedJob) return;
    try {
      await agentApi.cancelJob(selectedJob.id);
      message.success('任务已取消');
      await loadJobs(true);
    } catch (cancelError) {
      message.error(cancelError instanceof Error ? cancelError.message : '取消任务失败');
    }
  };

  const handleUndoAgentRun = async () => {
    if (!selectedJob?.runId) return;
    try {
      const data = await eventApi.undoAgentRunEvents(selectedJob.runId);
      message.success(`已撤销 ${data.affectedCount} 条 Agent 日程`);
      await loadJobs(true);
      if (selectedJobId) {
        await loadDetail(selectedJobId, true);
      }
    } catch (undoError) {
      message.error(undoError instanceof Error ? undoError.message : '撤销 Agent 日程失败');
    }
  };

  const columns = [
    {
      title: '状态',
      dataIndex: 'status',
      width: 110,
      render: (value: AgentJobStatus) => <Tag color={STATUS_COLOR[value]}>{STATUS_LABEL[value]}</Tag>
    },
    {
      title: '类型',
      dataIndex: 'type',
      width: 130,
      render: (value: string) => <span className="ops-mono">{typeLabel(value)}</span>
    },
    {
      title: 'RunId',
      dataIndex: 'runId',
      width: 170,
      render: (value: string) => <span className="ops-mono">{value}</span>
    },
    {
      title: '任务摘要',
      dataIndex: 'input',
      render: (value: unknown) => <span className="ops-summary">{summarizeInput(value)}</span>
    },
    {
      title: '尝试',
      dataIndex: 'attempt',
      width: 90,
      render: (_: number, record: AgentJob) => `${record.attempt}/${record.maxAttempts}`
    },
    {
      title: '更新时间',
      dataIndex: 'updatedAt',
      width: 170,
      render: (value: string) => formatDateTime(value)
    }
  ];

  const rawJobJson = useMemo(
    () =>
      selectedJob
        ? safeStringify(selectedJob)
        : '{}',
    [selectedJob]
  );
  const rawCheckpointJson = useMemo(
    () => safeStringify(selectedJob?.checkpoint ?? null),
    [selectedJob?.checkpoint]
  );
  const rawEventsJson = useMemo(
    () => safeStringify(events),
    [events]
  );

  return (
    <AppLayout
      activePage={activePage}
      title="Agent 队列"
      subtitle="真实读取 AgentJob、AgentCheckpoint、AgentJobEvent"
      showCalendarControls={false}
      onNavigate={onNavigate}
      onToday={() => undefined}
      onPrev={() => undefined}
      onNext={() => undefined}
      onCreate={() => undefined}
    >
      <main className="agent-ops-main">
        <section className="ops-band">
          <div className="ops-band-copy">
            <div className="ops-kicker">
              <DatabaseOutlined />
              <span>queue inspector</span>
            </div>
            <h3>直接看后台真实记录</h3>
            <p>这里读的是后端接口里的真实任务队列，不是前端模拟状态。你可以用它核对任务是否入库、checkpoint 是否挂起、事件是否写出，以及撤销是否留痕。</p>
          </div>
          <div className="ops-band-stats">
            <div>
              <strong>{summary.total}</strong>
              <span>总任务</span>
            </div>
            <div>
              <strong>{summary.queued}</strong>
              <span>排队中</span>
            </div>
            <div>
              <strong>{summary.running}</strong>
              <span>执行中</span>
            </div>
            <div>
              <strong>{summary.waiting}</strong>
              <span>待确认</span>
            </div>
            <div>
              <strong>{summary.failed}</strong>
              <span>失败</span>
            </div>
          </div>
        </section>

        {error ? (
          <Alert
            type="error"
            showIcon
            message="加载失败"
            description={error}
            action={
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
                重试
              </Button>
            }
          />
        ) : null}

        <section className="ops-grid">
          <div className="ops-list-pane">
            <div className="ops-toolbar">
              <Space wrap>
                <Input.Search
                  allowClear
                  value={query}
                  placeholder="搜索 runId / 类型 / 摘要"
                  onChange={(event) => setQuery(event.target.value)}
                  onSearch={(value) => setQuery(value)}
                  style={{ width: 280 }}
                />
                <Select
                  value={filterStatus}
                  style={{ width: 150 }}
                  options={[
                    { label: '全部状态', value: 'all' },
                    { label: '排队中', value: 'queued' },
                    { label: '执行中', value: 'running' },
                    { label: '待确认', value: 'waiting_user' },
                    { label: '已完成', value: 'succeeded' },
                    { label: '失败', value: 'failed' },
                    { label: '已取消', value: 'canceled' }
                  ]}
                  onChange={(value) => setFilterStatus(value)}
                />
                <TextArea
                  value={sampleInput}
                  onChange={(event) => setSampleInput(event.target.value)}
                  autoSize={{ minRows: 1, maxRows: 3 }}
                  className="ops-sample-input"
                  placeholder="输入一个示例任务"
                />
                <Space align="center" className="ops-force-row">
                  <Switch checked={forceNew} onChange={setForceNew} />
                  <span>强制新建</span>
                </Space>
                <Button type="primary" icon={<PlusOutlined />} loading={creating} onClick={() => void handleCreateSampleJob()}>
                  创建测试任务
                </Button>
                <Button icon={<ReloadOutlined />} onClick={() => void loadJobs()}>
                  刷新队列
                </Button>
              </Space>
            </div>

            <div className="ops-table-wrap">
              <Table
                rowKey="id"
                loading={loadingJobs}
                dataSource={filteredJobs}
                columns={columns}
                pagination={false}
                size="middle"
                rowClassName={(record) => (record.id === selectedJobId ? 'is-selected' : '')}
                onRow={(record) => ({
                  onClick: () => setSelectedJobId(record.id)
                })}
                scroll={{ y: 'calc(100vh - 320px)' }}
              />
            </div>
          </div>

          <div className="ops-detail-pane">
            <div className="ops-detail-head">
              <div>
                <div className="ops-detail-kicker">selected job</div>
                <h3>{selectedJob ? selectedJob.id : '未选择任务'}</h3>
                <p>{selectedJob ? `${STATUS_LABEL[selectedJob.status]} · ${typeLabel(selectedJob.type)} · ${selectedJob.runId}` : '从左侧点一个任务，看真实数据库内容。'}</p>
              </div>
              <Space wrap>
                <Button icon={<ReloadOutlined />} onClick={() => selectedJobId ? void loadDetail(selectedJobId) : void loadJobs(true)} disabled={loadingDetail}>
                  刷新详情
                </Button>
                <Button
                  onClick={() => void handleUndoAgentRun()}
                  disabled={!selectedJob?.runId}
                >
                  撤销本次写入
                </Button>
                <Popconfirm
                  title="取消这个任务？"
                  description="只会把任务状态标为 canceled，不会删除记录。"
                  okText="取消任务"
                  cancelText="不取消"
                  onConfirm={() => void handleCancelJob()}
                  disabled={!selectedJob || !['queued', 'running', 'waiting_user'].includes(selectedJob.status)}
                >
                  <Button danger icon={<StopOutlined />} disabled={!selectedJob || !['queued', 'running', 'waiting_user'].includes(selectedJob.status)}>
                    取消任务
                  </Button>
                </Popconfirm>
              </Space>
            </div>

            {loadingDetail && !selectedJob ? (
              <div className="ops-loading">
                <Spin indicator={<LoadingOutlined style={{ fontSize: 24 }} spin />} />
                <span>正在读取任务详情...</span>
              </div>
            ) : null}

            {selectedJob ? (
              <>
                <div className="ops-meta-grid">
                  <div>
                    <span>状态</span>
                    <Tag color={STATUS_COLOR[selectedJob.status]}>{STATUS_LABEL[selectedJob.status]}</Tag>
                  </div>
                  <div>
                    <span>尝试次数</span>
                    <strong>{selectedJob.attempt} / {selectedJob.maxAttempts}</strong>
                  </div>
                  <div>
                    <span>锁定者</span>
                    <strong className="ops-mono">{selectedJob.lockedBy ?? '未锁定'}</strong>
                  </div>
                  <div>
                    <span>开始 / 结束</span>
                    <strong>{formatDateTime(selectedJob.startedAt)} / {formatDateTime(selectedJob.finishedAt)}</strong>
                  </div>
                </div>

                <Tabs
                  defaultActiveKey="overview"
                  items={[
                    {
                      key: 'overview',
                      label: '概览',
                      children: (
                        <div className="ops-overview">
                          <div className="ops-section">
                            <h4>任务字段</h4>
                            <dl className="ops-dl">
                              <div>
                                <dt>Job ID</dt>
                                <dd className="ops-mono">{selectedJob.id}</dd>
                              </div>
                              <div>
                                <dt>Run ID</dt>
                                <dd className="ops-mono">{selectedJob.runId}</dd>
                              </div>
                              <div>
                                <dt>User ID</dt>
                                <dd className="ops-mono">{selectedJob.userId}</dd>
                              </div>
                              <div>
                                <dt>优先级</dt>
                                <dd>{selectedJob.priority}</dd>
                              </div>
                              <div>
                                <dt>idempotencyKey</dt>
                                <dd className="ops-mono">{selectedJob.idempotencyKey ?? '—'}</dd>
                              </div>
                              <div>
                                <dt>错误</dt>
                                <dd>{selectedJob.error ?? '—'}</dd>
                              </div>
                            </dl>
                          </div>

                          <div className="ops-section">
                            <h4>Checkpoint</h4>
                            {selectedJob.checkpoint ? (
                              <>
                                <div className="ops-inline-summary">
                                  <Tag color="gold">{checkpointTypeLabel(selectedJob.checkpoint)}</Tag>
                                  <Tag>{selectedJob.checkpoint.status}</Tag>
                                  <span>version {selectedJob.checkpoint.version}</span>
                                </div>
                                <dl className="ops-dl">
                                  <div>
                                    <dt>Step</dt>
                                    <dd>{selectedJob.checkpoint.stepName}</dd>
                                  </div>
                                  <div>
                                    <dt>Prompt</dt>
                                    <dd>{selectedJob.checkpoint.prompt}</dd>
                                  </div>
                                  <div>
                                    <dt>Expires</dt>
                                    <dd>{formatDateTime(selectedJob.checkpoint.expiresAt)}</dd>
                                  </div>
                                  <div>
                                    <dt>Resolved</dt>
                                    <dd>{formatDateTime(selectedJob.checkpoint.resolvedAt)}</dd>
                                  </div>
                                </dl>
                              </>
                            ) : (
                              <p className="ops-empty">当前没有 pending checkpoint。</p>
                            )}
                          </div>
                        </div>
                      )
                    },
                    {
                      key: 'json',
                      label: '原始 JSON',
                      children: (
                        <div className="ops-json-grid">
                          <section>
                            <h4>Job</h4>
                            <pre>{rawJobJson}</pre>
                          </section>
                          <section>
                            <h4>Checkpoint</h4>
                            <pre>{rawCheckpointJson}</pre>
                          </section>
                          <section>
                            <h4>Events</h4>
                            <pre>{rawEventsJson}</pre>
                          </section>
                        </div>
                      )
                    },
                    {
                      key: 'events',
                      label: `事件流 (${events.length})`,
                      children: (
                        <Timeline
                          items={events.map((event) => ({
                            color: eventTone(event),
                            children: (
                              <div className="ops-event">
                                <div className="ops-event-head">
                                  <strong>{event.type}</strong>
                                  <span>{formatDateTime(event.createdAt)}</span>
                                </div>
                                <p>{event.message ?? '—'}</p>
                                <div className="ops-event-meta">
                                  <Tag>{event.level}</Tag>
                                  {event.stepId ? <Tag>{event.stepId}</Tag> : null}
                                  {event.durationMs !== null ? <Tag>{event.durationMs} ms</Tag> : null}
                                </div>
                              </div>
                            )
                          }))}
                        />
                      )
                    }
                  ]}
                />
              </>
            ) : (
              <div className="ops-empty-state">
                <DatabaseOutlined />
                <span>没有可看的任务。先点“创建测试任务”，或者去后台跑一次 Agent。</span>
              </div>
            )}
          </div>
        </section>
      </main>
    </AppLayout>
  );
}
