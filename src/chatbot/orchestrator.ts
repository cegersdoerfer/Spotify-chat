import type { SpotifyClient } from '../spotify/client.js';
import type { FilesystemSerializer } from '../filesystem/serializer.js';
import type { GitManager } from '../git/manager.js';
import type { StateStore } from '../state/database.js';
import { ChatbotPlanner } from './planner.js';
import { ChatbotExecutor } from './executor.js';

export interface ChatbotOptions {
  createBranch?: boolean;
  autoApply?: boolean;
}

export interface ChatbotResult {
  success: boolean;
  summary: string;
  branchName: string | null;
  changes: {
    playlistsCreated: number;
    playlistsModified: number;
    tracksAdded: number;
    tracksRemoved: number;
  };
  applied: boolean;
  errors: string[];
}

export class ChatbotOrchestrator {
  private planner: ChatbotPlanner;
  private executor: ChatbotExecutor;
  private spotifyClient: SpotifyClient;
  private serializer: FilesystemSerializer;
  private gitManager: GitManager;

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
    this.planner = new ChatbotPlanner();
    this.executor = new ChatbotExecutor(
      spotifyClient,
      serializer,
      gitManager,
      stateStore,
      workspacePath
    );
  }

  async processRequest(
    prompt: string,
    options: ChatbotOptions = {}
  ): Promise<ChatbotResult> {
    const errors: string[] = [];

    try {
      // Step 1: Read existing playlists for context
      const existingPlaylists = this.serializer.readAllPlaylists();

      // Step 2: Generate a plan using GPT-5
      const { plan, confidence, interpretation } = await this.planner.generatePlan(
        prompt,
        existingPlaylists
      );

      if (confidence < 0.5) {
        return {
          success: false,
          summary: `I'm not sure how to help with: "${prompt}". Try being more specific, like "Create a chill playlist from my saved songs".`,
          branchName: null,
          changes: {
            playlistsCreated: 0,
            playlistsModified: 0,
            tracksAdded: 0,
            tracksRemoved: 0,
          },
          applied: false,
          errors: ['Low confidence in understanding the request'],
        };
      }

      // Step 3: Save current branch to return to
      const originalBranch = await this.gitManager.getCurrentBranch();

      // Step 4: Execute the plan
      const result = await this.executor.executeSteps(plan.steps, {
        createBranch: options.createBranch !== false,
      });

      // Step 5: Build result
      const changes = {
        playlistsCreated: result.context.createdPlaylists.length,
        playlistsModified: result.context.modifiedPlaylists.length,
        tracksAdded:
          result.context.filteredTracks.length || result.context.collectedTracks.length,
        tracksRemoved: 0,
      };

      let summary = interpretation;
      if (result.context.createdPlaylists.length > 0) {
        summary += `. Created: ${result.context.createdPlaylists.join(', ')}`;
      }
      if (changes.tracksAdded > 0) {
        summary += `. Added ${changes.tracksAdded} tracks`;
      }

      // Step 6: If not auto-applying, switch back to original branch
      let applied = false;
      if (options.autoApply && result.context.branchName) {
        // Apply would be done via the sync engine
        // For now, we stay on the proposal branch
        applied = false; // Would need to actually push to Spotify
      } else if (result.context.branchName) {
        // Switch back to original branch
        await this.gitManager.checkout(originalBranch);
      }

      return {
        success: result.success,
        summary,
        branchName: result.context.branchName,
        changes,
        applied,
        errors: result.errors,
      };
    } catch (error) {
      return {
        success: false,
        summary: `An error occurred: ${error}`,
        branchName: null,
        changes: {
          playlistsCreated: 0,
          playlistsModified: 0,
          tracksAdded: 0,
          tracksRemoved: 0,
        },
        applied: false,
        errors: [String(error)],
      };
    }
  }

  async getProposals(): Promise<
    Array<{
      id: string;
      branchName: string;
      summary: string;
      createdAt: string;
      status: string;
    }>
  > {
    const proposals = await this.gitManager.getProposalBranches();
    return proposals.map((branch) => {
      const metadata = this.gitManager.getProposalMetadata(
        branch.name.replace('bot/', '')
      );
      return {
        id: metadata?.id || branch.name,
        branchName: branch.name,
        summary: metadata?.summary || 'No summary available',
        createdAt: metadata?.createdAt || '',
        status: metadata?.status || 'unknown',
      };
    });
  }
}
