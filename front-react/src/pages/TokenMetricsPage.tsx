import { ReloadOutlined } from '@ant-design/icons';
import { Button, Spin, message } from 'antd';
import * as echarts from 'echarts';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { AppLayout } from '../layouts/AppLayout';
import type { AppPageKey } from '../layouts/Sidebar';
import { agentApi } from '../services/agentApi';
import type { AgentTokenMetricsSnapshot, AgentTurnTokenMetric } from '../types/agent';
import { AGENT_TOKEN_METRICS_CLEAR_AT_KEY, listenAgentTokenMetricsCleared } from '../utils/agentJobEvents';

interface TokenMetricsPageProps {
  activePage: AppPageKey;
  onNavigate: (page: AppPageKey) => void;
}

type TokenChartRow = Partial<AgentTurnTokenMetric> & {
  turnId: number;
  baselineTokens: number;
  compressedTokens: number;
};

function formatNumber(value: number) {
  return new Intl.NumberFormat('zh-CN').format(Math.round(value));
}

function formatPercent(value: number) {
  return `${Math.round(value * 100)}%`;
}

function compactLabel(type: string) {
  if (type === 'manual') return '手动压缩';
  if (type === 'micro') return '空闲压缩';
  return '阈值压缩';
}

function isEffectiveCompactEvent(sample: AgentTurnTokenMetric | TokenChartRow) {
  return Boolean(
    sample.compactEvent &&
      sample.compactEvent.triggerType !== 'micro' &&
      (sample.phase === 'manualCompact' || sample.compactEvent.savedTokens > 0 || sample.compactEvent.beforeTokens !== sample.compactEvent.afterTokens)
  );
}

function formatCompactText(sample: TokenChartRow) {
  if (!sample.compactEvent || !isEffectiveCompactEvent(sample)) return '';
  const usageText = sample.compactEvent.llmUsage ? `；压缩调用消耗 ${formatNumber(sample.compactEvent.llmUsage.totalTokens)} tokens` : '';
  return `${compactLabel(sample.compactEvent.triggerType)} ${formatNumber(sample.compactEvent.beforeTokens)} -> ${formatNumber(sample.compactEvent.afterTokens)}${usageText}`;
}

function TokenLineChart({ samples }: { samples: AgentTurnTokenMetric[] }) {
  const chartRef = useRef<HTMLDivElement | null>(null);
  const chartInstanceRef = useRef<echarts.ECharts | null>(null);
  const chartRowsRef = useRef<TokenChartRow[]>([]);
  const chartRows = useMemo(() => {
    const originRow: TokenChartRow = {
      turnId: 0,
      baselineTokens: 0,
      compressedTokens: 0
    };

    if (samples.length === 0) {
      return [originRow];
    }

    const firstCompactIndex = samples.findIndex((sample) => isEffectiveCompactEvent(sample));

    let previousBaselineTokens = 0;

    const measuredRows = samples.map<TokenChartRow>((sample, index) => {
      const isCompactPoint = isEffectiveCompactEvent(sample);
      const compressedTokens = isCompactPoint ? sample.compactEvent?.afterTokens ?? sample.compressedContextTokens : sample.compressedContextTokens;
      const hasCompacted = firstCompactIndex >= 0 && index >= firstCompactIndex;
      const rawBaselineTokens = hasCompacted ? sample.baselineContextTokens : compressedTokens;
      const baselineTokens = Math.max(previousBaselineTokens, rawBaselineTokens, compressedTokens);
      previousBaselineTokens = baselineTokens;

      return {
        ...sample,
        compactEvent: isCompactPoint ? sample.compactEvent : undefined,
        baselineTokens,
        compressedTokens
      };
    });

    return [originRow, ...measuredRows];
  }, [samples]);
  const compactPoints = useMemo(
    () =>
      chartRows
        .map((row, index) => ({ row, index }))
        .filter(({ row }) => Boolean(row.compactEvent))
        .map(({ row, index }) => ({
          value: [row.turnId, row.compressedTokens],
          rowIndex: index,
          compactType: row.compactEvent?.triggerType ?? 'auto'
        })),
    [chartRows]
  );
  const compactMarkLines = useMemo(
    () =>
      compactPoints.map((point) => ({
        xAxis: point.value[0],
        label: compactLabel(point.compactType)
      })),
    [compactPoints]
  );
  const maxTurn = Math.max(1, ...chartRows.map((row) => row.turnId));

  useEffect(() => {
    chartRowsRef.current = chartRows;
  }, [chartRows]);

  useEffect(() => {
    if (!chartRef.current) return undefined;

    const chart = echarts.init(chartRef.current);
    chartInstanceRef.current = chart;
    const resizeObserver = new ResizeObserver(() => chart.resize());
    resizeObserver.observe(chartRef.current);

    chart.setOption({
      animationDuration: 500,
      color: ['#c45d46', '#2f7a58', '#24322b'],
      grid: {
        top: 42,
        right: 34,
        bottom: 54,
        left: 72
      },
      legend: {
        bottom: 10,
        itemWidth: 22,
        itemHeight: 8,
        textStyle: {
          color: '#62583f',
          fontWeight: 650
        }
      },
      tooltip: {
        trigger: 'axis',
        confine: true,
        axisPointer: {
          type: 'line',
          lineStyle: {
            color: 'rgba(36, 50, 43, 0.35)',
            type: 'dashed'
          }
        },
        formatter: (params: unknown) => {
          const items = Array.isArray(params) ? (params as Array<{ dataIndex: number; marker: string; seriesName: string; value: [number, number] }>) : [];
          const row = chartRowsRef.current[items[0]?.dataIndex ?? 0];
          if (!row) return '';
          const lines = [
            row.turnId === 0 ? '初始时刻' : `第 ${row.turnId} 轮`,
            ...items.map((item) => `${item.marker}${item.seriesName}：${formatNumber(item.value[1])} tokens`)
          ];
          if (row.compactEvent) {
            lines.push(
              `${compactLabel(row.compactEvent.triggerType)}：${formatNumber(row.compactEvent.beforeTokens)} -> ${formatNumber(row.compactEvent.afterTokens)}`,
              `节省：${formatNumber(row.compactEvent.savedTokens)} tokens (${formatPercent(row.compactEvent.savedRatio)})`
            );
            if (row.compactEvent.llmUsage) {
              lines.push(`压缩调用：${formatNumber(row.compactEvent.llmUsage.totalTokens)} tokens`);
            }
          }
          return lines.join('<br/>');
        }
      },
      xAxis: {
        type: 'value',
        name: '轮数',
        nameGap: 28,
        min: 0,
        max: maxTurn,
        interval: Math.max(1, Math.ceil(maxTurn / 7)),
        axisLabel: {
          color: '#806b45',
          formatter: (value: number) => `第${Math.round(value)}轮`
        },
        axisLine: {
          lineStyle: {
            color: 'rgba(84, 67, 21, 0.42)'
          }
        },
        axisTick: {
          alignWithLabel: true
        }
      },
      yAxis: {
        type: 'value',
        name: '上下文 token',
        min: 0,
        splitLine: {
          lineStyle: {
            color: 'rgba(128, 107, 69, 0.16)'
          }
        },
        axisLabel: {
          color: '#806b45',
          formatter: (value: number) => formatNumber(value)
        }
      },
      series: [
        {
          name: '未压缩估算',
          type: 'line',
          smooth: false,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: {
            width: 3
          },
          data: chartRows.map((row) => [row.turnId, row.baselineTokens]),
          markPoint:
            samples.length === 0
              ? {
                  symbol: 'path://M512 128c-123.7 0-224 100.3-224 224 0 91.7 55.1 170.5 134 205.1V640h-70c-13.3 0-24 10.7-24 24s10.7 24 24 24h320c13.3 0 24-10.7 24-24s-10.7-24-24-24h-70v-82.9c78.9-34.6 134-113.4 134-205.1 0-123.7-100.3-224-224-224zm0 64c88.4 0 160 71.6 160 160s-71.6 160-160 160-160-71.6-160-160 71.6-160 160-160z',
                  symbolSize: 58,
                  itemStyle: {
                    color: '#d7c7a3'
                  },
                  label: {
                    show: true,
                    formatter: '暂无数据',
                    position: 'bottom',
                    color: '#806b45',
                    fontWeight: 700
                  },
                  data: [{ coord: [0, 0] }]
                }
              : undefined
        },
        {
          name: '压缩后实际',
          type: 'line',
          smooth: false,
          symbol: 'circle',
          symbolSize: 7,
          lineStyle: {
            width: 3
          },
          data: chartRows.map((row) => [row.turnId, row.compressedTokens]),
          markLine:
            compactMarkLines.length > 0
              ? {
                  symbol: 'none',
                  silent: true,
                  label: {
                    show: true,
                    formatter: (params: { data?: { label?: string } }) => params.data?.label ?? '',
                    position: 'insideEndTop',
                    color: '#24322b',
                    fontSize: 11,
                    fontWeight: 760,
                    padding: [2, 6],
                    backgroundColor: 'rgba(255, 252, 244, 0.9)',
                    borderColor: 'rgba(36, 50, 43, 0.18)',
                    borderWidth: 1,
                    borderRadius: 4
                  },
                  lineStyle: {
                    color: 'rgba(36, 50, 43, 0.42)',
                    type: 'dashed',
                    width: 1.5
                  },
                  data: compactMarkLines
                }
              : undefined
        },
        {
          name: '压缩点',
          type: 'scatter',
          symbol: 'pin',
          symbolSize: 44,
          label: {
            show: true,
            formatter: (params: { data: { rowIndex: number } }) => compactLabel(chartRowsRef.current[params.data.rowIndex]?.compactEvent?.triggerType ?? 'auto'),
            position: 'top',
            color: '#24322b',
            fontSize: 11,
            fontWeight: 760
          },
          itemStyle: {
            color: (params: { data: { compactType?: string } }) => (params.data.compactType === 'manual' ? '#8f4ad8' : '#2563eb')
          },
          tooltip: {
            trigger: 'item',
            formatter: (params: { data: { rowIndex: number } }) => formatCompactText(chartRowsRef.current[params.data.rowIndex])
          },
          data: compactPoints
        }
      ]
    });

    return () => {
      resizeObserver.disconnect();
      chart.dispose();
      chartInstanceRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartInstanceRef.current;
    if (!chart) return;

    chart.setOption(
      {
        xAxis: {
          max: maxTurn,
          interval: Math.max(1, Math.ceil(maxTurn / 7))
        },
        series: [
          {
            data: chartRows.map((row) => [row.turnId, row.baselineTokens]),
            markPoint:
              samples.length === 0
                ? {
                    symbol: 'path://M512 128c-123.7 0-224 100.3-224 224 0 91.7 55.1 170.5 134 205.1V640h-70c-13.3 0-24 10.7-24 24s10.7 24 24 24h320c13.3 0 24-10.7 24-24s-10.7-24-24-24h-70v-82.9c78.9-34.6 134-113.4 134-205.1 0-123.7-100.3-224-224-224zm0 64c88.4 0 160 71.6 160 160s-71.6 160-160 160-160-71.6-160-160 71.6-160 160-160z',
                    symbolSize: 58,
                    itemStyle: {
                      color: '#d7c7a3'
                    },
                    label: {
                      show: true,
                      formatter: '暂无数据',
                      position: 'bottom',
                      color: '#806b45',
                      fontWeight: 700
                    },
                    data: [{ coord: [0, 0] }]
                  }
                : undefined
          },
          {
            data: chartRows.map((row) => [row.turnId, row.compressedTokens]),
            markLine:
              compactMarkLines.length > 0
                ? {
                    data: compactMarkLines
                  }
                : { data: [] }
          },
          {
            data: compactPoints
          }
        ]
      },
      false
    );
  }, [chartRows, compactMarkLines, compactPoints, maxTurn, samples.length]);

  return (
    <div className="token-chart-scroll">
      <div ref={chartRef} className="token-echarts" role="img" aria-label="压缩与未压缩上下文 token 趋势" />
    </div>
  );
}

function readTokenMetricsClearAt(): number {
  const value = window.sessionStorage.getItem(AGENT_TOKEN_METRICS_CLEAR_AT_KEY);
  if (!value) return 0;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function filterSnapshotByClearAt(snapshot: AgentTokenMetricsSnapshot): AgentTokenMetricsSnapshot {
  const clearAt = readTokenMetricsClearAt();
  if (!clearAt) return snapshot;
  const samples = snapshot.samples.filter((sample) => {
    const createdAt = Date.parse(sample.createdAt);
    return Number.isFinite(createdAt) && createdAt > clearAt;
  });
  const latest = samples[samples.length - 1];
  const baselineContextTokens = latest?.baselineContextTokens ?? 0;
  const savedTokens = latest?.savedTokens ?? 0;

  return {
    ...snapshot,
    samples,
    summary: {
      turnCount: samples.length,
      baselineContextTokens,
      compressedContextTokens: latest?.compressedContextTokens ?? 0,
      savedTokens,
      savedRatio: baselineContextTokens > 0 ? savedTokens / baselineContextTokens : 0,
      totalLlmTokens: samples.reduce((total, sample) => total + sample.totalLlmTokens, 0),
      compressionEvents: samples.filter((sample) => Boolean(sample.compactEvent)).length
    }
  };
}

export function TokenMetricsPage({ activePage, onNavigate }: TokenMetricsPageProps) {
  const [snapshot, setSnapshot] = useState<AgentTokenMetricsSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const snapshotSignatureRef = useRef('');

  const loadMetrics = useCallback(async (showLoading = false) => {
    if (showLoading) setLoading(true);
    try {
      const nextSnapshot = await agentApi.getTokenMetrics();
      const filteredSnapshot = filterSnapshotByClearAt(nextSnapshot);
      const nextSignature = JSON.stringify({
        summary: filteredSnapshot.summary,
        samples: filteredSnapshot.samples.map((sample) => ({
          turnId: sample.turnId,
          runId: sample.runId,
          phase: sample.phase,
          baselineContextTokens: sample.baselineContextTokens,
          compressedContextTokens: sample.compressedContextTokens,
          totalLlmTokens: sample.totalLlmTokens,
          compactEvent: sample.compactEvent
            ? {
                triggerType: sample.compactEvent.triggerType,
                beforeTokens: sample.compactEvent.beforeTokens,
                afterTokens: sample.compactEvent.afterTokens,
                savedTokens: sample.compactEvent.savedTokens
              }
            : null
        }))
      });
      if (showLoading || nextSignature !== snapshotSignatureRef.current) {
        snapshotSignatureRef.current = nextSignature;
        setSnapshot(filteredSnapshot);
      }
    } catch (error) {
      message.error(error instanceof Error ? error.message : '加载 Token 指标失败');
    } finally {
      if (showLoading) setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadMetrics(true);
  }, [loadMetrics]);

  useEffect(() => {
    return listenAgentTokenMetricsCleared(() => {
      setSnapshot(null);
      snapshotSignatureRef.current = '';
      void loadMetrics(true);
    });
  }, [loadMetrics]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      if (document.visibilityState === 'visible') {
        void loadMetrics();
      }
    }, 5000);
    return () => window.clearInterval(timer);
  }, [loadMetrics]);

  return (
    <AppLayout
      activePage={activePage}
      title="Token 消耗"
      subtitle="观察上下文压缩对主 Agent 的影响"
      showCalendarControls={false}
      onNavigate={onNavigate}
      onToday={() => undefined}
      onPrev={() => undefined}
      onNext={() => undefined}
      onCreate={() => undefined}
    >
      <main className="token-metrics-main">
        <section className="token-control-band">
          <div>
            <span className="token-page-kicker">compression timeline</span>
            <h3>压缩点驱动的 Token 对比</h3>
            <p>第一次压缩前两条曲线保持重合；出现手动或阈值压缩后，用压缩点的 token 起伏区分真实上下文与未压缩估算基线。</p>
          </div>
        </section>

        {loading ? (
          <div className="token-loading">
            <Spin />
            <span>正在读取 Token 观测数据...</span>
          </div>
        ) : null}

        {!loading && snapshot ? (
          <section className="token-chart-band">
            <div className="token-section-heading">
              <div>
                <span className="token-page-kicker">turn timeline</span>
                <h3>压缩前后双折线</h3>
              </div>
              <Button icon={<ReloadOutlined />} onClick={() => void loadMetrics(true)}>
                刷新
              </Button>
            </div>
            <TokenLineChart samples={snapshot.samples} />
          </section>
        ) : null}
      </main>
    </AppLayout>
  );
}
