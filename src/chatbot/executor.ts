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

export interface ExecutorContext {
  collectedTracks: SpotifyTrack[];
  filteredTracks: SpotifyTrack[];
  createdPlaylists: string[];
  modifiedPlaylists: string[];
  branchName: string | null;
  proposalId: string | null;
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

  constructor(
    spotifyClient: SpotifyClient,
    serializer: FilesystemSerializer,
    gitManager: GitManager,
    stateStore: StateStore,
    workspacePath: string
  ) {
    this.spotifyClient = spotifyClient;
    this.serializer = serializer;
    this.gitManager = gitManager;
    this.stateStore = stateStore;
    this.workspacePath = workspacePath;
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
      case 'search_tracks': {
        const result = await this.spotifyClient.searchTracks(step.query, step.limit);
        context.collectedTracks.push(...result.items);
        break;
      }

      case 'list_playlists': {
        // This is read-only, used for gathering info
        await this.spotifyClient.getAllUserPlaylists();
        break;
      }

      case 'fetch_playlist_tracks': {
        const tracks = await this.spotifyClient.getPlaylistTracks(step.playlistId);
        context.collectedTracks.push(...tracks);
        break;
      }

      case 'fetch_saved_tracks': {
        const tracks = await this.spotifyClient.getAllSavedTracks(step.limit);
        context.collectedTracks.push(...tracks);
        break;
      }

      case 'filter_tracks': {
        context.filteredTracks = this.filterTracks(
          context.collectedTracks,
          step.criteria
        );
        break;
      }

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

        // Create playlist metadata for the filesystem
        const playlistId = `new_${uuidv4().slice(0, 8)}`;
        const path = this.serializer.createPlaylistFolder(step.name, playlistId);

        // Add tracks to the local playlist
        for (let i = 0; i < tracksToAdd.length; i++) {
          const track = tracksToAdd[i];
          this.serializer.addTrack(path, track, i + 1);
        }

        context.createdPlaylists.push(step.name);
        break;
      }

      case 'add_tracks_to_playlist': {
        const tracks =
          context.filteredTracks.length > 0
            ? context.filteredTracks
            : context.collectedTracks;

        const path = this.serializer.getPlaylistPathById(step.playlistId);
        if (path) {
          for (const track of tracks.slice(0, 50)) {
            this.serializer.addTrack(path, track);
          }
          context.modifiedPlaylists.push(step.playlistId);
        }
        break;
      }

      case 'remove_tracks_from_playlist': {
        const path = this.serializer.getPlaylistPathById(step.playlistId);
        if (path) {
          for (const trackId of step.trackIds) {
            this.serializer.removeTrack(path, trackId);
          }
          context.modifiedPlaylists.push(step.playlistId);
        }
        break;
      }

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
}
