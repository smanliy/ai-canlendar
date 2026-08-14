import * as agentOrchestrator from './agent.orchestrator';

export async function createScheduleRun(userId: string, input: string, clarificationJson?: unknown) {
  return agentOrchestrator.runScheduleAgent({
    userId,
    input,
    clarificationJson
  });
}
