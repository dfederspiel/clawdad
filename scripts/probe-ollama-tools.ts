#!/usr/bin/env node
/**
 * probe-ollama-tools — empirical test for whether an Ollama model emits
 * structured `tool_calls` in response to a tool schema.
 *
 * Goes straight to /api/chat with raw fetch — no ollama-js, no ToolBridge,
 * no runtime wrapper. That way the output answers exactly one question:
 * "given this model and this tools array, does the model produce
 * tool_calls, narrate them, or ignore them?"
 *
 * Usage:
 *   npx tsx scripts/probe-ollama-tools.ts <model> [prompt]
 *   OLLAMA_HOST=http://localhost:11434 npx tsx scripts/probe-ollama-tools.ts llama3.2:1b
 *
 * Exit codes:
 *   0 — model returned at least one structured tool_call
 *   1 — model returned text only (no tool_calls) — may still have narrated
 *   2 — HTTP / transport failure (Ollama not reachable, model not pulled, etc.)
 */

const host = process.env.OLLAMA_HOST || 'http://localhost:11434';
const model = process.argv[2];
const promptArg = process.argv[3];

if (!model) {
  console.error(
    'usage: npx tsx scripts/probe-ollama-tools.ts <model> [prompt]',
  );
  console.error(
    'example: npx tsx scripts/probe-ollama-tools.ts llama3.2:1b "what time is it in Tokyo?"',
  );
  process.exit(2);
}

const tool = {
  type: 'function' as const,
  function: {
    name: 'get_current_time',
    description:
      'Return the current wall-clock time in a given IANA timezone. Call this whenever the user asks what time it is, or asks for a timestamp in a specific city or region.',
    parameters: {
      type: 'object',
      properties: {
        timezone: {
          type: 'string',
          description: 'IANA timezone, e.g. "America/New_York" or "UTC".',
        },
      },
      required: ['timezone'],
    },
  },
};

const prompt =
  promptArg ||
  'What time is it in Tokyo right now? Use the available tool — do not guess.';

const requestBody = {
  model,
  messages: [
    {
      role: 'system',
      content:
        'You have access to tools. When a question can be answered with a tool, invoke it rather than guessing.',
    },
    { role: 'user', content: prompt },
  ],
  tools: [tool],
  stream: false,
};

async function main(): Promise<number> {
  console.log(`--- Probe: ${model} at ${host} ---`);
  console.log('Request body:');
  console.log(JSON.stringify(requestBody, null, 2));
  console.log('');

  const started = Date.now();
  let res: Response;
  try {
    res = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    console.error('Transport error:', err instanceof Error ? err.message : err);
    return 2;
  }

  const elapsed = Date.now() - started;
  if (!res.ok) {
    console.error(`HTTP ${res.status} in ${elapsed}ms`);
    console.error(await res.text());
    return 2;
  }

  const body = (await res.json()) as {
    model?: string;
    message?: {
      role: string;
      content?: string;
      tool_calls?: Array<{
        function?: { name?: string; arguments?: unknown };
      }>;
    };
    done_reason?: string;
    total_duration?: number;
  };
  console.log(`Response (${elapsed}ms):`);
  console.log(JSON.stringify(body, null, 2));
  console.log('');

  const toolCalls = body.message?.tool_calls || [];
  const content = body.message?.content || '';
  console.log('--- Verdict ---');
  console.log(`tool_calls returned: ${toolCalls.length}`);
  if (toolCalls.length > 0) {
    for (const [i, c] of toolCalls.entries()) {
      console.log(
        `  [${i}] name=${c.function?.name} args=${JSON.stringify(c.function?.arguments)}`,
      );
    }
  }
  console.log(
    `text content: ${content.length > 0 ? `${content.length} chars` : 'empty'}`,
  );
  if (content.length > 0 && content.length < 600) {
    console.log(`text: ${JSON.stringify(content)}`);
  }

  if (toolCalls.length > 0) {
    console.log('RESULT: structured tool_calls ✓');
    return 0;
  }
  console.log('RESULT: no tool_calls (text-only response)');
  return 1;
}

main().then((code) => process.exit(code));
