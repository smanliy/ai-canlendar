import * as agentOrchestrator from './agent.orchestrator';

export async function createScheduleRun(userId: string, input: string, clarificationJson?: unknown) {
  return agentOrchestrator.runScheduleAgent({
    userId,
    input,
    clarificationJson
  });
}

export async function submitScheduleDecision(userId: string, runId: string, decision: { optionId: string; taskId: string }) {
  return agentOrchestrator.resumeScheduleDecision(userId, runId, decision);
}
