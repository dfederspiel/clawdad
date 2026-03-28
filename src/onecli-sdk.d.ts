/**
 * Type declarations for @onecli-sh/sdk
 *
 * This is a private package that provides the OneCLI Agent Vault SDK.
 * When not installed, the runtime gracefully degrades (containers run
 * without credential injection). This declaration lets the build pass
 * regardless.
 */
declare module '@onecli-sh/sdk' {
  export interface OneCLIOptions {
    url?: string;
  }

  export interface EnsureAgentOptions {
    name: string;
    identifier: string;
  }

  export interface EnsureAgentResult {
    created: boolean;
  }

  export interface ApplyContainerConfigOptions {
    addHostMapping?: boolean;
    agent?: string;
  }

  export class OneCLI {
    constructor(options?: OneCLIOptions);
    ensureAgent(options: EnsureAgentOptions): Promise<EnsureAgentResult>;
    applyContainerConfig(
      args: string[],
      options?: ApplyContainerConfigOptions,
    ): Promise<boolean>;
  }
}
