import type { AgentTrace, AgentTraceNode } from '../../types/agent';

interface AgentTraceGraphProps {
  trace?: AgentTrace | null;
}

const NODE_WIDTH = 172;
const NODE_HEIGHT = 58;
const COLUMN_GAP = 70;
const ROW_GAP = 24;
const PADDING = 18;

const statusClass: Record<string, string> = {
  success: 'success',
  running: 'running',
  failed: 'failed',
  waiting: 'waiting',
  pending: 'waiting'
};

function chunkText(value: string, maxLength: number) {
  const clean = value.trim();
  if (clean.length <= maxLength) return [clean];
  return [`${clean.slice(0, maxLength - 1)}...`];
}

function readNodeLabel(node: AgentTraceNode) {
  return node.label || node.id;
}

function readNodeStatus(node: AgentTraceNode) {
  return statusClass[String(node.status || '').toLowerCase()] || 'running';
}

function buildLayout(nodes: AgentTraceNode[], edges: NonNullable<AgentTrace['edges']>) {
  const nodeIds = new Set(nodes.map((node) => node.id));
  const rank = new Map(nodes.map((node) => [node.id, 0]));

  for (let pass = 0; pass < nodes.length; pass += 1) {
    let changed = false;
    for (const edge of edges) {
      if (!nodeIds.has(edge.source) || !nodeIds.has(edge.target)) continue;
      const nextRank = (rank.get(edge.source) ?? 0) + 1;
      if (nextRank > (rank.get(edge.target) ?? 0)) {
        rank.set(edge.target, nextRank);
        changed = true;
      }
    }
    if (!changed) break;
  }

  const columns = new Map<number, AgentTraceNode[]>();
  for (const node of nodes) {
    const column = rank.get(node.id) ?? 0;
    columns.set(column, [...(columns.get(column) ?? []), node]);
  }

  const positions = new Map<string, { x: number; y: number }>();
  const maxColumn = Math.max(...Array.from(columns.keys()), 0);
  let maxRows = 1;
  for (let column = 0; column <= maxColumn; column += 1) {
    const columnNodes = columns.get(column) ?? [];
    maxRows = Math.max(maxRows, columnNodes.length);
    columnNodes.forEach((node, row) => {
      positions.set(node.id, {
        x: PADDING + column * (NODE_WIDTH + COLUMN_GAP),
        y: PADDING + row * (NODE_HEIGHT + ROW_GAP)
      });
    });
  }

  return {
    positions,
    width: PADDING * 2 + (maxColumn + 1) * NODE_WIDTH + maxColumn * COLUMN_GAP,
    height: PADDING * 2 + maxRows * NODE_HEIGHT + Math.max(0, maxRows - 1) * ROW_GAP
  };
}

export function AgentTraceGraph({ trace }: AgentTraceGraphProps) {
  const nodes = trace?.nodes?.filter((node) => node?.id) ?? [];
  if (nodes.length === 0) return null;

  const edges = trace?.edges ?? [];
  const { positions, width, height } = buildLayout(nodes, edges);

  return (
    <div className="agent-runtime-graph">
      <div className="agent-runtime-graph-header">
        <strong>Runtime Graph</strong>
        <span>{trace?.name || 'python agent'}</span>
      </div>
      <svg className="agent-runtime-graph-canvas" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="Python Agent runtime graph">
        <defs>
          <marker id="agent-runtime-arrow" markerHeight="8" markerWidth="8" orient="auto" refX="7" refY="4">
            <path d="M0,0 L8,4 L0,8 Z" />
          </marker>
        </defs>

        {edges.map((edge) => {
          const source = positions.get(edge.source);
          const target = positions.get(edge.target);
          if (!source || !target) return null;
          const x1 = source.x + NODE_WIDTH;
          const y1 = source.y + NODE_HEIGHT / 2;
          const x2 = target.x;
          const y2 = target.y + NODE_HEIGHT / 2;
          const midX = x1 + Math.max(24, (x2 - x1) / 2);
          const path = x2 >= x1 ? `M ${x1} ${y1} C ${midX} ${y1}, ${midX} ${y2}, ${x2} ${y2}` : `M ${x1} ${y1} L ${x2} ${y2}`;
          return (
            <g className="agent-runtime-edge" key={edge.id || `${edge.source}-${edge.target}-${edge.label || ''}`}>
              <path d={path} markerEnd="url(#agent-runtime-arrow)" />
              {edge.label ? (
                <text x={midX} y={(y1 + y2) / 2 - 5}>
                  {chunkText(edge.label, 16)[0]}
                </text>
              ) : null}
            </g>
          );
        })}

        {nodes.map((node, index) => {
          const { x, y } = positions.get(node.id) ?? { x: PADDING, y: PADDING + index * (NODE_HEIGHT + ROW_GAP) };
          const detail = node.detail && typeof node.detail === 'object' ? (node.detail as Record<string, unknown>) : {};
          const status = readNodeStatus(node);
          const count =
            typeof detail.taskCount === 'number'
              ? `${detail.taskCount} tasks`
              : typeof detail.resultCount === 'number'
                ? `${detail.resultCount} results`
                : typeof detail.draftAllocationCount === 'number'
                  ? `${detail.draftAllocationCount} slots`
                  : node.kind || 'node';
          return (
            <g className={`agent-runtime-node ${status}`} key={node.id} transform={`translate(${x} ${y})`}>
              <rect height={NODE_HEIGHT} rx="8" width={NODE_WIDTH} />
              <text className="agent-runtime-node-title" x="14" y="23">
                {chunkText(readNodeLabel(node), 18)[0]}
              </text>
              <text className="agent-runtime-node-meta" x="14" y="43">
                {status} / {chunkText(count, 20)[0]}
              </text>
            </g>
          );
        })}
      </svg>
    </div>
  );
}
