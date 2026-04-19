#!/usr/bin/env node
/**
 * benchmark-tool-reliability — measure how reliably an Ollama model emits
 * schema-valid tool calls for a suite of tasks.
 *
 * Companion to scripts/probe-ollama-tools.ts. Where probe-ollama-tools
 * answers "does this model emit tool_calls at all?", this harness answers
 * "how often does it get them right?" — which is the axis that matters
 * for shipping an agent with a given model.
 *
 * Hits /api/chat directly with raw fetch — no runtime wrapper — so the
 * numbers reflect the model's own behaviour, not our tool loop. That
 * makes it a clean baseline for comparing against post-retry-loop runs.
 *
 * Usage:
 *   npx tsx scripts/benchmark-tool-reliability.ts <model> [iterations]
 *   npx tsx scripts/benchmark-tool-reliability.ts llama3.2:1b 10
 *   npx tsx scripts/benchmark-tool-reliability.ts qwen3.5:4b 5 --json
 *   npx tsx scripts/benchmark-tool-reliability.ts all 10    # both installed models
 *
 * Environment:
 *   OLLAMA_HOST       — override Ollama endpoint (default http://localhost:11434)
 *   BENCHMARK_TIMEOUT — per-request timeout ms (default 120000)
 */

interface Tool {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: {
      type: 'object';
      properties: Record<string, { type: string; description?: string; enum?: string[] }>;
      required?: string[];
    };
  };
}

interface TaskCase {
  id: string;
  description: string;
  systemPrompt: string;
  userPrompt: string;
  tools: Tool[];
  // Expected outcome:
  //   'call' → model should invoke one of the named tools (expectedToolName optional — if set, must match)
  //   'no-call' → model should NOT invoke a tool
  expected: 'call' | 'no-call';
  expectedToolName?: string;
}

const SUITE: TaskCase[] = [
  {
    id: 'single-arg-explicit',
    description: 'Single-param tool, explicit "use the tool" instruction',
    systemPrompt:
      'You have access to tools. When a question can be answered with a tool, invoke it rather than guessing.',
    userPrompt:
      'What time is it in Tokyo right now? Use the available tool — do not guess.',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description:
            'Return the current wall-clock time in a given IANA timezone.',
          parameters: {
            type: 'object',
            properties: {
              timezone: {
                type: 'string',
                description:
                  'IANA timezone, e.g. "America/New_York" or "Asia/Tokyo".',
              },
            },
            required: ['timezone'],
          },
        },
      },
    ],
    expected: 'call',
    expectedToolName: 'get_current_time',
  },
  {
    id: 'multi-arg',
    description: 'Three required params — tests multi-arg compliance',
    systemPrompt: 'You have access to tools. Invoke them when appropriate.',
    userPrompt:
      'Please send an email to alice@example.com with the subject "Status update" and the body "Everything is on track for Friday."',
    tools: [
      {
        type: 'function',
        function: {
          name: 'send_email',
          description: 'Send an email with a subject and body.',
          parameters: {
            type: 'object',
            properties: {
              to: { type: 'string', description: 'Recipient email address' },
              subject: { type: 'string', description: 'Subject line' },
              body: { type: 'string', description: 'Email body text' },
            },
            required: ['to', 'subject', 'body'],
          },
        },
      },
    ],
    expected: 'call',
    expectedToolName: 'send_email',
  },
  {
    id: 'tool-choice',
    description: 'Two tools, correct one must be picked',
    systemPrompt: 'You have access to tools. Pick the right one for the job.',
    userPrompt: 'What is 47 multiplied by 19?',
    tools: [
      {
        type: 'function',
        function: {
          name: 'calculator',
          description: 'Evaluate a basic arithmetic operation.',
          parameters: {
            type: 'object',
            properties: {
              operation: {
                type: 'string',
                enum: ['add', 'subtract', 'multiply', 'divide'],
                description: 'Arithmetic operation to perform',
              },
              a: { type: 'number', description: 'First operand' },
              b: { type: 'number', description: 'Second operand' },
            },
            required: ['operation', 'a', 'b'],
          },
        },
      },
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: 'Return current time for an IANA timezone.',
          parameters: {
            type: 'object',
            properties: { timezone: { type: 'string' } },
            required: ['timezone'],
          },
        },
      },
    ],
    expected: 'call',
    expectedToolName: 'calculator',
  },
  {
    id: 'no-tool-needed',
    description:
      'Conversational question with a tool available — model should NOT call it',
    systemPrompt:
      'You have access to tools but should only invoke them when genuinely needed.',
    userPrompt: 'Hi! How are you doing today?',
    tools: [
      {
        type: 'function',
        function: {
          name: 'get_current_time',
          description: 'Return current time for an IANA timezone.',
          parameters: {
            type: 'object',
            properties: { timezone: { type: 'string' } },
            required: ['timezone'],
          },
        },
      },
    ],
    expected: 'no-call',
  },
];

type FailureReason =
  | 'transport'
  | 'no-tool-calls'
  | 'wrong-tool-name'
  | 'missing-required-arg'
  | 'wrong-arg-type'
  | 'unexpected-tool-call'; // for no-call cases

interface IterationResult {
  iteration: number;
  success: boolean;
  failure?: FailureReason;
  failureDetail?: string;
  durationMs: number;
  toolCallName?: string;
  toolCallArgs?: Record<string, unknown>;
}

interface CaseResult {
  caseId: string;
  description: string;
  expected: 'call' | 'no-call';
  iterations: IterationResult[];
  successCount: number;
  total: number;
  successRate: number;
  avgDurationMs: number;
}

interface ModelResult {
  model: string;
  host: string;
  cases: CaseResult[];
  overallSuccessRate: number;
  totalIterations: number;
  startedAt: string;
  finishedAt: string;
}

function validateArgs(
  tool: Tool,
  args: unknown,
): { ok: true } | { ok: false; reason: FailureReason; detail: string } {
  if (typeof args !== 'object' || args === null || Array.isArray(args)) {
    return {
      ok: false,
      reason: 'wrong-arg-type',
      detail: `arguments must be an object, got ${typeof args}`,
    };
  }
  const record = args as Record<string, unknown>;
  const required = tool.function.parameters.required ?? [];
  for (const field of required) {
    if (!(field in record)) {
      return {
        ok: false,
        reason: 'missing-required-arg',
        detail: `missing required field "${field}"`,
      };
    }
  }
  for (const [field, spec] of Object.entries(tool.function.parameters.properties)) {
    if (!(field in record)) continue;
    const value = record[field];
    if (spec.type === 'string' && typeof value !== 'string') {
      return {
        ok: false,
        reason: 'wrong-arg-type',
        detail: `field "${field}" expected string, got ${typeof value}`,
      };
    }
    if (spec.type === 'number' && typeof value !== 'number') {
      return {
        ok: false,
        reason: 'wrong-arg-type',
        detail: `field "${field}" expected number, got ${typeof value}`,
      };
    }
    if (spec.enum && typeof value === 'string' && !spec.enum.includes(value)) {
      return {
        ok: false,
        reason: 'wrong-arg-type',
        detail: `field "${field}" must be one of ${spec.enum.join(', ')}, got "${value}"`,
      };
    }
  }
  return { ok: true };
}

async function runIteration(
  tc: TaskCase,
  model: string,
  host: string,
  iteration: number,
  timeoutMs: number,
): Promise<IterationResult> {
  const started = Date.now();
  let res: Response;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: tc.systemPrompt },
          { role: 'user', content: tc.userPrompt },
        ],
        tools: tc.tools,
        stream: false,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
  } catch (err) {
    return {
      iteration,
      success: false,
      failure: 'transport',
      failureDetail: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - started,
    };
  }
  if (!res.ok) {
    return {
      iteration,
      success: false,
      failure: 'transport',
      failureDetail: `HTTP ${res.status}`,
      durationMs: Date.now() - started,
    };
  }

  const body = (await res.json()) as {
    message?: {
      content?: string;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: unknown };
      }>;
    };
  };
  const durationMs = Date.now() - started;
  const calls = body.message?.tool_calls ?? [];

  if (tc.expected === 'no-call') {
    if (calls.length === 0) {
      return { iteration, success: true, durationMs };
    }
    return {
      iteration,
      success: false,
      failure: 'unexpected-tool-call',
      failureDetail: `called ${calls[0].function?.name} when no tool was needed`,
      durationMs,
      toolCallName: calls[0].function?.name,
    };
  }

  // Expected a call
  if (calls.length === 0) {
    return {
      iteration,
      success: false,
      failure: 'no-tool-calls',
      failureDetail: `text-only response: ${JSON.stringify((body.message?.content ?? '').slice(0, 120))}`,
      durationMs,
    };
  }
  const first = calls[0];
  const name = first.function?.name;
  const args = first.function?.arguments;
  if (tc.expectedToolName && name !== tc.expectedToolName) {
    return {
      iteration,
      success: false,
      failure: 'wrong-tool-name',
      failureDetail: `expected ${tc.expectedToolName}, got ${name}`,
      durationMs,
      toolCallName: name,
      toolCallArgs: args as Record<string, unknown>,
    };
  }
  const matchedTool = tc.tools.find((t) => t.function.name === name);
  if (!matchedTool) {
    return {
      iteration,
      success: false,
      failure: 'wrong-tool-name',
      failureDetail: `called ${name}, which is not in the provided tools`,
      durationMs,
      toolCallName: name,
    };
  }
  const check = validateArgs(matchedTool, args);
  if (!check.ok) {
    return {
      iteration,
      success: false,
      failure: check.reason,
      failureDetail: check.detail,
      durationMs,
      toolCallName: name,
      toolCallArgs: args as Record<string, unknown>,
    };
  }
  return {
    iteration,
    success: true,
    durationMs,
    toolCallName: name,
    toolCallArgs: args as Record<string, unknown>,
  };
}

async function runCase(
  tc: TaskCase,
  model: string,
  host: string,
  iterations: number,
  timeoutMs: number,
  progress: (msg: string) => void,
): Promise<CaseResult> {
  const results: IterationResult[] = [];
  for (let i = 1; i <= iterations; i++) {
    const r = await runIteration(tc, model, host, i, timeoutMs);
    results.push(r);
    progress(
      `    iter ${i}/${iterations}: ${r.success ? 'ok' : `FAIL (${r.failure}: ${r.failureDetail?.slice(0, 80) ?? ''})`} ${r.durationMs}ms`,
    );
  }
  const successCount = results.filter((r) => r.success).length;
  const total = results.length;
  const avgDurationMs =
    results.reduce((sum, r) => sum + r.durationMs, 0) / total;
  return {
    caseId: tc.id,
    description: tc.description,
    expected: tc.expected,
    iterations: results,
    successCount,
    total,
    successRate: successCount / total,
    avgDurationMs,
  };
}

async function benchmarkModel(
  model: string,
  host: string,
  iterations: number,
  timeoutMs: number,
  progress: (msg: string) => void,
): Promise<ModelResult> {
  const startedAt = new Date().toISOString();
  progress(`\n=== ${model} (${iterations} iter/case) ===`);
  const cases: CaseResult[] = [];
  for (const tc of SUITE) {
    progress(`  case "${tc.id}": ${tc.description}`);
    const cr = await runCase(tc, model, host, iterations, timeoutMs, progress);
    cases.push(cr);
    progress(
      `    → ${cr.successCount}/${cr.total} pass (${(cr.successRate * 100).toFixed(0)}%, avg ${Math.round(cr.avgDurationMs)}ms)`,
    );
  }
  const finishedAt = new Date().toISOString();
  const totalIterations = cases.reduce((sum, c) => sum + c.total, 0);
  const totalSuccess = cases.reduce((sum, c) => sum + c.successCount, 0);
  return {
    model,
    host,
    cases,
    overallSuccessRate: totalSuccess / totalIterations,
    totalIterations,
    startedAt,
    finishedAt,
  };
}

async function listInstalledModels(host: string): Promise<string[]> {
  try {
    const res = await fetch(`${host}/api/tags`);
    if (!res.ok) return [];
    const body = (await res.json()) as {
      models?: Array<{ name: string }>;
    };
    return (body.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function printSummary(results: ModelResult[]): void {
  console.log('\n┏━━ Summary ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  for (const r of results) {
    console.log(`┃ ${r.model}`);
    console.log(
      `┃   Overall: ${(r.overallSuccessRate * 100).toFixed(1)}% (${r.cases.reduce((s, c) => s + c.successCount, 0)}/${r.totalIterations})`,
    );
    for (const c of r.cases) {
      const pct = (c.successRate * 100).toFixed(0).padStart(3);
      console.log(
        `┃   ${pct}%  ${c.caseId.padEnd(22)} ${Math.round(c.avgDurationMs).toString().padStart(6)}ms avg`,
      );
    }
  }
  console.log('┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const jsonOutput = args.includes('--json');
  const filtered = args.filter((a) => !a.startsWith('--'));
  const modelArg = filtered[0];
  const iterations = parseInt(filtered[1] || '5', 10);
  const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
  const timeoutMs = parseInt(process.env.BENCHMARK_TIMEOUT || '120000', 10);

  if (!modelArg) {
    console.error(
      'usage: npx tsx scripts/benchmark-tool-reliability.ts <model|all> [iterations] [--json]',
    );
    return 2;
  }

  let models: string[];
  if (modelArg === 'all') {
    models = await listInstalledModels(host);
    if (models.length === 0) {
      console.error(`No models found at ${host}`);
      return 2;
    }
  } else {
    models = [modelArg];
  }

  const log = jsonOutput ? () => {} : (m: string) => console.error(m);
  const results: ModelResult[] = [];
  for (const model of models) {
    results.push(await benchmarkModel(model, host, iterations, timeoutMs, log));
  }

  if (jsonOutput) {
    console.log(JSON.stringify({ results, suite: SUITE.map((s) => s.id) }, null, 2));
  } else {
    printSummary(results);
  }

  const allPassed = results.every((r) => r.overallSuccessRate >= 0.9);
  return allPassed ? 0 : 1;
}

main().then((code) => process.exit(code));
