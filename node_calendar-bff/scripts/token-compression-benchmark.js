/* eslint-disable no-console */
const fs = require('node:fs/promises');
const path = require('node:path');
const readline = require('node:readline/promises');

const API_BASE_URL = process.env.API_BASE_URL || 'http://127.0.0.1:3000/api';
const DEFAULT_ROUNDS = 18;
const DEFAULT_MANUAL_COMPACT_EVERY = 6;
let generatedPhoneCounter = 0;

function readArg(name, fallback) {
  const prefix = `--${name}=`;
  const item = process.argv.find((arg) => arg.startsWith(prefix));
  return item ? item.slice(prefix.length) : fallback;
}

function readNumberArg(name, fallback) {
  const value = Number(readArg(name, ''));
  return Number.isFinite(value) && value >= 0 ? Math.round(value) : fallback;
}

function percentile(values, p) {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index];
}

function average(values) {
  return values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : 0;
}

function formatNumber(value) {
  return Math.round(value).toLocaleString('zh-CN');
}

function ratioDrop(before, after) {
  if (!before || before <= 0) return 0;
  return Math.max(0, (before - after) / before);
}

function uniquePhone() {
  generatedPhoneCounter += 1;
  return `199${String((Date.now() + generatedPhoneCounter) % 100000000).padStart(8, '0')}`;
}

function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${token}`,
  };
}

async function request(pathname, options = {}) {
  const response = await fetch(`${API_BASE_URL}${pathname}`, options);
  const text = await response.text();
  let body = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      throw new Error(`HTTP ${response.status} returned non-JSON: ${text.slice(0, 300)}`);
    }
  }
  if (!response.ok || body?.code !== 0) {
    throw new Error(body?.message || `HTTP ${response.status}`);
  }
  return body.data;
}

async function requestWithToken(pathname, token, body, method = 'POST') {
  return request(pathname, {
    method,
    headers: buildHeaders(token),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

async function authenticate(label = '') {
  const existingToken = process.env.AUTH_TOKEN;
  if (existingToken) return { token: existingToken, phone: process.env.PHONE || 'AUTH_TOKEN' };

  const phone = process.env.PHONE || uniquePhone();
  const nickname = process.env.NICKNAME || `Token Benchmark ${label}`.trim();

  let codeResult;
  let scene = 'register';
  try {
    codeResult = await request('/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, scene }),
    });
  } catch (error) {
    if (!String(error.message || '').includes('已注册')) throw error;
    scene = 'login';
    codeResult = await request('/auth/send-code', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ phone, scene }),
    });
  }

  let code = codeResult?.mockCode;
  if (!code) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    code = (await rl.question(`请输入 ${phone} 的${scene === 'register' ? '注册' : '登录'}验证码: `)).trim();
    rl.close();
  }

  const authResult = await request(`/auth/${scene}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(scene === 'register' ? { phone, code, nickname } : { phone, code }),
  });
  return { token: authResult.token, phone };
}

function buildWorkload(rounds) {
  const seeds = [
    '我要完成操作系统期末复习，截止到下周五晚上十一点，总共预计8小时，优先晚上安排。',
    '把复习计划调整一下，增加文件系统和进程调度的练习，每块至少45分钟。',
    '明天晚上之前安排1小时洗澡和整理房间，尽量不要拆太碎。',
    '帮我准备数据库课程展示，截止到三天后晚上九点，预计5小时，需要包含资料整理、PPT、演练。',
    '把数据库展示里的演练时间增加30分钟，如果黄金时间不够需要提示我确认。',
    '我要准备一次技术面试，截止到本周日晚上十点，预计6小时，包含八股、项目复盘和算法练习。',
    '把算法练习拆细一点，动态规划和二分各安排一段。',
    '明天中午前提醒我交水电费，预计10分钟。',
    '安排论文开题报告，截止到下周三晚上八点，预计10小时，需要调研、提纲、初稿和修改。',
    '论文调研部分需要更多文献阅读时间，把整体安排重新平衡。',
    '今晚十点前安排30分钟跑步，找一个空闲时间就行。',
    '我要做 Cesium 三维地理标绘模块说明，截止到下周一晚上九点，预计7小时，包含点位、区域、多边形转换和卫星覆盖可视化。',
  ];
  return Array.from({ length: rounds }, (_, index) => seeds[index % seeds.length]);
}

async function clearSession(token) {
  await requestWithToken('/agent/runs', token, { input: '/clear' });
}

async function setCompression(token, enabled) {
  await requestWithToken('/agent/compression', token, { enabled }, 'PATCH');
}

async function getMetrics(token) {
  return request('/agent/token-metrics', {
    method: 'GET',
    headers: { Authorization: `Bearer ${token}` },
  });
}

async function runWorkload({ token, label, compressionEnabled, prompts, manualCompactEvery }) {
  console.log(`\n[${label}] compression=${compressionEnabled}, rounds=${prompts.length}, manualCompactEvery=${manualCompactEvery}`);
  await setCompression(token, compressionEnabled);
  await clearSession(token);

  const checkpoints = [];
  for (let index = 0; index < prompts.length; index += 1) {
    const round = index + 1;
    const input = prompts[index];
    console.log(`[${label}] round ${round}/${prompts.length}: ${input.slice(0, 42)}`);
    let result;
    try {
      result = await requestWithToken('/agent/runs', token, { input });
    } catch (error) {
      result = { status: 'error', message: error.message };
      console.warn(`[${label}] round ${round} failed: ${error.message}`);
    }
    checkpoints.push({ round, kind: 'prompt', input, resultStatus: result.status, metrics: await getMetrics(token) });

    if (compressionEnabled && manualCompactEvery > 0 && round % manualCompactEvery === 0 && round < prompts.length) {
      console.log(`[${label}] manual compact after round ${round}`);
      const compactResult = await requestWithToken('/agent/runs', token, { input: '/compact benchmark checkpoint' }).catch((error) => ({
        status: 'error',
        message: error.message,
      }));
      checkpoints.push({ round, kind: 'manualCompact', resultStatus: compactResult.status, metrics: await getMetrics(token) });
    }
  }

  return {
    label,
    compressionEnabled,
    manualCompactEvery,
    checkpoints,
    finalMetrics: await getMetrics(token),
  };
}

function sampleValues(run, field) {
  return run.finalMetrics.samples.map((sample) => Number(sample[field]) || 0).filter((value) => value >= 0);
}

function summarizeRun(run) {
  const compressed = sampleValues(run, 'compressedContextTokens');
  const baseline = sampleValues(run, 'baselineContextTokens');
  const latest = run.finalMetrics.summary;
  return {
    turnCount: latest.turnCount,
    compressionEvents: latest.compressionEvents,
    totalLlmTokens: latest.totalLlmTokens,
    actualPeak: Math.max(0, ...compressed),
    actualAverage: average(compressed),
    actualP90: percentile(compressed, 90),
    estimatedBaselinePeak: Math.max(0, ...baseline),
    estimatedBaselineAverage: average(baseline),
    estimatedBaselineP90: percentile(baseline, 90),
    latestBaselineContextTokens: latest.baselineContextTokens,
    latestCompressedContextTokens: latest.compressedContextTokens,
    latestSavedRatio: latest.savedRatio,
  };
}

function compareRuns(baselineRun, compressedRun) {
  const baseline = summarizeRun(baselineRun);
  const compressed = summarizeRun(compressedRun);
  return {
    baseline,
    compressed,
    controlledActualPeakDrop: ratioDrop(baseline.actualPeak, compressed.actualPeak),
    controlledActualAverageDrop: ratioDrop(baseline.actualAverage, compressed.actualAverage),
    controlledActualP90Drop: ratioDrop(baseline.actualP90, compressed.actualP90),
    compressedRunEstimatedPeakDrop: ratioDrop(compressed.estimatedBaselinePeak, compressed.actualPeak),
    compressedRunEstimatedAverageDrop: ratioDrop(compressed.estimatedBaselineAverage, compressed.actualAverage),
    compressedRunEstimatedP90Drop: ratioDrop(compressed.estimatedBaselineP90, compressed.actualP90),
  };
}

function buildMarkdown({ phone, rounds, manualCompactEvery, comparison, outputJson }) {
  return [
    '# Token Compression Benchmark',
    '',
    `- API: ${API_BASE_URL}`,
    `- Phone/User: ${phone}`,
    `- Rounds: ${rounds}`,
    `- Manual compact every: ${manualCompactEvery || 'disabled'}`,
    `- Raw JSON: ${outputJson}`,
    '',
    '## Controlled Actual Comparison',
    '',
    '| Metric | No compression | Compression | Drop |',
    '| --- | ---: | ---: | ---: |',
    `| Peak context tokens | ${formatNumber(comparison.baseline.actualPeak)} | ${formatNumber(comparison.compressed.actualPeak)} | ${Math.round(comparison.controlledActualPeakDrop * 100)}% |`,
    `| Average context tokens | ${formatNumber(comparison.baseline.actualAverage)} | ${formatNumber(comparison.compressed.actualAverage)} | ${Math.round(comparison.controlledActualAverageDrop * 100)}% |`,
    `| P90 context tokens | ${formatNumber(comparison.baseline.actualP90)} | ${formatNumber(comparison.compressed.actualP90)} | ${Math.round(comparison.controlledActualP90Drop * 100)}% |`,
    '',
    '## Estimated Baseline Within Compression Run',
    '',
    '| Metric | Estimated uncompressed | Compressed actual | Drop |',
    '| --- | ---: | ---: | ---: |',
    `| Peak context tokens | ${formatNumber(comparison.compressed.estimatedBaselinePeak)} | ${formatNumber(comparison.compressed.actualPeak)} | ${Math.round(comparison.compressedRunEstimatedPeakDrop * 100)}% |`,
    `| Average context tokens | ${formatNumber(comparison.compressed.estimatedBaselineAverage)} | ${formatNumber(comparison.compressed.actualAverage)} | ${Math.round(comparison.compressedRunEstimatedAverageDrop * 100)}% |`,
    `| P90 context tokens | ${formatNumber(comparison.compressed.estimatedBaselineP90)} | ${formatNumber(comparison.compressed.actualP90)} | ${Math.round(comparison.compressedRunEstimatedP90Drop * 100)}% |`,
    '',
    '## Notes',
    '',
    '- Controlled comparison uses the same prompt workload with compression disabled vs enabled.',
    '- Estimated baseline follows the app token chart baseline from the compressed run.',
    '- If the workload is short or compression is not triggered, the drop can be small or negative.',
    '',
  ].join('\n');
}

async function main() {
  const rounds = readNumberArg('rounds', DEFAULT_ROUNDS);
  const manualCompactEvery = readNumberArg('manual-compact-every', DEFAULT_MANUAL_COMPACT_EVERY);
  const prompts = buildWorkload(rounds);
  const baselineAuth = await authenticate('baseline');
  const compressedAuth = process.env.AUTH_TOKEN ? baselineAuth : await authenticate('compressed');

  const baselineRun = await runWorkload({
    token: baselineAuth.token,
    label: 'baseline',
    compressionEnabled: false,
    prompts,
    manualCompactEvery: 0,
  });
  const compressedRun = await runWorkload({
    token: compressedAuth.token,
    label: 'compressed',
    compressionEnabled: true,
    prompts,
    manualCompactEvery,
  });

  const comparison = compareRuns(baselineRun, compressedRun);
  const reportsDir = path.resolve(__dirname, '..', 'reports');
  await fs.mkdir(reportsDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const outputJson = path.join(reportsDir, `token-benchmark-${stamp}.json`);
  const outputMd = path.join(reportsDir, `token-benchmark-${stamp}.md`);
  await fs.writeFile(
    outputJson,
    JSON.stringify(
      {
        apiBaseUrl: API_BASE_URL,
        users: {
          baseline: baselineAuth.phone,
          compressed: compressedAuth.phone,
        },
        rounds,
        manualCompactEvery,
        prompts,
        baselineRun,
        compressedRun,
        comparison,
      },
      null,
      2,
    ),
    'utf8',
  );
  await fs.writeFile(
    outputMd,
    buildMarkdown({
      phone: baselineAuth.phone === compressedAuth.phone ? baselineAuth.phone : `${baselineAuth.phone} / ${compressedAuth.phone}`,
      rounds,
      manualCompactEvery,
      comparison,
      outputJson,
    }),
    'utf8',
  );

  console.log('\nBenchmark complete.');
  console.log(`JSON: ${outputJson}`);
  console.log(`Report: ${outputMd}`);
  console.log(
    `Peak drop controlled=${Math.round(comparison.controlledActualPeakDrop * 100)}%, estimated=${Math.round(
      comparison.compressedRunEstimatedPeakDrop * 100,
    )}%`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
