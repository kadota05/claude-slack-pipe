// src/streaming/graceful-degradation.ts
import type { DegradationLevel } from './types.js';

const MAX_PRIORITY: Record<DegradationLevel, number> = {
  NORMAL: 5,
  CAUTION: 4,
  THROTTLE: 3,
  CRITICAL: 2,
  EMERGENCY: 1,
};

export class GracefulDegradation {
  static getLevel(maxUtilization: number): DegradationLevel {
    if (maxUtilization >= 0.95) return 'EMERGENCY';
    if (maxUtilization >= 0.85) return 'CRITICAL';
    if (maxUtilization >= 0.75) return 'THROTTLE';
    if (maxUtilization >= 0.60) return 'CAUTION';
    return 'NORMAL';
  }

  static shouldExecute(level: DegradationLevel, priority: number): boolean {
    return priority <= MAX_PRIORITY[level];
  }
}
