export interface DeliveryLease {
  chatJid: string;
  startEpoch: number;
  batchId: string;
}

interface ChatFrontier {
  epoch: number;
  activeBatchIds: Set<string>;
}

const frontiers = new Map<string, ChatFrontier>();

function getFrontier(chatJid: string): ChatFrontier {
  let frontier = frontiers.get(chatJid);
  if (!frontier) {
    frontier = { epoch: 0, activeBatchIds: new Set() };
    frontiers.set(chatJid, frontier);
  }
  return frontier;
}

export function getConversationEpoch(chatJid: string): number {
  return getFrontier(chatJid).epoch;
}

export function beginDeliveryLease(
  chatJid: string,
  batchId: string,
): DeliveryLease {
  return {
    chatJid,
    batchId,
    startEpoch: getConversationEpoch(chatJid),
  };
}

export function noteVisibleMessage(
  chatJid: string,
  batchId: string | null = null,
): number {
  const frontier = getFrontier(chatJid);
  frontier.epoch += 1;
  if (batchId) {
    frontier.activeBatchIds.add(batchId);
  }
  // When batchId is null (user message), do NOT clear activeBatchIds.
  // In-flight agent runs have leases with batchIds that must survive
  // new user messages — the agent is already processing and should
  // still deliver its output. The epoch bump alone prevents new stale
  // agents from delivering.
  return frontier.epoch;
}

export function shouldDeliverForLease(lease: DeliveryLease): boolean {
  const frontier = getFrontier(lease.chatJid);
  return (
    frontier.epoch === lease.startEpoch ||
    frontier.activeBatchIds.has(lease.batchId)
  );
}

export function markLeaseDelivered(lease: DeliveryLease): number {
  return noteVisibleMessage(lease.chatJid, lease.batchId);
}

export function resetSupersessionState(): void {
  frontiers.clear();
}

export function resetChatSupersessionState(chatJid: string): void {
  frontiers.delete(chatJid);
}
