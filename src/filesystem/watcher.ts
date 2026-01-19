import chokidar from 'chokidar';
import { EventEmitter } from 'events';
import { join, relative, dirname, basename } from 'path';
import { existsSync } from 'fs';
import type { DomainEvent } from '../types/index.js';
import {
  extractPlaylistIdFromFolderName,
  extractTrackIdFromFilename,
  parseTrackFilename,
} from '../utils/index.js';

export interface WatcherEvents {
  event: [DomainEvent];
  error: [Error];
  ready: [];
}

export class FilesystemWatcher extends EventEmitter {
  private watcher: chokidar.FSWatcher | null = null;
  private workspacePath: string;
  private playlistsPath: string;
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private debounceMs = 200;

  constructor(workspacePath: string) {
    super();
    this.workspacePath = workspacePath;
    this.playlistsPath = join(workspacePath, 'Playlists');
  }

  start(): void {
    if (this.watcher) return;

    this.watcher = chokidar.watch(this.playlistsPath, {
      ignored: [
        /(^|[\/\\])\../, // dotfiles
        '**/node_modules/**',
      ],
      persistent: true,
      ignoreInitial: true,
      awaitWriteFinish: {
        stabilityThreshold: 100,
        pollInterval: 50,
      },
    });

    this.watcher
      .on('add', (path) => this.handleAdd(path))
      .on('change', (path) => this.handleChange(path))
      .on('unlink', (path) => this.handleUnlink(path))
      .on('addDir', (path) => this.handleAddDir(path))
      .on('unlinkDir', (path) => this.handleUnlinkDir(path))
      .on('error', (error) => this.emit('error', error))
      .on('ready', () => this.emit('ready'));
  }

  stop(): void {
    if (this.watcher) {
      this.watcher.close();
      this.watcher = null;
    }

    // Clear all pending timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  private debounce(key: string, fn: () => void): void {
    const existing = this.debounceTimers.get(key);
    if (existing) {
      clearTimeout(existing);
    }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(key);
      fn();
    }, this.debounceMs);

    this.debounceTimers.set(key, timer);
  }

  private getRelativePath(absolutePath: string): string {
    return relative(this.playlistsPath, absolutePath);
  }

  private isTrackFile(path: string): boolean {
    return path.endsWith('.spotify');
  }

  private isPlaylistMetadata(path: string): boolean {
    return basename(path) === 'playlist.json';
  }

  private isOrderFile(path: string): boolean {
    return basename(path) === 'order.json';
  }

  private getPlaylistIdFromPath(path: string): string | null {
    const relativePath = this.getRelativePath(path);
    const parts = relativePath.split('/');
    if (parts.length > 0) {
      return extractPlaylistIdFromFolderName(parts[0]);
    }
    return null;
  }

  private handleAdd(path: string): void {
    if (this.isTrackFile(path)) {
      this.debounce(`add:${path}`, () => {
        const playlistId = this.getPlaylistIdFromPath(path);
        const trackId = extractTrackIdFromFilename(basename(path));
        const parsed = parseTrackFilename(basename(path));

        if (playlistId && trackId) {
          const event: DomainEvent = {
            type: 'TrackAdded',
            playlistId,
            trackId,
            position: parsed?.position ?? 0,
          };
          this.emit('event', event);
        }
      });
    }
  }

  private handleChange(path: string): void {
    if (this.isPlaylistMetadata(path)) {
      this.debounce(`change:${path}`, () => {
        const playlistId = this.getPlaylistIdFromPath(path);
        if (playlistId) {
          const event: DomainEvent = {
            type: 'PlaylistMetadataChanged',
            playlistId,
            changes: {},
          };
          this.emit('event', event);
        }
      });
    } else if (this.isOrderFile(path)) {
      // Order file changed - triggers reorder events
      this.debounce(`change:${path}`, () => {
        const playlistId = this.getPlaylistIdFromPath(path);
        if (playlistId) {
          // We emit a generic metadata change for now
          // The sync engine will compute actual reorders
          const event: DomainEvent = {
            type: 'PlaylistMetadataChanged',
            playlistId,
            changes: {},
          };
          this.emit('event', event);
        }
      });
    }
  }

  private handleUnlink(path: string): void {
    if (this.isTrackFile(path)) {
      this.debounce(`unlink:${path}`, () => {
        const playlistId = this.getPlaylistIdFromPath(path);
        const trackId = extractTrackIdFromFilename(basename(path));

        if (playlistId && trackId) {
          const event: DomainEvent = {
            type: 'TrackRemoved',
            playlistId,
            trackId,
          };
          this.emit('event', event);
        }
      });
    }
  }

  private handleAddDir(path: string): void {
    // Check if this is a new playlist folder (first-level directory)
    const relativePath = this.getRelativePath(path);
    const parts = relativePath.split('/');

    if (parts.length === 1 && parts[0] && !parts[0].startsWith('.')) {
      this.debounce(`addDir:${path}`, () => {
        const event: DomainEvent = {
          type: 'PlaylistCreated',
          folderPath: path,
          name: parts[0],
        };
        this.emit('event', event);
      });
    }
  }

  private handleUnlinkDir(path: string): void {
    const relativePath = this.getRelativePath(path);
    const parts = relativePath.split('/');

    if (parts.length === 1 && parts[0] && !parts[0].startsWith('.')) {
      const playlistId = extractPlaylistIdFromFolderName(parts[0]);

      if (playlistId) {
        this.debounce(`unlinkDir:${path}`, () => {
          const event: DomainEvent = {
            type: 'PlaylistDeleted',
            playlistId,
            folderPath: path,
          };
          this.emit('event', event);
        });
      }
    }
  }
}
