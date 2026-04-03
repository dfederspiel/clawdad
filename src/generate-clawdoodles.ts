/**
 * Clawdoodle generator — calls Claude API to produce personalized agent templates
 * from the blocks library based on user interview answers.
 */
import fs from 'fs';
import path from 'path';
import https from 'https';
import http from 'http';

import { readEnvFile } from './env.js';
import { logger } from './logger.js';

export interface InterviewAnswers {
  user_name: string;
  vibe: string;
  interests: string[];
  interests_custom?: string;
  scenarios: string[];
  scenarios_custom?: string;
  difficulty: string;
}

interface GeneratedClawdoodle {
  id: string;
  name: string;
  description: string;
  tier: string;
  claude_md: string;
  agent_config: Record<string, unknown>;
}

export interface ClawdoodleSummary {
  id: string;
  name: string;
  description: string;
  tier: string;
  source: 'generated';
}

const CLAWDOODLES_DIR = path.resolve(process.cwd(), 'clawdoodles');

/** Load all blocks and fragments from disk, assemble the generator prompt. */
function buildSystemPrompt(): string {
  const promptPath = path.join(CLAWDOODLES_DIR, 'generator-prompt.md');
  let prompt = fs.readFileSync(promptPath, 'utf-8');

  // Load blocks
  const blocksDir = path.join(CLAWDOODLES_DIR, 'blocks');
  const blockContents: string[] = [];
  if (fs.existsSync(blocksDir)) {
    for (const file of fs.readdirSync(blocksDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(blocksDir, file), 'utf-8');
      blockContents.push(`### Block: ${file.replace('.md', '')}\n\n${content}`);
    }
  }

  // Load fragments
  const fragmentsDir = path.join(CLAWDOODLES_DIR, 'fragments');
  const fragmentContents: string[] = [];
  if (fs.existsSync(fragmentsDir)) {
    for (const file of fs.readdirSync(fragmentsDir).sort()) {
      if (!file.endsWith('.md')) continue;
      const content = fs.readFileSync(path.join(fragmentsDir, file), 'utf-8');
      fragmentContents.push(
        `### Fragment: ${file.replace('.md', '')}\n\n${content}`,
      );
    }
  }

  prompt = prompt.replace('{{BLOCKS}}', blockContents.join('\n\n---\n\n'));
  prompt = prompt.replace(
    '{{FRAGMENTS}}',
    fragmentContents.join('\n\n---\n\n'),
  );

  return prompt;
}

/** Build the user message from interview answers. */
function buildUserMessage(answers: InterviewAnswers): string {
  const parts = [
    `Name: ${answers.user_name}`,
    `Vibe: ${answers.vibe}`,
    `Interests: ${answers.interests.join(', ')}`,
  ];
  if (answers.interests_custom) {
    parts.push(`Custom interests: ${answers.interests_custom}`);
  }
  parts.push(`Scenarios they want: ${answers.scenarios.join(', ')}`);
  if (answers.scenarios_custom) {
    parts.push(`Custom scenario: ${answers.scenarios_custom}`);
  }
  parts.push(`Difficulty: ${answers.difficulty}`);

  return parts.join('\n');
}

/**
 * Resolve the Anthropic API key. Tries:
 * Tries ANTHROPIC_API_KEY from .env, then from process.env.
 */
function resolveApiKey(): string | null {
  const envVars = readEnvFile(['ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']);
  return process.env.ANTHROPIC_API_KEY || envVars.ANTHROPIC_API_KEY || null;
}

/** Resolve the Anthropic base URL. */
function resolveBaseUrl(): string {
  const envVars = readEnvFile(['ANTHROPIC_BASE_URL']);
  return (
    process.env.ANTHROPIC_BASE_URL ||
    envVars.ANTHROPIC_BASE_URL ||
    'https://api.anthropic.com'
  );
}

/** Call the Claude API directly with an API key. */
async function callClaude(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const apiKey = resolveApiKey();
  const baseUrl = resolveBaseUrl();

  if (!apiKey) {
    throw new Error(
      'No Anthropic API key found. Set ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN in .env',
    );
  }

  const targetUrl = `${baseUrl}/v1/messages`;
  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': apiKey,
    'anthropic-version': '2023-06-01',
  };

  const body = JSON.stringify({
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6-20250627',
    max_tokens: 16000,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: {
          ...headers,
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 120000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Claude API returned ${res.statusCode}: ${responseBody.slice(0, 500)}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(responseBody);
            const text = parsed.content?.[0]?.text;
            if (!text) {
              reject(new Error('No text content in Claude response'));
              return;
            }
            resolve(text);
          } catch (err) {
            reject(new Error(`Failed to parse Claude response: ${err}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Claude API request timed out (120s)'));
    });

    req.write(body);
    req.end();
  });
}

/** Parse the AI response into structured Clawdoodles. */
function parseResponse(text: string): GeneratedClawdoodle[] {
  // Strip markdown code fences if present
  let cleaned = text.trim();
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:json)?\n?/, '').replace(/\n?```$/, '');
  }

  const parsed = JSON.parse(cleaned);
  if (!Array.isArray(parsed) || parsed.length === 0) {
    throw new Error('Expected a non-empty JSON array');
  }

  // Validate each entry
  for (const item of parsed) {
    if (!item.id || !item.name || !item.claude_md) {
      throw new Error(
        `Invalid Clawdoodle: missing required fields (id, name, claude_md)`,
      );
    }
  }

  return parsed;
}

/** Write generated Clawdoodles to disk. */
function writeClawdoodles(
  clawdoodles: GeneratedClawdoodle[],
): ClawdoodleSummary[] {
  const generatedDir = path.join(CLAWDOODLES_DIR, 'generated');
  fs.mkdirSync(generatedDir, { recursive: true });

  const summaries: ClawdoodleSummary[] = [];

  for (const doodle of clawdoodles) {
    const dir = path.join(generatedDir, doodle.id);
    fs.mkdirSync(dir, { recursive: true });

    // meta.json
    fs.writeFileSync(
      path.join(dir, 'meta.json'),
      JSON.stringify(
        {
          name: doodle.name,
          description: doodle.description,
          tier: doodle.tier || 'recipe',
        },
        null,
        2,
      ) + '\n',
    );

    // CLAUDE.md
    fs.writeFileSync(path.join(dir, 'CLAUDE.md'), doodle.claude_md + '\n');

    // agent-config.example.json
    fs.writeFileSync(
      path.join(dir, 'agent-config.example.json'),
      JSON.stringify(doodle.agent_config || {}, null, 2) + '\n',
    );

    summaries.push({
      id: doodle.id,
      name: doodle.name,
      description: doodle.description,
      tier: doodle.tier || 'recipe',
      source: 'generated',
    });
  }

  return summaries;
}

/** Clean up previously generated Clawdoodles. */
function clearGenerated(): void {
  const generatedDir = path.join(CLAWDOODLES_DIR, 'generated');
  if (fs.existsSync(generatedDir)) {
    fs.rmSync(generatedDir, { recursive: true, force: true });
    fs.mkdirSync(generatedDir, { recursive: true });
  }
}

/**
 * Generate 3 personalized Clawdoodles from interview answers.
 * Returns summaries for the frontend, or null if generation fails.
 */
export async function generateClawdoodles(
  answers: InterviewAnswers,
): Promise<ClawdoodleSummary[] | null> {
  try {
    logger.info({ answers }, 'Generating Clawdoodles from interview');

    const systemPrompt = buildSystemPrompt();
    const userMessage = buildUserMessage(answers);

    const response = await callClaude(systemPrompt, userMessage);
    const clawdoodles = parseResponse(response);

    // Clear old generated ones and write new
    clearGenerated();
    const summaries = writeClawdoodles(clawdoodles);

    logger.info(
      { count: summaries.length, ids: summaries.map((s) => s.id) },
      'Clawdoodles generated successfully',
    );

    return summaries;
  } catch (err) {
    logger.error({ err }, 'Failed to generate Clawdoodles');
    return null;
  }
}
