import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const PID_FILE = 'claude-slack-pipe.pid';

/**
 * Acquire a PID-based singleton lock.
 * Throws if another instance is already running.
 */
export function acquirePidLock(dataDir: string): { release: () => void } {
  const pidPath = path.join(dataDir, PID_FILE);
  const currentPid = process.pid;

  // Check for existing PID file
  if (fs.existsSync(pidPath)) {
    const existingPid = parseInt(fs.readFileSync(pidPath, 'utf-8').trim(), 10);
    if (!isNaN(existingPid) && isProcessRunning(existingPid)) {
      throw new Error(
        `Another instance is already running (PID ${existingPid}). ` +
        `If this is incorrect, remove ${pidPath} and try again.`
      );
    }
    logger.warn(`Stale PID file found (PID ${existingPid} is not running), removing`);
  }

  // Write current PID
  fs.mkdirSync(dataDir, { recursive: true });
  fs.writeFileSync(pidPath, String(currentPid));
  logger.info(`PID lock acquired (PID ${currentPid})`);

  const release = () => {
    try {
      // Only remove if it still contains our PID
      if (fs.existsSync(pidPath)) {
        const content = fs.readFileSync(pidPath, 'utf-8').trim();
        if (content === String(currentPid)) {
          fs.unlinkSync(pidPath);
          logger.info('PID lock released');
        }
      }
    } catch {
      // Best-effort cleanup
    }
  };

  return { release };
}

function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0); // signal 0 = existence check, no actual signal sent
    return true;
  } catch {
    return false;
  }
}
