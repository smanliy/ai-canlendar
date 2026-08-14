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
