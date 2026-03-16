// src/streaming/tool-result-cache.ts

export interface CachedToolData {
  toolId: string;
  toolName: string;
  input: Record<string, unknown>;
  result: string;
  durationMs: number;
  isError: boolean;
}

interface CacheEntry {
  data: CachedToolData;
  createdAt: number;
  sizeBytes: number;
}

interface ToolResultCacheConfig {
  ttlMs: number;        // 30 * 60 * 1000 = 30 minutes
  maxSizeBytes: number;  // 50 * 1024 * 1024 = 50MB
}

export class ToolResultCache {
  private entries: Map<string, CacheEntry> = new Map();
  private totalBytes = 0;
  private readonly config: ToolResultCacheConfig;

  constructor(config: ToolResultCacheConfig) {
    this.config = config;
  }

  get size(): number {
    return this.entries.size;
  }

  set(toolId: string, data: CachedToolData): void {
    // Remove existing entry if present
    if (this.entries.has(toolId)) {
      this.delete(toolId);
    }

    const sizeBytes = this.estimateSize(data);

    // Evict LRU entries until we have space
    while (this.totalBytes + sizeBytes > this.config.maxSizeBytes && this.entries.size > 0) {
      const oldestKey = this.entries.keys().next().value!;
      this.delete(oldestKey);
    }

    this.entries.set(toolId, {
      data,
      createdAt: Date.now(),
      sizeBytes,
    });
    this.totalBytes += sizeBytes;
  }

  get(toolId: string): CachedToolData | undefined {
    const entry = this.entries.get(toolId);
    if (!entry) return undefined;

    // Check TTL
    if (Date.now() - entry.createdAt > this.config.ttlMs) {
      this.delete(toolId);
      return undefined;
    }

    return entry.data;
  }

  clear(): void {
    this.entries.clear();
    this.totalBytes = 0;
  }

  private delete(toolId: string): void {
    const entry = this.entries.get(toolId);
    if (entry) {
      this.totalBytes -= entry.sizeBytes;
      this.entries.delete(toolId);
    }
  }

  private estimateSize(data: CachedToolData): number {
    // Rough estimate: result string length + JSON overhead
    return data.result.length + JSON.stringify(data.input).length + 200;
  }
}
