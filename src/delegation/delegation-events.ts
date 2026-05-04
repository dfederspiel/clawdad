import { DelegationRun } from './types.js';

export type DelegationEventName =
  | 'delegation.created'
  | 'delegation.started'
  | 'delegation.output'
  | 'delegation.completed'
  | 'delegation.failed'
  | 'delegation.superseded';

export type DelegationEvent =
  | {
      type: 'delegation.created' | 'delegation.started';
      run: DelegationRun;
    }
  | {
      type: 'delegation.output';
      run: DelegationRun;
      output: string;
    }
  | {
      type: 'delegation.completed';
      run: DelegationRun;
      result?: string;
    }
  | {
      type: 'delegation.failed';
      run: DelegationRun;
      error: string;
    }
  | {
      type: 'delegation.superseded';
      run: DelegationRun;
    };

export type DelegationEventSubscriber = (event: DelegationEvent) => void;

export class DelegationEventBus {
  private subscribers = new Set<DelegationEventSubscriber>();

  subscribe(subscriber: DelegationEventSubscriber): () => void {
    this.subscribers.add(subscriber);
    return () => this.subscribers.delete(subscriber);
  }

  emit(event: DelegationEvent): void {
    for (const subscriber of this.subscribers) {
      subscriber(event);
    }
  }
}
