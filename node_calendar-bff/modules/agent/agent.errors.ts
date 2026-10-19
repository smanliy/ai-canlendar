export class AgentUpstreamError extends Error {
  statusCode: number;
  upstream: string;
  causeCode?: string;
  originalCause?: unknown;

  constructor(message: string, options: { upstream: string; statusCode?: number; causeCode?: string; cause?: unknown }) {
    super(message);
    this.name = 'AgentUpstreamError';
    this.statusCode = options.statusCode ?? 502;
    this.upstream = options.upstream;
    this.causeCode = options.causeCode;
    this.originalCause = options.cause;
  }
}

export function getAgentHttpStatus(error: unknown): number {
  return error instanceof AgentUpstreamError ? error.statusCode : 400;
}

export function getAgentErrorCauseCode(error: unknown): string | undefined {
  return error instanceof AgentUpstreamError ? error.causeCode : undefined;
}

/**
 * checkpoint 缺失/失效类错误的统一构造器。
 * 前端依赖 causeCode 做降级（例如 NO_CHECKPOINT 时自动放弃恢复、按新任务处理），
 * 所以这里返回 HTTP 409 + 结构化 causeCode，而不是裸 throw Error。
 */
export class AgentCheckpointError extends AgentUpstreamError {
  constructor(message: string, causeCode: 'NO_CHECKPOINT' | 'CHECKPOINT_INVALID' | 'CHECKPOINT_VERSION_MISMATCH' | 'CHECKPOINT_EXPIRED') {
    super(message, { upstream: 'agent-checkpoint', statusCode: 409, causeCode });
    this.name = 'AgentCheckpointError';
  }
}

export class AgentJobNotFoundError extends AgentUpstreamError {
  constructor(message = '找不到当前 Agent 任务') {
    super(message, { upstream: 'agent-job', statusCode: 404, causeCode: 'JOB_NOT_FOUND' });
    this.name = 'AgentJobNotFoundError';
  }
}
