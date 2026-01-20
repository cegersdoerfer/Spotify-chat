import type {
  SyncOperation,
  SyncResult,
  SpotifyPlaylistWithTracks,
  PlaylistDiff,
} from '../types/index.js';
import type { SpotifyClient } from '../spotify/client.js';
import type { StateStore } from '../state/database.js';
import type { LibraryDatabase } from '../state/library.js';
import type { MarkdownGenerator } from '../filesystem/markdown.js';
import { computeTrackListHash, trackIdToUri } from '../utils/index.js';

export interface SyncEngineOptions {
  dryRun?: boolean;
  force?: boolean;
  conflictResolution?: 'take-local' | 'take-remote' | 'abort';
}

export class SyncEngine {
  private spotifyClient: SpotifyClient;
  private stateStore: StateStore;
  private userId: string;
  private libraryDb: LibraryDatabase;
  private markdownGenerator: MarkdownGenerator;

  constructor(
    spotifyClient: SpotifyClient,
    stateStore: StateStore,
    userId: string,
    libraryDb: LibraryDatabase,
    markdownGenerator: MarkdownGenerator
  ) {
    this.spotifyClient = spotifyClient;
    this.stateStore = stateStore;
    this.userId = userId;
    this.libraryDb = libraryDb;
    this.markdownGenerator = markdownGenerator;
  }

  async pull(options: SyncEngineOptions = {}): Promise<SyncResult> {
    const appliedOperations: SyncOperation[] = [];
    const failedOperations: Array<{ operation: SyncOperation; error: string }> = [];

    try {
      // Fetch all remote playlists
      const remotePlaylists = await this.fetchAllRemotePlaylists();

      if (options.dryRun) {
        return {
          success: true,
          appliedOperations: [],
          failedOperations: [],
          conflicts: [],
          timestamp: new Date().toISOString(),
        };
      }

      // Import each remote playlist into the SQLite database
      for (const [playlistId, playlist] of remotePlaylists) {
        try {
          // Import playlist with tracks into SQLite
          this.libraryDb.importPlaylist(playlist);

          // Update state tracking
          this.stateStore.upsertPlaylistMapping({
            playlistId: playlist.id,
            localPath: `Playlists/${playlist.name}.md`,
            snapshotId: playlist.snapshotId,
            lastSyncedAt: new Date().toISOString(),
            trackHash: computeTrackListHash(playlist.tracks.map((t) => t.id)),
          });

          this.stateStore.logSyncOperation(
            'pull_import',
            playlist.id,
            `Imported playlist: ${playlist.name} (${playlist.tracks.length} tracks)`,
            true
          );

          appliedOperations.push({
            type: 'create_playlist',
            name: playlist.name,
            trackIds: playlist.tracks.map(t => t.id),
          });
        } catch (error) {
          failedOperations.push({
            operation: { type: 'create_playlist', name: playlist.name, trackIds: [] },
            error: String(error),
          });
        }
      }

      // Generate markdown files from SQLite
      this.markdownGenerator.generateAll(this.libraryDb);

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
    const conflicts: PlaylistDiff[] = [];

    try {
      // Get all local playlists from SQLite
      const localPlaylists = this.libraryDb.getAllPlaylists();

      // Fetch all remote playlists for comparison
      const remotePlaylists = await this.fetchAllRemotePlaylists();

      for (const localPlaylist of localPlaylists) {
        const localTracks = this.libraryDb.getPlaylistTrackIds(localPlaylist.id);
        const remote = remotePlaylists.get(localPlaylist.id);
        const lastMapping = this.stateStore.getPlaylistMapping(localPlaylist.id);

        // Check if this is a new local playlist (needs to be created on Spotify)
        if (localPlaylist.id.startsWith('local_') && !remote) {
          if (options.dryRun) {
            appliedOperations.push({
              type: 'create_playlist',
              name: localPlaylist.name,
              trackIds: localTracks,
            });
            continue;
          }

          try {
            // Create playlist on Spotify
            const newPlaylist = await this.spotifyClient.createPlaylist(
              this.userId,
              localPlaylist.name,
              { description: localPlaylist.description }
            );

            // Add tracks to the new playlist
            if (localTracks.length > 0) {
              await this.spotifyClient.addTracksToPlaylist(
                newPlaylist.id,
                localTracks.map(trackIdToUri)
              );
            }

            // Update local database with the real Spotify ID
            // (Would need to add a method to migrate playlist ID)

            appliedOperations.push({
              type: 'create_playlist',
              name: localPlaylist.name,
              trackIds: localTracks,
            });

            this.stateStore.logSyncOperation(
              'push_create',
              newPlaylist.id,
              `Created playlist on Spotify: ${localPlaylist.name}`,
              true
            );
          } catch (error) {
            failedOperations.push({
              operation: { type: 'create_playlist', name: localPlaylist.name, trackIds: localTracks },
              error: String(error),
            });
          }
          continue;
        }

        // Existing playlist - check for changes
        if (remote) {
          const remoteTrackIds = remote.tracks.map(t => t.id);
          const localHash = computeTrackListHash(localTracks);
          const remoteHash = computeTrackListHash(remoteTrackIds);

          // Check for conflicts (both changed since last sync)
          if (lastMapping && remote.snapshotId !== lastMapping.snapshotId && localHash !== lastMapping.trackHash) {
            if (options.conflictResolution === 'abort') {
              conflicts.push({
                playlistId: localPlaylist.id,
                playlistName: localPlaylist.name,
                additions: [],
                removals: [],
                reorderNeeded: false,
                hasConflict: true,
                localOrder: localTracks,
                remoteOrder: remoteTrackIds,
              });
              continue;
            }

            if (options.conflictResolution === 'take-remote') {
              // Skip local changes, will be overwritten on next pull
              continue;
            }
            // take-local: continue with pushing local changes
          }

          // Check if local has changes
          if (localHash !== remoteHash) {
            if (options.dryRun) {
              appliedOperations.push({
                type: 'replace_tracks',
                playlistId: localPlaylist.id,
                trackIds: localTracks,
              });
              continue;
            }

            try {
              // Replace all tracks
              await this.spotifyClient.replacePlaylistTracks(
                localPlaylist.id,
                localTracks.map(trackIdToUri)
              );

              // Update state
              const updatedRemote = await this.spotifyClient.getPlaylistWithTracks(localPlaylist.id);
              this.stateStore.upsertPlaylistMapping({
                playlistId: localPlaylist.id,
                localPath: `Playlists/${localPlaylist.name}.md`,
                snapshotId: updatedRemote.snapshotId,
                lastSyncedAt: new Date().toISOString(),
                trackHash: localHash,
              });

              appliedOperations.push({
                type: 'replace_tracks',
                playlistId: localPlaylist.id,
                trackIds: localTracks,
              });

              this.stateStore.logSyncOperation(
                'push_update',
                localPlaylist.id,
                `Updated playlist: ${localPlaylist.name}`,
                true
              );
            } catch (error) {
              failedOperations.push({
                operation: { type: 'replace_tracks', playlistId: localPlaylist.id, trackIds: localTracks },
                error: String(error),
              });
            }
          }
        }
      }

      // Regenerate markdown to reflect any sync state changes
      this.markdownGenerator.generateAll(this.libraryDb);

      return {
        success: failedOperations.length === 0,
        appliedOperations,
        failedOperations,
        conflicts,
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
    libraryStats: { playlists: number; tracks: number; totalPlaylistTracks: number };
  }> {
    const remotePlaylists = await this.fetchAllRemotePlaylists();
    const localPlaylists = this.libraryDb.getAllPlaylists();
    const libraryStats = this.libraryDb.getStats();

    let pendingAdditions = 0;
    let pendingRemovals = 0;
    let conflictCount = 0;

    for (const localPlaylist of localPlaylists) {
      const localTracks = this.libraryDb.getPlaylistTrackIds(localPlaylist.id);
      const remote = remotePlaylists.get(localPlaylist.id);

      if (!remote) {
        // New local playlist
        pendingAdditions += localTracks.length;
      } else {
        const remoteTrackIds = new Set(remote.tracks.map(t => t.id));
        const localTrackSet = new Set(localTracks);

        // Count additions (in local but not remote)
        for (const trackId of localTracks) {
          if (!remoteTrackIds.has(trackId)) {
            pendingAdditions++;
          }
        }

        // Count removals (in remote but not local)
        for (const trackId of remoteTrackIds) {
          if (!localTrackSet.has(trackId)) {
            pendingRemovals++;
          }
        }

        // Check for conflicts
        const lastMapping = this.stateStore.getPlaylistMapping(localPlaylist.id);
        if (lastMapping) {
          const localHash = computeTrackListHash(localTracks);
          if (remote.snapshotId !== lastMapping.snapshotId && localHash !== lastMapping.trackHash) {
            conflictCount++;
          }
        }
      }
    }

    return {
      localPlaylists: localPlaylists.length,
      remotePlaylists: remotePlaylists.size,
      pendingAdditions,
      pendingRemovals,
      conflicts: conflictCount,
      libraryStats,
    };
  }

  async diff(): Promise<PlaylistDiff[]> {
    const remotePlaylists = await this.fetchAllRemotePlaylists();
    const localPlaylists = this.libraryDb.getAllPlaylists();
    const diffs: PlaylistDiff[] = [];

    for (const localPlaylist of localPlaylists) {
      const localTracks = this.libraryDb.getPlaylistTrackIds(localPlaylist.id);
      const remote = remotePlaylists.get(localPlaylist.id);

      if (!remote) {
        // New playlist
        diffs.push({
          playlistId: localPlaylist.id,
          playlistName: localPlaylist.name,
          additions: localTracks,
          removals: [],
          reorderNeeded: false,
          hasConflict: false,
          localOrder: localTracks,
          remoteOrder: [],
        });
      } else {
        const remoteTrackIds = remote.tracks.map(t => t.id);
        const localTrackSet = new Set(localTracks);
        const remoteTrackSet = new Set(remoteTrackIds);

        const additions = localTracks.filter(id => !remoteTrackSet.has(id));
        const removals = remoteTrackIds.filter(id => !localTrackSet.has(id));
        const reorderNeeded = additions.length === 0 && removals.length === 0 &&
          localTracks.join(',') !== remoteTrackIds.join(',');

        if (additions.length > 0 || removals.length > 0 || reorderNeeded) {
          diffs.push({
            playlistId: localPlaylist.id,
            playlistName: localPlaylist.name,
            additions,
            removals,
            reorderNeeded,
            hasConflict: false,
            localOrder: localTracks,
            remoteOrder: remoteTrackIds,
          });
        }
      }
    }

    return diffs;
  }

  private async fetchAllRemotePlaylists(): Promise<Map<string, SpotifyPlaylistWithTracks>> {
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
}
