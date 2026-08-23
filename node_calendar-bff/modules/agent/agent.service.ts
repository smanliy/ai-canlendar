import { resumeScheduleDecision as resumeScheduleDecisionOrchestrator } from './agent.orchestrator';
import { runAgentMainFlow } from './agent-main-flow';
import * as conversationRepository from './agent-conversation.repository';
import type { AgentConversationMessagePayload } from './agent.schema';

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

export async function listConversationMessages(userId: string) {
  return conversationRepository.listRecentConversationMessages(userId);
}

export async function saveConversationMessage(userId: string, payload: AgentConversationMessagePayload) {
  return conversationRepository.saveConversationMessage(userId, payload);
}

export async function clearConversationMessages(userId: string) {
  return conversationRepository.clearConversationMessages(userId);
}
