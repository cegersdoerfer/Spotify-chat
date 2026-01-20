import { v4 as uuidv4 } from 'uuid';
import type {
  PlanStep,
  SpotifyTrack,
  FilterCriteria,
  ProposalMetadata,
} from '../types/index.js';
import type { SpotifyClient } from '../spotify/client.js';
import type { FilesystemSerializer } from '../filesystem/serializer.js';
import type { GitManager } from '../git/manager.js';
import type { StateStore } from '../state/database.js';
import type { LibraryDatabase } from '../state/library.js';
import type { MarkdownGenerator } from '../filesystem/markdown.js';

export interface ExecutorContext {
  collectedTracks: SpotifyTrack[];
  filteredTracks: SpotifyTrack[];
  createdPlaylists: string[];
  modifiedPlaylists: string[];
  branchName: string | null;
  proposalId: string | null;
  queryResults: Map<string, unknown[]>;
  executeResults: Map<string, { changes: number; lastInsertRowid: number | bigint }>;
}

export interface ExecutorResult {
  success: boolean;
  context: ExecutorContext;
  errors: string[];
}

export class ChatbotExecutor {
  private spotifyClient: SpotifyClient;
  private serializer: FilesystemSerializer;
  private gitManager: GitManager;
  private stateStore: StateStore;
  private workspacePath: string;
  private libraryDb: LibraryDatabase;
  private markdownGenerator: MarkdownGenerator;

  constructor(
    spotifyClient: SpotifyClient,
    serializer: FilesystemSerializer,
    gitManager: GitManager,
    stateStore: StateStore,
    workspacePath: string,
    libraryDb: LibraryDatabase,
    markdownGenerator: MarkdownGenerator
  ) {
    this.spotifyClient = spotifyClient;
    this.serializer = serializer;
    this.gitManager = gitManager;
    this.stateStore = stateStore;
    this.workspacePath = workspacePath;
    this.libraryDb = libraryDb;
    this.markdownGenerator = markdownGenerator;
  }

  async executeSteps(
    steps: PlanStep[],
    options: { createBranch?: boolean } = {}
  ): Promise<ExecutorResult> {
    const context: ExecutorContext = {
      collectedTracks: [],
      filteredTracks: [],
      createdPlaylists: [],
      modifiedPlaylists: [],
      branchName: null,
      proposalId: null,
      queryResults: new Map(),
      executeResults: new Map(),
    };

    const errors: string[] = [];

    for (const step of steps) {
      try {
        await this.executeStep(step, context, options);
      } catch (error) {
        errors.push(`Step ${step.type} failed: ${error}`);
      }
    }

    return {
      success: errors.length === 0,
      context,
      errors,
    };
  }

  private async executeStep(
    step: PlanStep,
    context: ExecutorContext,
    options: { createBranch?: boolean }
  ): Promise<void> {
    switch (step.type) {
      // ==================== SQL Operations ====================
      case 'sql_query': {
        const results = this.libraryDb.query(step.query);
        context.queryResults.set(step.description, results);

        // If query returns tracks, add them to collected tracks for later use
        if (results.length > 0 && this.isTrackResult(results[0])) {
          const tracks = results.map(r => this.dbResultToSpotifyTrack(r as Record<string, unknown>));
          context.collectedTracks.push(...tracks);
        }
        break;
      }

      case 'sql_execute': {
        const result = this.libraryDb.execute(step.query);
        context.executeResults.set(step.description, result);
        break;
      }

      // ==================== Spotify API Operations ====================
      case 'search_tracks': {
        const result = await this.spotifyClient.searchTracks(step.query, step.limit);
        context.collectedTracks.push(...result.items);

        // Also cache these tracks in the library database
        this.libraryDb.upsertTracks(result.items);
        break;
      }

      case 'list_playlists': {
        await this.spotifyClient.getAllUserPlaylists();
        break;
      }

      case 'fetch_playlist_tracks': {
        const tracks = await this.spotifyClient.getPlaylistTracks(step.playlistId);
        context.collectedTracks.push(...tracks);

        // Cache in library database
        this.libraryDb.upsertTracks(tracks);
        break;
      }

      case 'fetch_saved_tracks': {
        const tracks = await this.spotifyClient.getAllSavedTracks(step.limit);
        context.collectedTracks.push(...tracks);

        // Cache in library database
        this.libraryDb.upsertTracks(tracks);
        break;
      }

      case 'filter_tracks': {
        context.filteredTracks = this.filterTracks(
          context.collectedTracks,
          step.criteria
        );
        break;
      }

      // ==================== Playlist Operations ====================
      case 'create_playlist': {
        // Get tracks to add (use filtered if available, otherwise collected)
        const tracks =
          context.filteredTracks.length > 0
            ? context.filteredTracks
            : context.collectedTracks;

        // Deduplicate tracks
        const uniqueTracks = this.deduplicateTracks(tracks);

        // Limit to reasonable size
        const tracksToAdd = uniqueTracks.slice(0, 100);

        // Create local playlist ID (will be replaced when synced to Spotify)
        const playlistId = `local_${uuidv4().slice(0, 8)}`;

        // Create playlist in database
        this.libraryDb.createLocalPlaylist(playlistId, step.name, step.description || '');

        // Add tracks to database
        if (tracksToAdd.length > 0) {
          this.libraryDb.setPlaylistTracks(playlistId, tracksToAdd);
        }

        // Also create in filesystem for backwards compatibility
        const path = this.serializer.createPlaylistFolder(step.name, playlistId);
        for (let i = 0; i < tracksToAdd.length; i++) {
          const track = tracksToAdd[i];
          this.serializer.addTrack(path, track, i + 1);
        }

        context.createdPlaylists.push(step.name);
        break;
      }

      case 'delete_playlist': {
        // Get playlist info before deleting for markdown cleanup
        const playlistToDelete = this.libraryDb.getPlaylist(step.playlistId);

        // Delete from database
        this.libraryDb.deletePlaylist(step.playlistId);

        // Also remove from filesystem
        const deletePath = this.serializer.getPlaylistPathById(step.playlistId);
        if (deletePath) {
          this.serializer.deletePlaylist(deletePath);
        }

        // Remove markdown file
        if (playlistToDelete) {
          this.markdownGenerator.removePlaylist(playlistToDelete.name);
        }

        context.modifiedPlaylists.push(step.playlistId);
        break;
      }

      case 'rename_playlist': {
        // Get old name for markdown cleanup
        const oldPlaylist = this.libraryDb.getPlaylist(step.playlistId);

        // Rename in database
        this.libraryDb.renamePlaylist(step.playlistId, step.newName);

        // Rename in filesystem
        const renamePath = this.serializer.getPlaylistPathById(step.playlistId);
        if (renamePath) {
          this.serializer.renamePlaylist(renamePath, step.newName, step.playlistId);
        }

        // Update markdown (remove old, regenerate new)
        if (oldPlaylist) {
          this.markdownGenerator.removePlaylist(oldPlaylist.name);
        }
        this.markdownGenerator.updatePlaylist(this.libraryDb, step.playlistId);

        context.modifiedPlaylists.push(step.playlistId);
        break;
      }

      // ==================== Track Operations ====================
      case 'add_tracks_to_playlist': {
        const tracks =
          context.filteredTracks.length > 0
            ? context.filteredTracks
            : context.collectedTracks;

        // Get track IDs - either from step or from collected tracks
        const trackIdsToAdd = step.trackIds.length > 0
          ? step.trackIds
          : tracks.slice(0, 50).map(t => t.id);

        // Add to database
        for (const trackId of trackIdsToAdd) {
          this.libraryDb.addTrackToPlaylist(step.playlistId, trackId);
        }

        // Also add to filesystem for backwards compatibility
        const path = this.serializer.getPlaylistPathById(step.playlistId);
        if (path) {
          for (const track of tracks.filter(t => trackIdsToAdd.includes(t.id))) {
            this.serializer.addTrack(path, track);
          }
        }

        context.modifiedPlaylists.push(step.playlistId);
        break;
      }

      case 'remove_tracks_from_playlist': {
        // Remove from database
        for (const trackId of step.trackIds) {
          this.libraryDb.removeTrackFromPlaylist(step.playlistId, trackId);
        }

        // Also remove from filesystem
        const path = this.serializer.getPlaylistPathById(step.playlistId);
        if (path) {
          for (const trackId of step.trackIds) {
            this.serializer.removeTrack(path, trackId);
          }
        }

        context.modifiedPlaylists.push(step.playlistId);
        break;
      }

      case 'move_tracks': {
        // Remove from source playlist
        for (const trackId of step.trackIds) {
          this.libraryDb.removeTrackFromPlaylist(step.fromPlaylistId, trackId);
        }

        // Add to destination playlist
        for (const trackId of step.trackIds) {
          this.libraryDb.addTrackToPlaylist(step.toPlaylistId, trackId);
        }

        context.modifiedPlaylists.push(step.fromPlaylistId, step.toPlaylistId);
        break;
      }

      case 'reorder_tracks': {
        this.libraryDb.reorderPlaylistTracks(step.playlistId, step.trackIds);
        context.modifiedPlaylists.push(step.playlistId);
        break;
      }

      // ==================== Git Operations ====================
      case 'create_branch': {
        if (options.createBranch !== false) {
          const branchName = await this.gitManager.createProposalBranch(step.name);
          context.branchName = branchName;
          context.proposalId = uuidv4();
        }
        break;
      }

      case 'commit_changes': {
        if (context.branchName && context.proposalId) {
          const metadata: ProposalMetadata = {
            id: context.proposalId,
            userPrompt: step.message,
            branchName: context.branchName,
            createdAt: new Date().toISOString(),
            summary: step.message,
            changes: {
              playlistsCreated: context.createdPlaylists.length,
              playlistsModified: context.modifiedPlaylists.length,
              tracksAdded: context.filteredTracks.length || context.collectedTracks.length,
              tracksRemoved: 0,
            },
            assumptions: [],
            status: 'pending',
          };

          await this.gitManager.commitWithMetadata(step.message, metadata);

          this.stateStore.saveProposal({
            id: metadata.id,
            branchName: metadata.branchName,
            userPrompt: metadata.userPrompt,
            metadata: JSON.stringify(metadata),
            createdAt: metadata.createdAt,
            status: 'pending',
          });
        } else {
          await this.gitManager.commitChanges(step.message);
        }
        break;
      }

      // ==================== Sync Operations ====================
      case 'sync_to_spotify': {
        // This would trigger the sync engine to push changes to Spotify
        // For now, we just mark that sync is needed
        console.log('Sync to Spotify requested - changes will be pushed on next sync');
        break;
      }

      case 'generate_markdown': {
        // Regenerate all markdown files from database
        this.markdownGenerator.generateAll(this.libraryDb);
        break;
      }
    }
  }

  private filterTracks(tracks: SpotifyTrack[], criteria: FilterCriteria): SpotifyTrack[] {
    return tracks.filter((track) => {
      // Filter by keywords in track name, artist, or album
      if (criteria.keywords && criteria.keywords.length > 0) {
        const searchText = `${track.name} ${track.artists.join(' ')} ${track.album}`.toLowerCase();
        const matchesKeyword = criteria.keywords.some((kw) =>
          searchText.includes(kw.toLowerCase())
        );
        if (!matchesKeyword) {
          return false;
        }
      }

      // Filter by artist
      if (criteria.artists && criteria.artists.length > 0) {
        const trackArtists = track.artists.map((a) => a.toLowerCase());
        const matchesArtist = criteria.artists.some((a) =>
          trackArtists.some((ta) => ta.includes(a.toLowerCase()))
        );
        if (!matchesArtist) {
          return false;
        }
      }

      return true;
    });
  }

  private deduplicateTracks(tracks: SpotifyTrack[]): SpotifyTrack[] {
    const seen = new Set<string>();
    const unique: SpotifyTrack[] = [];

    for (const track of tracks) {
      if (!seen.has(track.id)) {
        seen.add(track.id);
        unique.push(track);
      }
    }

    return unique;
  }

  private isTrackResult(result: unknown): boolean {
    if (typeof result !== 'object' || result === null) return false;
    const r = result as Record<string, unknown>;
    return 'id' in r && 'name' in r && 'uri' in r;
  }

  private dbResultToSpotifyTrack(row: Record<string, unknown>): SpotifyTrack {
    return {
      id: String(row.id),
      uri: String(row.uri),
      name: String(row.name),
      artists: typeof row.artists === 'string' ? JSON.parse(row.artists) : [],
      album: String(row.album || ''),
      durationMs: Number(row.duration_ms || 0),
      addedAt: row.added_at ? String(row.added_at) : undefined,
    };
  }
}
