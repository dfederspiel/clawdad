/**
 * Session Reflection
 *
 * Calls a cheap model (Haiku) with recent conversation messages to generate
 * suggested memory items for a session retrospective. The user reviews and
 * edits these before they're saved to CLAUDE.md.
 */
import https from 'https';
import http from 'http';

import { resolveAnthropicCredentials } from './credential-proxy.js';
import { logger } from './logger.js';
import { SessionSummaryMessage } from './db.js';

export interface ReflectionItem {
  text: string;
  category: 'decision' | 'preference' | 'context' | 'learning';
}

const REFLECTION_MODEL = 'claude-haiku-4-5-20251001';

const SYSTEM_PROMPT = `You are reviewing a conversation between a user and an AI agent. Your job is to identify things worth remembering for future sessions.

Return a JSON array of 3-8 items. Each item has:
- "text": a concise, actionable note (1-2 sentences)
- "category": one of "decision" (choices made), "preference" (how the user likes things), "context" (ongoing work/state), "learning" (things the agent discovered)

Focus on things that would help the agent serve the user better in a fresh session. Skip trivial or obvious things. If the conversation is too short or has nothing worth remembering, return an empty array.

Respond with ONLY the JSON array, no other text.`;

export async function generateReflection(
  messages: SessionSummaryMessage[],
): Promise<ReflectionItem[]> {
  if (messages.length === 0) return [];

  const conversation = messages
    .map((m) => `[${m.sender_name}]: ${m.content}`)
    .join('\n');

  const userPrompt = `Here is the recent conversation to reflect on:\n\n${conversation}`;

  try {
    const text = await callModel(SYSTEM_PROMPT, userPrompt);
    const parsed = JSON.parse(text);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (item: any) =>
        typeof item.text === 'string' &&
        typeof item.category === 'string' &&
        ['decision', 'preference', 'context', 'learning'].includes(
          item.category,
        ),
    );
  } catch (err) {
    logger.warn(
      { err },
      'Session reflection failed, returning empty suggestions',
    );
    return [];
  }
}

async function callModel(
  systemPrompt: string,
  userMessage: string,
): Promise<string> {
  const creds = resolveAnthropicCredentials();

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'anthropic-version': '2023-06-01',
  };

  if (creds.authMode === 'api-key' && creds.apiKey) {
    headers['x-api-key'] = creds.apiKey;
  } else if (creds.oauthToken) {
    headers['Authorization'] = `Bearer ${creds.oauthToken}`;
  } else {
    throw new Error(
      'No Anthropic credentials available for session reflection',
    );
  }

  const body = JSON.stringify({
    model: REFLECTION_MODEL,
    max_tokens: 2048,
    system: systemPrompt,
    messages: [{ role: 'user', content: userMessage }],
  });

  const targetUrl = `${creds.baseUrl}/v1/messages`;

  return new Promise((resolve, reject) => {
    const url = new URL(targetUrl);
    const transport = url.protocol === 'https:' ? https : http;

    const req = transport.request(
      url,
      {
        method: 'POST',
        headers: { ...headers, 'Content-Length': Buffer.byteLength(body) },
        timeout: 30000,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const responseBody = Buffer.concat(chunks).toString();
          if (res.statusCode !== 200) {
            reject(
              new Error(
                `Reflection API returned ${res.statusCode}: ${responseBody.slice(0, 300)}`,
              ),
            );
            return;
          }
          try {
            const parsed = JSON.parse(responseBody);
            const text = parsed.content?.[0]?.text;
            if (!text) {
              reject(new Error('No text in reflection response'));
              return;
            }
            resolve(text);
          } catch (err) {
            reject(new Error(`Failed to parse reflection response: ${err}`));
          }
        });
      },
    );

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Reflection API call timed out'));
    });
    req.write(body);
    req.end();
  });
}
