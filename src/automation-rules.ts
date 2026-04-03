import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { resolveGroupFolderPath } from './group-folder.js';
import { logger } from './logger.js';

// ── Types ──────────────────────────────────────────────────────────

export interface AutomationRuleTrigger {
  event: 'message' | 'agent_result' | 'task_completed';
  pattern?: string;
  sender?: 'user' | 'assistant';
  agent?: string;
  contains?: string;
  taskId?: string;
  groupFolder?: string;
}

export interface AutomationRuleAction {
  type: 'delegate_to_agent' | 'fan_out' | 'post_system_note' | 'set_subtitle';
  agent?: string;
  agents?: string[];
  silent?: boolean;
  messageTemplate?: string;
  text?: string;
  visible?: boolean;
}

export interface AutomationRule {
  id: string;
  enabled: boolean;
  when: AutomationRuleTrigger;
  then: AutomationRuleAction[];
}

export interface AutomationEvent {
  type: 'message' | 'agent_result' | 'task_completed';
  groupJid: string;
  groupFolder: string;
  messageContent?: string;
  senderType?: 'user' | 'assistant';
  agentName?: string;
  resultContent?: string;
  taskId?: string;
}

export interface AutomationTraceEntry {
  timestamp: string;
  groupJid: string;
  groupFolder: string;
  sourceEvent: string;
  ruleId: string;
  actions: Array<{
    type: string;
    targetAgent?: string;
    silent: boolean;
  }>;
  outcome: 'would_fire';
  eventSummary: string;
}

// ── Rule loading ───────────────────────────────────────────────────

export function loadGroupAutomationRules(
  groupFolder: string,
): AutomationRule[] {
  let groupDir: string;
  try {
    groupDir = resolveGroupFolderPath(groupFolder);
  } catch {
    return [];
  }
  const configPath = path.join(groupDir, 'group-config.json');
  if (!fs.existsSync(configPath)) return [];
  try {
    const disk = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    const rules: unknown[] = disk.automation;
    if (!Array.isArray(rules)) return [];

    const valid: AutomationRule[] = [];
    for (const raw of rules) {
      const r = raw as Record<string, unknown>;
      if (typeof r.id !== 'string' || !r.when || !Array.isArray(r.then)) {
        logger.warn(
          { groupFolder, ruleId: r.id ?? '<missing>' },
          '[automation] skipping malformed rule',
        );
        continue;
      }
      const when = r.when as Record<string, unknown>;
      if (!when.event) {
        logger.warn(
          { groupFolder, ruleId: r.id },
          '[automation] skipping rule with missing event',
        );
        continue;
      }
      if (r.enabled === false) continue;
      valid.push(r as unknown as AutomationRule);
    }

    return valid;
  } catch (err) {
    logger.warn(
      { groupFolder, err },
      '[automation] failed to parse group-config.json',
    );
    return [];
  }
}

// ── Rule evaluation ────────────────────────────────────────────────

function matchesTrigger(
  trigger: AutomationRuleTrigger,
  event: AutomationEvent,
): boolean {
  if (trigger.event !== event.type) return false;

  switch (trigger.event) {
    case 'message': {
      if (trigger.sender && trigger.sender !== event.senderType) return false;
      if (trigger.pattern) {
        try {
          if (!new RegExp(trigger.pattern).test(event.messageContent || ''))
            return false;
        } catch {
          logger.warn(
            { pattern: trigger.pattern },
            '[automation] invalid regex pattern, skipping',
          );
          return false;
        }
      }
      return true;
    }
    case 'agent_result': {
      if (trigger.agent && trigger.agent !== event.agentName) return false;
      if (
        trigger.contains &&
        !(event.resultContent || '').includes(trigger.contains)
      )
        return false;
      return true;
    }
    case 'task_completed': {
      if (trigger.taskId && trigger.taskId !== event.taskId) return false;
      if (trigger.groupFolder && trigger.groupFolder !== event.groupFolder)
        return false;
      return true;
    }
    default:
      return false;
  }
}

function buildEventSummary(event: AutomationEvent): string {
  switch (event.type) {
    case 'message':
      return `message from ${event.senderType || 'unknown'}`;
    case 'agent_result':
      return `agent_result from ${event.agentName || 'unknown'}`;
    case 'task_completed':
      return `task_completed${event.taskId ? ` (${event.taskId})` : ''}`;
    default:
      return event.type;
  }
}

function mapActions(
  actions: AutomationRuleAction[],
): AutomationTraceEntry['actions'] {
  return actions.map((a) => ({
    type: a.type,
    targetAgent: a.type === 'fan_out' ? a.agents?.join(', ') : a.agent,
    silent: a.silent ?? false,
  }));
}

export function evaluateRules(
  rules: AutomationRule[],
  event: AutomationEvent,
): AutomationTraceEntry[] {
  const traces: AutomationTraceEntry[] = [];
  for (const rule of rules) {
    if (matchesTrigger(rule.when, event)) {
      traces.push({
        timestamp: new Date().toISOString(),
        groupJid: event.groupJid,
        groupFolder: event.groupFolder,
        sourceEvent: event.type,
        ruleId: rule.id,
        actions: mapActions(rule.then),
        outcome: 'would_fire',
        eventSummary: buildEventSummary(event),
      });
    }
  }
  return traces;
}

// ── Trace emission ─────────────────────────────────────────────────

export function emitTraces(traces: AutomationTraceEntry[]): void {
  for (const trace of traces) {
    logger.info(
      {
        ruleId: trace.ruleId,
        groupFolder: trace.groupFolder,
        sourceEvent: trace.sourceEvent,
        actions: trace.actions,
        outcome: trace.outcome,
        eventSummary: trace.eventSummary,
      },
      '[automation] rule matched (dry-run)',
    );
  }
}

// ── Convenience: load + evaluate + emit in one call ────────────────

export function evaluateAutomationRules(
  groupFolder: string,
  event: AutomationEvent,
): void {
  const rules = loadGroupAutomationRules(groupFolder);
  if (rules.length === 0) return;
  const traces = evaluateRules(rules, event);
  if (traces.length > 0) {
    emitTraces(traces);
  }
}
