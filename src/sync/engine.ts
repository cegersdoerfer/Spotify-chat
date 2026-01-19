import type {
  SyncOperation,
  SyncPlan,
  SyncResult,
  SpotifyPlaylistWithTracks,
  LocalPlaylist,
  PlaylistDiff,
} from '../types/index.js';
import type { SpotifyClient } from '../spotify/client.js';
import type { StateStore } from '../state/database.js';
import type { FilesystemSerializer } from '../filesystem/serializer.js';
import { computeTrackListHash, trackIdToUri } from '../utils/index.js';
import { computePullDiff, computePushPlan, optimizePlan, type DiffContext } from './diff.js';

export interface SyncEngineOptions {
  dryRun?: boolean;
  force?: boolean;
  conflictResolution?: 'take-local' | 'take-remote' | 'abort';
}

export class SyncEngine {
  private spotifyClient: SpotifyClient;
  private stateStore: StateStore;
  private serializer: FilesystemSerializer;
  private userId: string;

  constructor(
    spotifyClient: SpotifyClient,
    stateStore: StateStore,
    serializer: FilesystemSerializer,
    userId: string
  ) {
    this.spotifyClient = spotifyClient;
    this.stateStore = stateStore;
    this.serializer = serializer;
    this.userId = userId;
  }

  async pull(options: SyncEngineOptions = {}): Promise<SyncResult> {
    const appliedOperations: SyncOperation[] = [];
    const failedOperations: Array<{ operation: SyncOperation; error: string }> = [];

    try {
      // Fetch all remote playlists
      const remotePlaylists = await this.fetchAllRemotePlaylists();

      // Read all local playlists
      const localPlaylists = this.readAllLocalPlaylists();

      // Compute diff
      const diff = computePullDiff(localPlaylists, remotePlaylists);

      if (options.dryRun) {
        return {
          success: true,
          appliedOperations: [],
          failedOperations: [],
          conflicts: [],
          timestamp: new Date().toISOString(),
        };
      }

      // Apply changes
      for (const playlist of diff.toCreate) {
        try {
          const path = this.serializer.writePlaylist(playlist);
          this.stateStore.upsertPlaylistMapping({
            playlistId: playlist.id,
            localPath: path,
            snapshotId: playlist.snapshotId,
            lastSyncedAt: new Date().toISOString(),
            trackHash: computeTrackListHash(playlist.tracks.map((t) => t.id)),
          });
          this.stateStore.logSyncOperation(
            'pull_create',
            playlist.id,
            `Created playlist: ${playlist.name}`,
            true
          );
        } catch (error) {
          failedOperations.push({
            operation: { type: 'create_playlist', name: playlist.name, trackIds: [] },
            error: String(error),
          });
        }
      }

      for (const { local, remote } of diff.toUpdate) {
        try {
          // Overwrite local with remote
          this.serializer.writePlaylist(remote);
          this.stateStore.upsertPlaylistMapping({
            playlistId: remote.id,
            localPath: local.folderPath,
            snapshotId: remote.snapshotId,
            lastSyncedAt: new Date().toISOString(),
            trackHash: computeTrackListHash(remote.tracks.map((t) => t.id)),
          });
          this.stateStore.logSyncOperation(
            'pull_update',
            remote.id,
            `Updated playlist: ${remote.name}`,
            true
          );
        } catch (error) {
          failedOperations.push({
            operation: { type: 'replace_tracks', playlistId: remote.id, trackIds: [] },
            error: String(error),
          });
        }
      }

      for (const playlist of diff.toDelete) {
        try {
          this.serializer.deletePlaylist(playlist.folderPath);
          this.stateStore.deletePlaylistMapping(playlist.playlistId);
          this.stateStore.addTombstone('playlist', playlist.playlistId);
          this.stateStore.logSyncOperation(
            'pull_delete',
            playlist.playlistId,
            `Deleted playlist: ${playlist.name}`,
            true
          );
        } catch (error) {
          failedOperations.push({
            operation: { type: 'delete_playlist', playlistId: playlist.playlistId },
            error: String(error),
          });
        }
      }

      return {
        success: failedOperations.length === 0,
        appliedOperations,
        failedOperations,
        conflicts: [],
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.stateStore.logSyncOperation('pull', null, 'Pull failed', false, String(error));
      throw error;
    }
  }

  async push(options: SyncEngineOptions = {}): Promise<SyncResult> {
    const appliedOperations: SyncOperation[] = [];
    const failedOperations: Array<{ operation: SyncOperation; error: string }> = [];

    try {
      // Fetch all remote playlists
      const remotePlaylists = await this.fetchAllRemotePlaylists();

      // Read all local playlists
      const localPlaylists = this.readAllLocalPlaylists();

      // Build context map from stored state
      const contexts = new Map<string, DiffContext>();
      for (const [playlistId] of localPlaylists) {
        const mapping = this.stateStore.getPlaylistMapping(playlistId);
        if (mapping) {
          contexts.set(playlistId, {
            lastSyncedRemoteSnapshotId: mapping.snapshotId,
            lastSyncedLocalHash: mapping.trackHash,
          });
        }
      }

      // Compute push plan
      let plan = computePushPlan(localPlaylists, remotePlaylists, contexts);
      plan = optimizePlan(plan);

      // Handle conflicts
      if (plan.conflicts.length > 0) {
        if (options.conflictResolution === 'abort') {
          return {
            success: false,
            appliedOperations: [],
            failedOperations: [],
            conflicts: plan.conflicts,
            timestamp: new Date().toISOString(),
          };
        }

        if (options.conflictResolution === 'take-remote') {
          // Skip conflicting playlists - they'll be handled in next pull
          plan.operations = plan.operations.filter(
            (op) =>
              !('playlistId' in op) ||
              !plan.conflicts.some((c) => c.playlistId === op.playlistId)
          );
        }
        // take-local: continue with local changes
      }

      if (options.dryRun) {
        return {
          success: true,
          appliedOperations: plan.operations,
          failedOperations: [],
          conflicts: plan.conflicts,
          timestamp: new Date().toISOString(),
        };
      }

      // Execute operations
      for (const operation of plan.operations) {
        try {
          await this.executeOperation(operation);
          appliedOperations.push(operation);
          this.stateStore.logSyncOperation(
            `push_${operation.type}`,
            'playlistId' in operation ? operation.playlistId : null,
            JSON.stringify(operation),
            true
          );
        } catch (error) {
          failedOperations.push({ operation, error: String(error) });
          this.stateStore.logSyncOperation(
            `push_${operation.type}`,
            'playlistId' in operation ? operation.playlistId : null,
            JSON.stringify(operation),
            false,
            String(error)
          );
        }
      }

      // Update state for successful operations
      for (const operation of appliedOperations) {
        if ('playlistId' in operation && operation.type !== 'delete_playlist') {
          const remote = await this.spotifyClient.getPlaylistWithTracks(operation.playlistId);
          this.stateStore.upsertPlaylistMapping({
            playlistId: operation.playlistId,
            localPath:
              this.serializer.getPlaylistPathById(operation.playlistId) || '',
            snapshotId: remote.snapshotId,
            lastSyncedAt: new Date().toISOString(),
            trackHash: computeTrackListHash(remote.tracks.map((t) => t.id)),
          });
        }
      }

      return {
        success: failedOperations.length === 0,
        appliedOperations,
        failedOperations,
        conflicts: plan.conflicts,
        timestamp: new Date().toISOString(),
      };
    } catch (error) {
      this.stateStore.logSyncOperation('push', null, 'Push failed', false, String(error));
      throw error;
    }
  }

  async status(): Promise<{
    localPlaylists: number;
    remotePlaylists: number;
    pendingAdditions: number;
    pendingRemovals: number;
    conflicts: number;
  }> {
    const remotePlaylists = await this.fetchAllRemotePlaylists();
    const localPlaylists = this.readAllLocalPlaylists();

    const contexts = new Map<string, DiffContext>();
    for (const [playlistId] of localPlaylists) {
      const mapping = this.stateStore.getPlaylistMapping(playlistId);
      if (mapping) {
        contexts.set(playlistId, {
          lastSyncedRemoteSnapshotId: mapping.snapshotId,
          lastSyncedLocalHash: mapping.trackHash,
        });
      }
    }

    const plan = computePushPlan(localPlaylists, remotePlaylists, contexts);

    let pendingAdditions = 0;
    let pendingRemovals = 0;

    for (const op of plan.operations) {
      if (op.type === 'add_tracks') {
        pendingAdditions += op.trackIds.length;
      } else if (op.type === 'remove_tracks') {
        pendingRemovals += op.trackIds.length;
      } else if (op.type === 'create_playlist') {
        pendingAdditions += op.trackIds.length;
      }
    }

    return {
      localPlaylists: localPlaylists.size,
      remotePlaylists: remotePlaylists.size,
      pendingAdditions,
      pendingRemovals,
      conflicts: plan.conflicts.length,
    };
  }

  async diff(): Promise<PlaylistDiff[]> {
    const remotePlaylists = await this.fetchAllRemotePlaylists();
    const localPlaylists = this.readAllLocalPlaylists();

    const contexts = new Map<string, DiffContext>();
    for (const [playlistId] of localPlaylists) {
      const mapping = this.stateStore.getPlaylistMapping(playlistId);
      if (mapping) {
        contexts.set(playlistId, {
          lastSyncedRemoteSnapshotId: mapping.snapshotId,
          lastSyncedLocalHash: mapping.trackHash,
        });
      }
    }

    const plan = computePushPlan(localPlaylists, remotePlaylists, contexts);
    const diffs: PlaylistDiff[] = [];

    // Generate diffs from operations
    for (const [playlistId, local] of localPlaylists) {
      const remote = remotePlaylists.get(playlistId);
      if (remote) {
        const context = contexts.get(playlistId) || {};
        const { computePlaylistDiff } = await import('./diff.js');
        const diff = computePlaylistDiff(local, remote, context);
        if (
          diff.additions.length > 0 ||
          diff.removals.length > 0 ||
          diff.reorderNeeded
        ) {
          diffs.push(diff);
        }
      }
    }

    return [...diffs, ...plan.conflicts];
  }

  private async fetchAllRemotePlaylists(): Promise<
    Map<string, SpotifyPlaylistWithTracks>
  > {
    const playlists = await this.spotifyClient.getAllUserPlaylists();
    const result = new Map<string, SpotifyPlaylistWithTracks>();

    for (const playlist of playlists) {
      // Only sync playlists owned by the user
      if (playlist.owner.id === this.userId) {
        const tracks = await this.spotifyClient.getPlaylistTracks(playlist.id);
        result.set(playlist.id, { ...playlist, tracks });
      }
    }

    return result;
  }

  private readAllLocalPlaylists(): Map<string, LocalPlaylist> {
    const playlists = this.serializer.readAllPlaylists();
    const result = new Map<string, LocalPlaylist>();

    for (const playlist of playlists) {
      result.set(playlist.playlistId, playlist);
    }

    return result;
  }

  private async executeOperation(operation: SyncOperation): Promise<void> {
    switch (operation.type) {
      case 'create_playlist': {
        const playlist = await this.spotifyClient.createPlaylist(
          this.userId,
          operation.name
        );
        if (operation.trackIds.length > 0) {
          await this.spotifyClient.addTracksToPlaylist(
            playlist.id,
            operation.trackIds.map(trackIdToUri)
          );
        }
        break;
      }

      case 'delete_playlist': {
        // Spotify doesn't allow deleting playlists via API
        // We can only unfollow, but that's different
        // For now, we'll skip deletion and log a warning
        console.warn(
          `Cannot delete playlist ${operation.playlistId} - Spotify API doesn't support playlist deletion`
        );
        break;
      }

      case 'rename_playlist': {
        await this.spotifyClient.updatePlaylistDetails(operation.playlistId, {
          name: operation.newName,
        });
        break;
      }

      case 'add_tracks': {
        await this.spotifyClient.addTracksToPlaylist(
          operation.playlistId,
          operation.trackIds.map(trackIdToUri),
          operation.position
        );
        break;
      }

      case 'remove_tracks': {
        await this.spotifyClient.removeTracksFromPlaylist(
          operation.playlistId,
          operation.trackIds.map(trackIdToUri)
        );
        break;
      }

      case 'reorder_tracks':
      case 'replace_tracks': {
        await this.spotifyClient.replacePlaylistTracks(
          operation.playlistId,
          operation.trackIds.map(trackIdToUri)
        );
        break;
      }
    }
  }
}
