import {
  RuntimeCapabilityProfile,
  RuntimeSession,
  RuntimeTurnInput,
} from './runtime-interface.js';

/**
 * ClaudeCodeRuntime is the future boundary wrapper around the Anthropic
 * Claude Code SDK integration. It is intentionally thin for now: the
 * current runner still executes the SDK inline in index.ts, but new
 * providers should target the same RuntimeSession shape.
 */
export class ClaudeCodeRuntime implements RuntimeSession {
  provider = 'anthropic' as const;

  capabilities: RuntimeCapabilityProfile = {
    provider: 'anthropic',
    textInput: 'native',
    imageInput: 'native',
    localImageFileInput: 'sdk-dependent',
    remoteImageUrlInput: 'native',
    base64ImageInput: 'native',
    toolUse: 'native',
    streamingText: 'native',
    sessionResume: 'native',
    notes: [
      'Current production path still runs inline through the Claude Code SDK in index.ts.',
      'This class exists to establish the provider boundary before behavior migrates here.',
    ],
  };

  async *runTurn(_input: RuntimeTurnInput) {
    throw new Error(
      'ClaudeCodeRuntime.runTurn is not wired yet. The current Anthropic path still runs inline in index.ts.',
    );
  }
}
