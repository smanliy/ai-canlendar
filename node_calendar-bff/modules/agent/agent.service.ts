import * as agentOrchestrator from './agent.orchestrator';

export async function createScheduleRun(userId: string, input: string) {
  return agentOrchestrator.runScheduleAgent({
    userId,
    input
  });
}
