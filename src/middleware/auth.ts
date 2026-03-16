import type { SecurityConfig } from '../types.js';
import { logger } from '../utils/logger.js';

export class AuthMiddleware {
  private readonly allowedUsers: Set<string>;
  private readonly allowedTeams: Set<string>;
  private readonly adminUsers: Set<string>;
  private readonly openAccess: boolean;

  constructor(config: SecurityConfig) {
    this.allowedUsers = new Set(config.allowedUserIds);
    this.allowedTeams = new Set(config.allowedTeamIds);
    this.adminUsers = new Set(config.adminUserIds);
    this.openAccess =
      this.allowedUsers.size === 0 && this.allowedTeams.size === 0;
  }

  isAllowed(userId: string, teamId?: string): boolean {
    if (this.adminUsers.has(userId)) {
      return true;
    }

    if (this.openAccess) {
      return true;
    }

    if (this.allowedUsers.has(userId)) {
      return true;
    }

    if (teamId && this.allowedTeams.has(teamId)) {
      return true;
    }

    logger.warn('Auth denied', { userId, teamId });
    return false;
  }

  isAdmin(userId: string): boolean {
    return this.adminUsers.has(userId);
  }
}
