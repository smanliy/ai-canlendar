import type { Prisma } from '@prisma/client';

import { prisma } from '../db/prisma';
import type { AgentUserPreference } from './agent.types';
import type { PythonPlanResult } from './python-agent';

export interface AgentPlanningSessionState {
  userId: string;
  rawInput: string;
  userPreference: AgentUserPreference;
  normalizedContext: Record<string, unknown>;
  atomicPlan: PythonPlanResult;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value ?? null)) as Prisma.InputJsonValue;
}

export async function savePlanningSession(runId: string, state: AgentPlanningSessionState, status = 'waitingConfirm') {
  await prisma.agentPlanningSession.upsert({
    where: { id: runId },
    update: {
      rawInput: state.rawInput,
      status,
      userPreference: toJson(state.userPreference),
      normalizedContext: toJson(state.normalizedContext),
      atomicPlan: toJson(state.atomicPlan)
    },
    create: {
      id: runId,
      userId: state.userId,
      rawInput: state.rawInput,
      status,
      userPreference: toJson(state.userPreference),
      normalizedContext: toJson(state.normalizedContext),
      atomicPlan: toJson(state.atomicPlan)
    }
  });
}

export async function findPlanningSession(runId: string, userId: string): Promise<AgentPlanningSessionState | null> {
  const record = await prisma.agentPlanningSession.findFirst({
    where: {
      id: runId,
      userId
    }
  });

  if (!record) return null;

  return {
    userId: record.userId,
    rawInput: record.rawInput,
    userPreference: record.userPreference as unknown as AgentUserPreference,
    normalizedContext: record.normalizedContext as Record<string, unknown>,
    atomicPlan: record.atomicPlan as unknown as PythonPlanResult
  };
}

export async function updatePlanningSessionAtomicPlan(
  runId: string,
  userId: string,
  atomicPlan: PythonPlanResult,
  status = 'waitingConfirm'
) {
  await prisma.agentPlanningSession.updateMany({
    where: {
      id: runId,
      userId
    },
    data: {
      status,
      atomicPlan: toJson(atomicPlan)
    }
  });
}

export async function clearPlanningSessionsByUser(userId: string): Promise<number> {
  return prisma.$executeRaw`
    DELETE FROM "AgentPlanningSession"
    WHERE "userId" = ${userId}
  `;
}
