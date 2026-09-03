import type { AgentJob } from '../types/agent';

export const AGENT_JOB_CREATED_EVENT = 'agent:job-created';
export const AGENT_TOKEN_METRICS_CLEARED_EVENT = 'agent:token-metrics-cleared';
export const AGENT_TOKEN_METRICS_CLEAR_AT_KEY = 'agent:token-metrics-cleared-at';

export function dispatchAgentJobCreated(job: AgentJob): void {
  window.dispatchEvent(new CustomEvent<AgentJob>(AGENT_JOB_CREATED_EVENT, { detail: job }));
}

export function dispatchAgentTokenMetricsCleared(): void {
  window.sessionStorage.setItem(AGENT_TOKEN_METRICS_CLEAR_AT_KEY, new Date().toISOString());
  window.dispatchEvent(new Event(AGENT_TOKEN_METRICS_CLEARED_EVENT));
}

export function listenAgentJobCreated(handler: (job: AgentJob) => void): () => void {
  const listener = (event: Event) => {
    const customEvent = event as CustomEvent<AgentJob>;
    if (!customEvent.detail) return;
    handler(customEvent.detail);
  };

  window.addEventListener(AGENT_JOB_CREATED_EVENT, listener);
  return () => window.removeEventListener(AGENT_JOB_CREATED_EVENT, listener);
}

export function listenAgentTokenMetricsCleared(handler: () => void): () => void {
  window.addEventListener(AGENT_TOKEN_METRICS_CLEARED_EVENT, handler);
  return () => window.removeEventListener(AGENT_TOKEN_METRICS_CLEARED_EVENT, handler);
}
