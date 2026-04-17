import { RuntimeCapabilityProfile, RuntimeProvider } from './runtime-types.js';

/**
 * Provider capability presets are intentionally coarse.
 * They describe integration expectations for boundary design,
 * not a promise that every model on a provider supports every feature.
 */
export const PROVIDER_CAPABILITY_PRESETS: Record<
  RuntimeProvider,
  RuntimeCapabilityProfile
> = {
  anthropic: {
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
      'Claude models broadly support image input in official docs.',
      'The current Claude Code SDK runner is the strongest fit for native session resume.',
      'Local file attachment ergonomics depend on SDK/runtime encoding, not just the API surface.',
    ],
  },
  openai: {
    provider: 'openai',
    textInput: 'native',
    imageInput: 'native',
    localImageFileInput: 'adapter-managed',
    remoteImageUrlInput: 'native',
    base64ImageInput: 'native',
    toolUse: 'native',
    streamingText: 'native',
    sessionResume: 'adapter-managed',
    notes: [
      'Official OpenAI docs support multimodal image input.',
      'Conversation/session continuation semantics are expected to be managed by the ClawDad runtime adapter.',
    ],
  },
  ollama: {
    provider: 'ollama',
    textInput: 'native',
    imageInput: 'model-dependent',
    localImageFileInput: 'adapter-managed',
    remoteImageUrlInput: 'unsupported',
    base64ImageInput: 'model-dependent',
    toolUse: 'adapter-managed',
    streamingText: 'native',
    sessionResume: 'adapter-managed',
    notes: [
      'Vision is available, but support depends on the selected local model.',
      'Expect the widest variance in multimodal behavior here.',
    ],
  },
  'github-copilot': {
    provider: 'github-copilot',
    textInput: 'native',
    imageInput: 'native',
    localImageFileInput: 'native',
    remoteImageUrlInput: 'unsupported',
    base64ImageInput: 'native',
    toolUse: 'sdk-dependent',
    streamingText: 'native',
    sessionResume: 'sdk-dependent',
    notes: [
      'GitHub Copilot SDK documents file and blob image attachments.',
      'Availability and model support vary by client, plan, and preview status.',
    ],
  },
  'azure-openai': {
    provider: 'azure-openai',
    textInput: 'native',
    imageInput: 'model-dependent',
    localImageFileInput: 'adapter-managed',
    remoteImageUrlInput: 'native',
    base64ImageInput: 'native',
    toolUse: 'native',
    streamingText: 'native',
    sessionResume: 'adapter-managed',
    notes: [
      'Azure OpenAI generally tracks OpenAI model capabilities but adds deployment and region constraints.',
    ],
  },
  openrouter: {
    provider: 'openrouter',
    textInput: 'native',
    imageInput: 'proxy-dependent',
    localImageFileInput: 'adapter-managed',
    remoteImageUrlInput: 'proxy-dependent',
    base64ImageInput: 'proxy-dependent',
    toolUse: 'proxy-dependent',
    streamingText: 'native',
    sessionResume: 'adapter-managed',
    notes: [
      'Capability depends on the routed upstream provider/model.',
      'Treat feature support as negotiated at model selection time.',
    ],
  },
  litellm: {
    provider: 'litellm',
    textInput: 'native',
    imageInput: 'proxy-dependent',
    localImageFileInput: 'adapter-managed',
    remoteImageUrlInput: 'proxy-dependent',
    base64ImageInput: 'proxy-dependent',
    toolUse: 'proxy-dependent',
    streamingText: 'native',
    sessionResume: 'adapter-managed',
    notes: [
      'LiteLLM is best treated as a compatibility proxy, not a capability source of truth.',
    ],
  },
};

export function getProviderCapabilityProfile(
  provider: RuntimeProvider,
): RuntimeCapabilityProfile {
  return PROVIDER_CAPABILITY_PRESETS[provider];
}
