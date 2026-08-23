import { resumeScheduleDecision as resumeScheduleDecisionOrchestrator } from './agent.orchestrator';
import { runAgentMainFlow } from './agent-main-flow';

export async function createScheduleRun(userId: string, input: string, clarificationJson?: unknown) {
  return runAgentMainFlow({
    userId,
    input,
    clarificationJson
  });
}

export async function submitScheduleDecision(userId: string, runId: string, decision: { optionId: string; taskId: string }) {
  return resumeScheduleDecisionOrchestrator(userId, runId, decision);
}
