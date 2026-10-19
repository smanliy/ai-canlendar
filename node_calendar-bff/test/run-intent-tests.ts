/**
 * 意图识别器评测运行器。
 *
 * 用法（在 node_calendar-bff 目录下）：
 *   npx ts-node --transpile-only test/run-intent-tests.ts
 *
 * 行为：
 * - 从 ../.env 读 DEEPSEEK_API_KEY，对 50 条用例并发（5 路）调用 classifyUserIntent
 * - 按用例断言 kind 序列、target.title、shiftMinutes、allowConflict、相对时间偏移等
 * - 控制台打印逐条结果 + 汇总，并把完整报告写入 test/reports/
 */

import { config as loadEnv } from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

loadEnv({ path: path.resolve(__dirname, '..', '.env') });

import { classifyUserIntent, nowIsoWithOffset, type IntentClassification, type IntentOperation } from '../modules/agent/intent-classifier';
import { INTENT_TEST_CASES, type ExpectedOp, type IntentTestCase } from './intent-test-cases';

const CONCURRENCY = 5;

interface CaseResult {
  testCase: IntentTestCase;
  pass: boolean;
  failures: string[];
  actualKinds: string[];
  actualOps: IntentOperation[];
  reason: string;
  fallbackUsed: boolean;
  latencyMs: number;
  error?: string;
}

function buildContext(testCase: IntentTestCase, nowIso: string) {
  return {
    state: {
      messages: [],
      summary: null,
      currentRequest: null,
      extractedFields: {},
      missingFields: {},
      toolResults: [],
      freeTimeSlots: [],
      planCards: [],
      selectedPlanCardId: null,
      userAnnotations: [],
      userConflictApprovals: [],
      conflicts: [],
      warnings: [],
      agentState: null,
      pendingFrontendAction: null,
      lastCompactedAt: null,
      lastActivityAt: null
    },
    resume: testCase.hasPendingJob
      ? {
          hasPendingJob: true,
          pendingJobInput: '帮我准备周五的项目汇报',
          pendingJobLastStep: '生成排期方案，等待用户确认',
          pendingJobPausedAt: nowIso
        }
      : { hasPendingJob: false, pendingJobInput: null, pendingJobLastStep: null, pendingJobPausedAt: null },
    nowIso,
    timezone: 'Asia/Shanghai'
  };
}

function checkOp(expected: ExpectedOp, actual: IntentOperation | undefined, index: number, nowMs: number): string[] {
  const failures: string[] = [];
  const label = `op[${index}]`;
  if (!actual) {
    failures.push(`${label}: 缺少第 ${index + 1} 个操作（期望 ${expected.kind}）`);
    return failures;
  }
  if (actual.kind !== expected.kind) {
    failures.push(`${label}: kind 期望 ${expected.kind}，实际 ${actual.kind}`);
    return failures; // kind 错了，其余字段断言意义不大
  }
  if (expected.taskTextIncludes && !(actual.taskText ?? '').includes(expected.taskTextIncludes)) {
    failures.push(`${label}: taskText 应包含「${expected.taskTextIncludes}」，实际「${actual.taskText ?? '(空)'}」`);
  }
  if (expected.targetTitleIncludes && !(actual.target?.title ?? '').includes(expected.targetTitleIncludes)) {
    failures.push(`${label}: target.title 应包含「${expected.targetTitleIncludes}」，实际「${actual.target?.title ?? '(空)'}」`);
  }
  if (expected.shiftMinutes !== undefined) {
    const actualShift = actual.patch?.shiftMinutes;
    if (actualShift !== expected.shiftMinutes) {
      failures.push(`${label}: shiftMinutes 期望 ${expected.shiftMinutes}，实际 ${actualShift ?? '(未输出)'}`);
    }
  }
  if (expected.allowConflict) {
    const flag = actual.allowConflict === true || (actual.event as { allowConflict?: boolean } | undefined)?.allowConflict === true;
    if (!flag) failures.push(`${label}: 期望 allowConflict=true，实际未输出`);
  }
  if (expected.eventTitleIncludes && !(actual.event?.title ?? '').includes(expected.eventTitleIncludes)) {
    failures.push(`${label}: event.title 应包含「${expected.eventTitleIncludes}」，实际「${actual.event?.title ?? '(空)'}」`);
  }
  if (expected.startOffsetMinutes) {
    const start = typeof actual.event?.startTime === 'string' ? Date.parse(actual.event.startTime) : NaN;
    if (Number.isNaN(start)) {
      failures.push(`${label}: event.startTime 缺失或无法解析「${actual.event?.startTime ?? '(空)'}」`);
    } else {
      const offsetMin = (start - nowMs) / 60000;
      const [min, max] = expected.startOffsetMinutes;
      if (offsetMin < min || offsetMin > max) {
        failures.push(`${label}: 开始时间偏移 ${offsetMin.toFixed(1)} 分钟，期望在 [${min}, ${max}] 分钟区间`);
      }
    }
  }
  if (expected.answerNonEmpty && !(actual.answer ?? '').trim()) {
    failures.push(`${label}: chat.answer 为空`);
  }
  return failures;
}

function evaluate(testCase: IntentTestCase, classification: IntentClassification, nowMs: number): { failures: string[] } {
  const failures: string[] = [];
  const ops = classification.operations;
  if (ops.length !== testCase.expectedOps.length) {
    failures.push(`操作数量期望 ${testCase.expectedOps.length}，实际 ${ops.length}（实际 kinds: ${ops.map((o) => o.kind).join(',') || '无'}）`);
  }
  testCase.expectedOps.forEach((expected, index) => {
    failures.push(...checkOp(expected, ops[index], index, nowMs));
  });
  if (classification.fallbackUsed && testCase.category !== '恢复降级') {
    // fallbackUsed 意味着走了关键词兜底——分类主路径失效，记为失败
    failures.push('走了关键词兜底（fallbackUsed=true），LLM 主路径未生效');
  }
  return { failures };
}

async function runCase(testCase: IntentTestCase): Promise<CaseResult> {
  const nowIso = nowIsoWithOffset();
  const nowMs = Date.now();
  const started = Date.now();
  try {
    const classification = await classifyUserIntent(testCase.input, buildContext(testCase, nowIso));
    const latencyMs = Date.now() - started;
    const { failures } = evaluate(testCase, classification, nowMs);
    return {
      testCase,
      pass: failures.length === 0,
      failures,
      actualKinds: classification.operations.map((op) => op.kind),
      actualOps: classification.operations,
      reason: classification.reason,
      fallbackUsed: classification.fallbackUsed,
      latencyMs
    };
  } catch (error) {
    return {
      testCase,
      pass: false,
      failures: [`调用异常: ${error instanceof Error ? error.message : String(error)}`],
      actualKinds: [],
      actualOps: [],
      reason: '',
      fallbackUsed: false,
      latencyMs: Date.now() - started,
      error: error instanceof Error ? error.message : String(error)
    };
  }
}

async function runWithConcurrency(cases: IntentTestCase[]): Promise<CaseResult[]> {
  const results: CaseResult[] = new Array(cases.length);
  let cursor = 0;
  async function worker() {
    while (cursor < cases.length) {
      const index = cursor++;
      results[index] = await runCase(cases[index]);
      const r = results[index];
      const mark = r.pass ? 'PASS' : 'FAIL';
      console.log(`[${mark}] ${r.testCase.id} ${r.testCase.category} | ${r.testCase.input} (${r.latencyMs}ms)`);
      if (!r.pass) r.failures.forEach((f) => console.log(`       └ ${f}`));
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return results;
}

function summarizeOps(ops: IntentOperation[]): string {
  return ops
    .map((op) => {
      const parts: string[] = [op.kind];
      if (op.taskText) parts.push(`task="${op.taskText}"`);
      if (op.target?.title) parts.push(`target="${op.target.title}"`);
      if (op.patch?.shiftMinutes !== undefined) parts.push(`shift=${op.patch.shiftMinutes}min`);
      if (op.event?.title) parts.push(`event="${op.event.title}"`);
      if (op.event?.startTime) parts.push(`start=${op.event.startTime}`);
      if (op.allowConflict) parts.push('allowConflict');
      if (op.answer) parts.push(`answer="${op.answer.slice(0, 40)}…"`);
      return parts.join(' ');
    })
    .join('<br>');
}

function writeReport(results: CaseResult[]): string {
  const passCount = results.filter((r) => r.pass).length;
  const now = new Date();
  const stamp = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}`;
  const reportDir = path.resolve(__dirname, 'reports');
  fs.mkdirSync(reportDir, { recursive: true });

  const lines: string[] = [
    `# 意图识别器评测报告`,
    ``,
    `- 时间: ${now.toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' })}`,
    `- 模型: ${process.env.DEEPSEEK_MODEL?.trim() || 'deepseek-v4-flash'}`,
    `- 通过率: **${passCount}/${results.length}**（${((passCount / results.length) * 100).toFixed(1)}%）`,
    `- 平均延迟: ${(results.reduce((s, r) => s + r.latencyMs, 0) / results.length).toFixed(0)}ms`,
    ``,
    `| ID | 类别 | 输入 | 结果 | 实际输出 | 失败原因 | 延迟 |`,
    `|----|------|------|------|----------|----------|------|`
  ];
  for (const r of results) {
    lines.push(
      `| ${r.testCase.id} | ${r.testCase.category} | ${r.testCase.input} | ${r.pass ? '✅' : '❌'} | ${summarizeOps(r.actualOps) || '(无)'} | ${r.failures.join('<br>') || '-'} | ${r.latencyMs}ms |`
    );
  }
  const mdPath = path.join(reportDir, `intent-eval-${stamp}.md`);
  fs.writeFileSync(mdPath, lines.join('\n'), 'utf-8');

  const jsonPath = path.join(reportDir, `intent-eval-${stamp}.json`);
  fs.writeFileSync(
    jsonPath,
    JSON.stringify(
      results.map((r) => ({
        id: r.testCase.id,
        category: r.testCase.category,
        input: r.testCase.input,
        pass: r.pass,
        failures: r.failures,
        actualOps: r.actualOps,
        reason: r.reason,
        fallbackUsed: r.fallbackUsed,
        latencyMs: r.latencyMs
      })),
      null,
      2
    ),
    'utf-8'
  );
  return mdPath;
}

async function main() {
  if (!process.env.DEEPSEEK_API_KEY?.trim()) {
    console.error('缺少 DEEPSEEK_API_KEY（.env 未加载）');
    process.exit(1);
  }
  // 支持只跑指定用例：npx ts-node --transpile-only test/run-intent-tests.ts A01 F06
  const filterIds = process.argv.slice(2).map((id) => id.toUpperCase());
  const casesToRun = filterIds.length
    ? INTENT_TEST_CASES.filter((c) => filterIds.includes(c.id.toUpperCase()))
    : INTENT_TEST_CASES;
  if (!casesToRun.length) {
    console.error(`没有匹配的用例: ${filterIds.join(', ')}`);
    process.exit(1);
  }
  console.log(`共 ${casesToRun.length} 条用例，并发 ${CONCURRENCY} 路，开始评测...\n`);
  const started = Date.now();
  const results = await runWithConcurrency(casesToRun);
  const passCount = results.filter((r) => r.pass).length;
  const reportPath = writeReport(results);

  console.log(`\n===== 汇总 =====`);
  console.log(`通过: ${passCount}/${results.length}（${((passCount / results.length) * 100).toFixed(1)}%）`);
  console.log(`总耗时: ${((Date.now() - started) / 1000).toFixed(1)}s`);
  const byCategory = new Map<string, { pass: number; total: number }>();
  for (const r of results) {
    const entry = byCategory.get(r.testCase.category) ?? { pass: 0, total: 0 };
    entry.total += 1;
    if (r.pass) entry.pass += 1;
    byCategory.set(r.testCase.category, entry);
  }
  for (const [category, entry] of byCategory) {
    console.log(`  ${category}: ${entry.pass}/${entry.total}`);
  }
  console.log(`报告: ${reportPath}`);
  if (passCount < results.length) process.exitCode = 2;
}

void main();
