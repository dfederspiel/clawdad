import {
  AgentRuntimeConfig,
  RequiredRuntimeFeatures,
  ResolvedRuntimeProfile,
  RuntimeCapabilityProfile,
  RuntimeCompatibilityReport,
  RuntimeFeatureSet,
  RuntimeFeatureStatus,
  RuntimeModelClass,
  RuntimeSupportLevel,
} from './runtime-types.js';
import { getProviderCapabilityProfile } from './runtime-capabilities.js';

function supportLevelToStatus(
  level: RuntimeSupportLevel,
): RuntimeFeatureStatus {
  switch (level) {
    case 'native':
    case 'adapter-managed':
      return 'available';
    case 'model-dependent':
    case 'proxy-dependent':
    case 'sdk-dependent':
      return 'conditional';
    case 'unsupported':
    default:
      return 'unavailable';
  }
}

function inferModelClass(runtime: AgentRuntimeConfig): RuntimeModelClass {
  const model = `${runtime.model || ''}`.toLowerCase();
  if (!model) return 'unknown';

  const embeddingHints = [
    'embed',
    'embedding',
    'text-embedding',
    'nomic-embed',
    'bge-',
    'e5-',
    'minilm',
  ];
  if (embeddingHints.some((hint) => model.includes(hint))) {
    return 'embedding';
  }

  const visionHints = [
    'vision',
    'vl',
    'llava',
    'bakllava',
    'moondream',
    'minicpm-v',
    'qwen2.5-vl',
    'phi-3-vision',
    'gpt-4o',
    'gpt-4.1',
    'gemma3',
    'claude-3',
    'claude-sonnet-4',
    'claude-opus-4',
  ];
  if (visionHints.some((hint) => model.includes(hint))) {
    return 'vision-chat';
  }

  const toolHints = ['function', 'tool', 'reasoning'];
  if (toolHints.some((hint) => model.includes(hint))) {
    return 'tool-specialized';
  }

  return 'chat';
}

function buildFeatureSet(
  capabilities: RuntimeCapabilityProfile,
  modelClass: RuntimeModelClass,
): RuntimeFeatureSet {
  const base: RuntimeFeatureSet = {
    textGeneration:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.textInput),
    imageInput:
      modelClass === 'embedding'
        ? 'unavailable'
        : modelClass === 'vision-chat'
          ? capabilities.imageInput === 'unsupported'
            ? 'unavailable'
            : 'available'
          : supportLevelToStatus(capabilities.imageInput),
    localImageFileInput:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.localImageFileInput),
    remoteImageUrlInput:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.remoteImageUrlInput),
    base64ImageInput:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.base64ImageInput),
    toolUse:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.toolUse),
    streamingText:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.streamingText),
    sessionResume:
      modelClass === 'embedding'
        ? 'unavailable'
        : supportLevelToStatus(capabilities.sessionResume),
    embeddings: modelClass === 'embedding' ? 'available' : 'unavailable',
  };

  return base;
}

export function resolveRuntimeProfile(
  runtime?: AgentRuntimeConfig,
): ResolvedRuntimeProfile {
  const effectiveRuntime: AgentRuntimeConfig = runtime || {
    provider: 'anthropic',
  };
  const capabilities = getProviderCapabilityProfile(effectiveRuntime.provider);
  const modelClass = inferModelClass(effectiveRuntime);
  const features = buildFeatureSet(capabilities, modelClass);
  const notes = [...(capabilities.notes || [])];

  if (!effectiveRuntime.model) {
    notes.push(
      'No model selected yet; some effective capabilities remain conservative.',
    );
  }
  if (modelClass === 'embedding') {
    notes.push(
      'Embedding-class models should not be used as general chat/agent runtimes.',
    );
  }
  if (features.imageInput === 'conditional') {
    notes.push(
      'Image support should be verified against the specific model or deployment.',
    );
  }

  return {
    runtime: effectiveRuntime,
    provider: effectiveRuntime.provider,
    model: effectiveRuntime.model,
    modelClass,
    capabilities,
    features,
    notes,
  };
}

function featureRank(status: RuntimeFeatureStatus): number {
  switch (status) {
    case 'available':
      return 2;
    case 'conditional':
      return 1;
    case 'unavailable':
    default:
      return 0;
  }
}

function featureMeetsRequirement(
  status: RuntimeFeatureStatus,
  required: boolean | undefined,
): boolean {
  if (!required) return true;
  return featureRank(status) >= 1;
}

export function profileMeetsRequirements(
  profile: ResolvedRuntimeProfile,
  required: RequiredRuntimeFeatures,
): boolean {
  return (
    featureMeetsRequirement(
      profile.features.textGeneration,
      required.textGeneration,
    ) &&
    featureMeetsRequirement(profile.features.imageInput, required.imageInput) &&
    featureMeetsRequirement(profile.features.toolUse, required.toolUse) &&
    featureMeetsRequirement(
      profile.features.streamingText,
      required.streamingText,
    ) &&
    featureMeetsRequirement(
      profile.features.sessionResume,
      required.sessionResume,
    ) &&
    featureMeetsRequirement(profile.features.embeddings, required.embeddings)
  );
}

export function compareRuntimeProfiles(
  current: ResolvedRuntimeProfile,
  next: ResolvedRuntimeProfile,
  required: RequiredRuntimeFeatures = {},
): RuntimeCompatibilityReport {
  const downgradedFeatures: Array<keyof RequiredRuntimeFeatures> = [];
  const upgradedFeatures: Array<keyof RequiredRuntimeFeatures> = [];
  const notes: string[] = [];

  const comparable: Array<keyof RequiredRuntimeFeatures> = [
    'textGeneration',
    'imageInput',
    'toolUse',
    'streamingText',
    'sessionResume',
    'embeddings',
  ];

  for (const feature of comparable) {
    const currentRank = featureRank(current.features[feature]);
    const nextRank = featureRank(next.features[feature]);
    if (nextRank < currentRank) downgradedFeatures.push(feature);
    if (nextRank > currentRank) upgradedFeatures.push(feature);
  }

  let blockedByModelClass: string | undefined;
  if (
    current.modelClass !== 'embedding' &&
    next.modelClass === 'embedding' &&
    (required.textGeneration || required.toolUse || required.imageInput)
  ) {
    blockedByModelClass =
      'Replacement would move the agent from a chat-capable model to an embedding-only model.';
  }

  const compatible =
    !blockedByModelClass && profileMeetsRequirements(next, required);

  if (!compatible && downgradedFeatures.length > 0) {
    notes.push(
      `Replacement downgrades required features: ${downgradedFeatures.join(', ')}.`,
    );
  }
  if (upgradedFeatures.length > 0) {
    notes.push(
      `Replacement improves features: ${upgradedFeatures.join(', ')}.`,
    );
  }
  if (next.features.imageInput === 'conditional') {
    notes.push(
      'Image input remains conditional and should be verified for the chosen model.',
    );
  }

  return {
    compatible,
    downgradedFeatures,
    upgradedFeatures,
    blockedByModelClass,
    notes,
  };
}
