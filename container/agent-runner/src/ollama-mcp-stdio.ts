/**
 * Ollama MCP Server for NanoClaw
 * Exposes local Ollama models as tools for the container agent.
 * Uses host.docker.internal to reach the host's Ollama instance from Docker.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import fs from 'fs';
import path from 'path';

import { DEFAULT_OLLAMA_HOST, getOllamaClient } from './ollama-client.js';

const OLLAMA_ADMIN_TOOLS = process.env.OLLAMA_ADMIN_TOOLS === 'true';
const OLLAMA_STATUS_FILE = '/workspace/ipc/ollama_status.json';

function log(msg: string): void {
  console.error(`[OLLAMA] ${msg}`);
}

function writeStatus(status: string, detail?: string): void {
  try {
    const data = { status, detail, timestamp: new Date().toISOString() };
    const tmpPath = `${OLLAMA_STATUS_FILE}.tmp`;
    fs.mkdirSync(path.dirname(OLLAMA_STATUS_FILE), { recursive: true });
    fs.writeFileSync(tmpPath, JSON.stringify(data));
    fs.renameSync(tmpPath, OLLAMA_STATUS_FILE);
  } catch {
    /* best-effort */
  }
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ollamaHostForError(): string {
  return process.env.OLLAMA_HOST || DEFAULT_OLLAMA_HOST;
}

const server = new McpServer({
  name: 'ollama',
  version: '1.0.0',
});

server.tool(
  'ollama_list_models',
  'List all locally installed Ollama models. Use this to see which models are available before calling ollama_generate.',
  {},
  async () => {
    log('Listing models...');
    writeStatus('listing', 'Listing available models');
    try {
      const { models } = await getOllamaClient().list();
      if (!models || models.length === 0) {
        return {
          content: [
            {
              type: 'text' as const,
              text: 'No models installed. Run `ollama pull <model>` on the host to install one.',
            },
          ],
        };
      }
      const list = models
        .map((m) => `- ${m.name} (${(m.size / 1e9).toFixed(1)}GB)`)
        .join('\n');
      log(`Found ${models.length} models`);
      return {
        content: [
          { type: 'text' as const, text: `Installed models:\n${list}` },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to connect to Ollama at ${ollamaHostForError()}: ${errorText(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'ollama_generate',
  'Send a prompt to a local Ollama model and get a response. Good for cheaper/faster tasks like summarization, translation, or general queries. Use ollama_list_models first to see available models.',
  {
    model: z.string().describe('The model name (e.g., "llama3.2", "mistral", "gemma2")'),
    prompt: z.string().describe('The prompt to send to the model'),
    system: z.string().optional().describe('Optional system prompt to set model behavior'),
  },
  async (args) => {
    log(`>>> Generating with ${args.model} (${args.prompt.length} chars)...`);
    writeStatus('generating', `Generating with ${args.model}`);
    try {
      const data = await getOllamaClient().generate({
        model: args.model,
        prompt: args.prompt,
        system: args.system,
        stream: false,
      });

      let meta = '';
      if (data.total_duration) {
        const secs = (data.total_duration / 1e9).toFixed(1);
        meta = `\n\n[${args.model} | ${secs}s${data.eval_count ? ` | ${data.eval_count} tokens` : ''}]`;
        log(
          `<<< Done: ${args.model} | ${secs}s | ${data.eval_count || '?'} tokens | ${data.response.length} chars`,
        );
        writeStatus('done', `${args.model} | ${secs}s | ${data.eval_count || '?'} tokens`);
      } else {
        log(`<<< Done: ${args.model} | ${data.response.length} chars`);
        writeStatus('done', `${args.model} | ${data.response.length} chars`);
      }

      return { content: [{ type: 'text' as const, text: data.response + meta }] };
    } catch (err) {
      return {
        content: [
          { type: 'text' as const, text: `Failed to call Ollama: ${errorText(err)}` },
        ],
        isError: true,
      };
    }
  },
);

// Management tools — only registered when OLLAMA_ADMIN_TOOLS=true
if (OLLAMA_ADMIN_TOOLS) {
  server.tool(
    'ollama_pull_model',
    'Pull (download) a model from the Ollama registry by name. Returns the final status once the pull is complete. Use model names like "llama3.2", "mistral", "gemma2:9b".',
    {
      model: z.string().describe('Model name to pull, e.g. "llama3.2", "mistral", "gemma2:9b"'),
    },
    async (args) => {
      log(`Pulling model: ${args.model}...`);
      writeStatus('pulling', `Pulling ${args.model}`);
      try {
        const data = await getOllamaClient().pull({ model: args.model, stream: false });
        log(`Pull complete: ${args.model} — ${data.status}`);
        writeStatus('done', `Pulled ${args.model}`);
        return {
          content: [
            {
              type: 'text' as const,
              text: `Pull complete: ${args.model} — ${data.status}`,
            },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Failed to pull model: ${errorText(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_delete_model',
    'Delete a locally installed Ollama model to free up disk space.',
    {
      model: z.string().describe('Model name to delete, e.g. "llama3.2", "mistral:latest"'),
    },
    async (args) => {
      log(`Deleting model: ${args.model}...`);
      writeStatus('deleting', `Deleting ${args.model}`);
      try {
        await getOllamaClient().delete({ model: args.model });
        log(`Deleted: ${args.model}`);
        writeStatus('done', `Deleted ${args.model}`);
        return { content: [{ type: 'text' as const, text: `Deleted model: ${args.model}` }] };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Failed to delete model: ${errorText(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_show_model',
    'Show details for a locally installed Ollama model: modelfile, parameters, template, system prompt, and architecture info.',
    {
      model: z.string().describe('Model name to inspect, e.g. "llama3.2", "mistral:latest"'),
    },
    async (args) => {
      log(`Showing model info: ${args.model}...`);
      try {
        const data = await getOllamaClient().show({ model: args.model });
        return {
          content: [{ type: 'text' as const, text: JSON.stringify(data, null, 2) }],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Failed to show model info: ${errorText(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  server.tool(
    'ollama_list_running',
    'List Ollama models currently loaded in memory with their memory usage, processor type (CPU/GPU), and time until they are unloaded.',
    {},
    async () => {
      log('Listing running models...');
      try {
        const { models } = await getOllamaClient().ps();
        if (!models || models.length === 0) {
          return {
            content: [
              { type: 'text' as const, text: 'No models currently loaded in memory.' },
            ],
          };
        }
        const list = models
          .map((m) => {
            const size = m.size_vram > 0 ? m.size_vram : m.size;
            return `- ${m.name} (${(size / 1e9).toFixed(1)}GB ${(m as { processor?: string }).processor ?? ''}, unloads at ${m.expires_at})`;
          })
          .join('\n');
        log(`${models.length} model(s) running`);
        return {
          content: [
            { type: 'text' as const, text: `Models loaded in memory:\n${list}` },
          ],
        };
      } catch (err) {
        return {
          content: [
            { type: 'text' as const, text: `Failed to list running models: ${errorText(err)}` },
          ],
          isError: true,
        };
      }
    },
  );

  log('Admin tools enabled (pull, delete, show, list-running)');
}

const transport = new StdioServerTransport();
await server.connect(transport);
