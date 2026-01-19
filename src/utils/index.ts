import { createHash } from 'crypto';

export function computeTrackListHash(trackIds: string[]): string {
  const hash = createHash('sha256');
  hash.update(trackIds.join(','));
  return hash.digest('hex').substring(0, 16);
}

export function sanitizeFilename(name: string): string {
  // Remove or replace characters that are invalid in filenames
  return name
    .replace(/[<>:"/\\|?*]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .substring(0, 100);
}

export function extractPlaylistIdFromFolderName(folderName: string): string | null {
  const match = folderName.match(/__([a-zA-Z0-9]+)$/);
  return match ? match[1] : null;
}

export function extractTrackIdFromFilename(filename: string): string | null {
  // Format: 001__Artist - Track__<track_id>.spotify
  const match = filename.match(/__([a-zA-Z0-9]+)\.spotify$/);
  return match ? match[1] : null;
}

export function createPlaylistFolderName(name: string, playlistId: string): string {
  return `${sanitizeFilename(name)}__${playlistId}`;
}

export function createTrackFilename(position: number, displayName: string, trackId: string): string {
  const positionStr = String(position).padStart(3, '0');
  const safeName = sanitizeFilename(displayName);
  return `${positionStr}__${safeName}__${trackId}.spotify`;
}

export function parseTrackFilename(filename: string): { position: number; displayName: string; trackId: string } | null {
  // Format: 001__Artist - Track__<track_id>.spotify
  const match = filename.match(/^(\d{3})__(.+)__([a-zA-Z0-9]+)\.spotify$/);
  if (!match) return null;
  return {
    position: parseInt(match[1], 10),
    displayName: match[2],
    trackId: match[3],
  };
}

export function spotifyUriToId(uri: string): string {
  // spotify:track:4iV5W9uYEdYUVa79Axb7Rh -> 4iV5W9uYEdYUVa79Axb7Rh
  const parts = uri.split(':');
  return parts[parts.length - 1];
}

export function trackIdToUri(trackId: string): string {
  return `spotify:track:${trackId}`;
}

export function playlistIdToUri(playlistId: string): string {
  return `spotify:playlist:${playlistId}`;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: () => Promise<T>,
  options: {
    maxRetries?: number;
    baseDelayMs?: number;
    maxDelayMs?: number;
    shouldRetry?: (error: unknown) => boolean;
  } = {}
): Promise<T> {
  const {
    maxRetries = 3,
    baseDelayMs = 1000,
    maxDelayMs = 30000,
    shouldRetry = () => true,
  } = options;

  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries || !shouldRetry(error)) {
        throw error;
      }
      const delay = Math.min(baseDelayMs * Math.pow(2, attempt), maxDelayMs);
      await sleep(delay);
    }
  }
  throw lastError;
}

export function formatDuration(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  return `${minutes}:${remainingSeconds.toString().padStart(2, '0')}`;
}

export function generateBranchName(prefix: string, description: string): string {
  const date = new Date().toISOString().split('T')[0];
  const safeName = description
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .substring(0, 30)
    .replace(/-+$/, '');
  return `${prefix}/${safeName}-${date}`;
}

export function chunkArray<T>(array: T[], size: number): T[][] {
  const chunks: T[][] = [];
  for (let i = 0; i < array.length; i += size) {
    chunks.push(array.slice(i, i + size));
  }
  return chunks;
}

export function arrayDiff<T>(
  local: T[],
  remote: T[],
  getId: (item: T) => string = (item) => String(item)
): {
  added: T[];
  removed: T[];
  common: T[];
} {
  const localIds = new Set(local.map(getId));
  const remoteIds = new Set(remote.map(getId));

  const added = local.filter((item) => !remoteIds.has(getId(item)));
  const removed = remote.filter((item) => !localIds.has(getId(item)));
  const common = local.filter((item) => remoteIds.has(getId(item)));

  return { added, removed, common };
}

export function orderChanged(localOrder: string[], remoteOrder: string[]): boolean {
  if (localOrder.length !== remoteOrder.length) return true;
  for (let i = 0; i < localOrder.length; i++) {
    if (localOrder[i] !== remoteOrder[i]) return true;
  }
  return false;
}
