/**
 * Trigger Domain - Trigger Registry
 *
 * Manages registration and lookup of trigger adapters.
 * Allows future additions (GitHub, SigNoz, etc.) without changing dispatcher logic.
 *
 * The registry is a simple map of adapters keyed by source and type.
 * When a new integration is added, it registers its adapter here.
 */

import type { ITriggerAdapter, ITriggerRegistry } from "./interfaces.js";

export class TriggerRegistry implements ITriggerRegistry {
  private readonly _adapters: Map<string, ITriggerAdapter> = new Map();

  /**
   * Registers a trigger adapter for a specific source and type.
   * If an adapter with the same source/type already exists, it will be replaced.
   */
  register(adapter: ITriggerAdapter): void {
    const key = this.makeKey(adapter.source, adapter.type);
    this._adapters.set(key, adapter);
  }

  /**
   * Finds an adapter that can handle the given source and type.
   * Returns undefined if no adapter is registered for the combination.
   */
  findAdapter(source: string, type: string): ITriggerAdapter | undefined {
    const key = this.makeKey(source, type);
    return this._adapters.get(key);
  }

  /**
   * Returns all registered adapters.
   */
  getAdapters(): ITriggerAdapter[] {
    return Array.from(this._adapters.values());
  }

  /**
   * Creates a unique key for the adapter map.
   */
  private makeKey(source: string, type: string): string {
    return `${source}:${type}`;
  }
}
