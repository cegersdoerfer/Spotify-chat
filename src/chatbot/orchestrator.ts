import type { SpotifyClient } from '../spotify/client.js';
import type { FilesystemSerializer } from '../filesystem/serializer.js';
import type { GitManager } from '../git/manager.js';
import type { StateStore } from '../state/database.js';
import { LibraryDatabase } from '../state/library.js';
import { MarkdownGenerator } from '../filesystem/markdown.js';
import { ChatbotPlanner, type LibraryContext } from './planner.js';
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
  private libraryDb: LibraryDatabase;
  private markdownGenerator: MarkdownGenerator;
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
    this.workspacePath = workspacePath;

    // Initialize library database and markdown generator
    this.libraryDb = new LibraryDatabase(workspacePath);
    this.markdownGenerator = new MarkdownGenerator(workspacePath);

    this.planner = new ChatbotPlanner();
    this.executor = new ChatbotExecutor(
      spotifyClient,
      serializer,
      gitManager,
      stateStore,
      workspacePath,
      this.libraryDb,
      this.markdownGenerator
    );
  }

  async processRequest(
    prompt: string,
    options: ChatbotOptions = {}
  ): Promise<ChatbotResult> {
    try {
      // Step 1: Build library context for the planner
      const context = this.buildLibraryContext();

      // Step 2: Generate a plan using GPT-5
      const { plan, confidence, interpretation } = await this.planner.generatePlan(
        prompt,
        context
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

      // Step 5: Generate markdown files after changes
      if (result.success) {
        this.markdownGenerator.generateAll(this.libraryDb);
      }

      // Step 6: Build result
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

      // Include SQL query/execute summaries if any
      if (result.context.queryResults.size > 0) {
        const queryCount = result.context.queryResults.size;
        summary += `. Executed ${queryCount} SQL quer${queryCount === 1 ? 'y' : 'ies'}`;
      }
      if (result.context.executeResults.size > 0) {
        let totalChanges = 0;
        for (const r of result.context.executeResults.values()) {
          totalChanges += r.changes;
        }
        if (totalChanges > 0) {
          summary += `. Modified ${totalChanges} database row${totalChanges === 1 ? '' : 's'}`;
        }
      }

      // Step 7: If not auto-applying, switch back to original branch
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

  private buildLibraryContext(): LibraryContext {
    const schema = this.libraryDb.getSchema();
    const stats = this.libraryDb.getStats();

    // Build playlist summary
    const playlists = this.libraryDb.getAllPlaylists();
    let playlistSummary = '### Playlists\n\n';

    if (playlists.length === 0) {
      playlistSummary += 'No playlists in library yet.\n';
    } else {
      playlistSummary += '| ID | Name | Tracks | Last Synced |\n';
      playlistSummary += '|-----|------|--------|-------------|\n';
      for (const p of playlists.slice(0, 50)) { // Limit to 50 for context size
        const syncedAt = p.last_synced_at
          ? new Date(p.last_synced_at).toLocaleDateString()
          : 'never';
        playlistSummary += `| ${p.id} | ${p.name} | ${p.track_count} | ${syncedAt} |\n`;
      }
      if (playlists.length > 50) {
        playlistSummary += `\n_...and ${playlists.length - 50} more playlists_\n`;
      }
    }

    return {
      schema,
      stats,
      playlistSummary,
    };
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

  /**
   * Get the library database for direct queries (useful for CLI)
   */
  getLibraryDatabase(): LibraryDatabase {
    return this.libraryDb;
  }

  /**
   * Get the markdown generator (useful for manual regeneration)
   */
  getMarkdownGenerator(): MarkdownGenerator {
    return this.markdownGenerator;
  }

  /**
   * Close database connections
   */
  close(): void {
    this.libraryDb.close();
  }
}
