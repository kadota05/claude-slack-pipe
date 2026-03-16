import { describe, it, expect } from 'vitest';
import { AuthMiddleware } from '../../src/middleware/auth.js';
import type { SecurityConfig } from '../../src/types.js';

describe('AuthMiddleware', () => {
  it('should allow all users when allowedUserIds and allowedTeamIds are empty', () => {
    const config: SecurityConfig = { allowedUserIds: [], allowedTeamIds: [], adminUserIds: [] };
    const auth = new AuthMiddleware(config);
    expect(auth.isAllowed('U_ANYONE', 'T_ANY')).toBe(true);
  });

  it('should deny a user not in the allowed list', () => {
    const config: SecurityConfig = {
      allowedUserIds: ['U_ALICE'],
      allowedTeamIds: [],
      adminUserIds: [],
    };
    const auth = new AuthMiddleware(config);
    expect(auth.isAllowed('U_BOB', 'T_ANY')).toBe(false);
  });

  it('should allow a user in the allowed list', () => {
    const config: SecurityConfig = {
      allowedUserIds: ['U_ALICE', 'U_BOB'],
      allowedTeamIds: [],
      adminUserIds: [],
    };
    const auth = new AuthMiddleware(config);
    expect(auth.isAllowed('U_BOB', 'T_ANY')).toBe(true);
  });

  it('should allow a user whose team matches allowedTeamIds', () => {
    const config: SecurityConfig = {
      allowedUserIds: [],
      allowedTeamIds: ['T_ALLOWED'],
      adminUserIds: [],
    };
    const auth = new AuthMiddleware(config);
    expect(auth.isAllowed('U_ANYONE', 'T_ALLOWED')).toBe(true);
    expect(auth.isAllowed('U_ANYONE', 'T_OTHER')).toBe(false);
  });

  it('should identify admin users', () => {
    const config: SecurityConfig = {
      allowedUserIds: [],
      allowedTeamIds: [],
      adminUserIds: ['U_ADMIN'],
    };
    const auth = new AuthMiddleware(config);
    expect(auth.isAdmin('U_ADMIN')).toBe(true);
    expect(auth.isAdmin('U_NORMAL')).toBe(false);
  });

  it('should allow admin users even when not in allowedUserIds', () => {
    const config: SecurityConfig = {
      allowedUserIds: ['U_ALICE'],
      allowedTeamIds: [],
      adminUserIds: ['U_ADMIN'],
    };
    const auth = new AuthMiddleware(config);
    expect(auth.isAllowed('U_ADMIN', 'T_ANY')).toBe(true);
  });
});
