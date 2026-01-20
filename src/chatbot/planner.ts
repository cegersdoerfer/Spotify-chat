import OpenAI from 'openai';
import { z } from 'zod';
import type { ChatbotPlan, PlanStep } from '../types/index.js';

// Zod schemas for structured output validation
const FilterCriteriaSchema = z.object({
  genres: z.array(z.string()).optional(),
  artists: z.array(z.string()).optional(),
  keywords: z.array(z.string()).optional(),
  yearRange: z.object({
    start: z.number(),
    end: z.number(),
  }).optional(),
  energyRange: z.object({
    min: z.number(),
    max: z.number(),
  }).optional(),
});

const PlanStepSchema = z.discriminatedUnion('type', [
  // Spotify API operations
  z.object({ type: z.literal('search_tracks'), query: z.string(), limit: z.number() }),
  z.object({ type: z.literal('fetch_saved_tracks'), limit: z.number() }),
  z.object({ type: z.literal('filter_tracks'), criteria: FilterCriteriaSchema }),

  // SQL operations (local database)
  z.object({ type: z.literal('sql_query'), query: z.string(), description: z.string() }),
  z.object({ type: z.literal('sql_execute'), query: z.string(), description: z.string() }),

  // Playlist operations
  z.object({ type: z.literal('create_playlist'), name: z.string(), description: z.string().optional() }),
  z.object({ type: z.literal('delete_playlist'), playlistId: z.string() }),
  z.object({ type: z.literal('rename_playlist'), playlistId: z.string(), newName: z.string() }),

  // Track operations
  z.object({ type: z.literal('add_tracks_to_playlist'), playlistId: z.string(), trackIds: z.array(z.string()) }),
  z.object({ type: z.literal('remove_tracks_from_playlist'), playlistId: z.string(), trackIds: z.array(z.string()) }),
  z.object({ type: z.literal('move_tracks'), fromPlaylistId: z.string(), toPlaylistId: z.string(), trackIds: z.array(z.string()) }),
  z.object({ type: z.literal('reorder_tracks'), playlistId: z.string(), trackIds: z.array(z.string()) }),

  // Git operations
  z.object({ type: z.literal('create_branch'), name: z.string() }),
  z.object({ type: z.literal('commit_changes'), message: z.string() }),

  // Sync operations
  z.object({ type: z.literal('sync_to_spotify') }),
  z.object({ type: z.literal('generate_markdown') }),
]);

const ChatbotPlanSchema = z.object({
  intent: z.string(),
  steps: z.array(PlanStepSchema),
  estimatedChanges: z.object({
    playlistsCreated: z.number(),
    playlistsModified: z.number(),
    tracksAdded: z.number(),
    tracksRemoved: z.number(),
  }),
});

const PlannerResponseSchema = z.object({
  plan: ChatbotPlanSchema,
  confidence: z.number().min(0).max(1),
  interpretation: z.string(),
});

export interface PlannerResult {
  plan: ChatbotPlan;
  confidence: number;
  interpretation: string;
}

export interface LibraryContext {
  schema: string;
  stats: { playlists: number; tracks: number; totalPlaylistTracks: number };
  playlistSummary: string;
}

const SYSTEM_PROMPT = `You are the SpotifyFS Planner, an AI that helps users manage their Spotify playlists.

The user's music library is stored in a SQLite database. You can query and modify it using SQL, similar to how you might reorganize a codebase using shell commands.

## Available Step Types

### SQL Operations (for reading and modifying local library)

1. **sql_query** - Execute a SELECT query to read data
   - query: string (SQL SELECT statement)
   - description: string (what this query does)

2. **sql_execute** - Execute INSERT/UPDATE/DELETE to modify data
   - query: string (SQL modification statement)
   - description: string (what this change does)

### Spotify API Operations (for fetching new data)

3. **search_tracks** - Search Spotify for new tracks to add
   - query: string (search query)
   - limit: number (max results, recommend 50-100)

4. **fetch_saved_tracks** - Get user's liked tracks from Spotify
   - limit: number (max tracks, recommend 200-500)

5. **filter_tracks** - Filter fetched tracks by criteria before adding
   - criteria: { genres?, artists?, keywords?, yearRange?, energyRange? }

### Playlist Operations

6. **create_playlist** - Create a new playlist
   - name: string
   - description: string (optional)

7. **delete_playlist** - Delete a playlist
   - playlistId: string

8. **rename_playlist** - Rename a playlist
   - playlistId: string
   - newName: string

### Track Operations

9. **add_tracks_to_playlist** - Add tracks to a playlist
   - playlistId: string
   - trackIds: string[] (array of track IDs)

10. **remove_tracks_from_playlist** - Remove tracks from a playlist
    - playlistId: string
    - trackIds: string[]

11. **move_tracks** - Move tracks from one playlist to another
    - fromPlaylistId: string
    - toPlaylistId: string
    - trackIds: string[]

12. **reorder_tracks** - Reorder tracks in a playlist
    - playlistId: string
    - trackIds: string[] (new order)

### Git & Sync Operations

13. **create_branch** - Create a Git branch before making changes
    - name: string (lowercase with hyphens)

14. **commit_changes** - Commit changes to Git
    - message: string

15. **sync_to_spotify** - Push local changes to Spotify

16. **generate_markdown** - Regenerate markdown files for Git tracking

## Database Schema

{SCHEMA}

## Planning Guidelines

1. **Use SQL for analysis**: Before making changes, query the database to understand the current state
2. **SQL for bulk operations**: Use SQL UPDATE/DELETE for bulk changes instead of individual operations
3. **Always create a branch first**: Before modifying data, create a Git branch
4. **Commit and generate markdown**: After changes, commit and regenerate markdown files
5. **Be precise with SQL**: Write exact SQL queries - the executor will run them directly
6. **Track IDs matter**: When moving/adding tracks, always use track IDs from query results

## Example Patterns

### Find and remove duplicates:
\`\`\`
1. sql_query: "SELECT track_id, COUNT(*) as cnt FROM playlist_tracks GROUP BY track_id HAVING cnt > 1"
2. sql_execute: "DELETE FROM playlist_tracks WHERE rowid NOT IN (SELECT MIN(rowid) FROM playlist_tracks GROUP BY playlist_id, track_id)"
\`\`\`

### Move all tracks by artist to a playlist:
\`\`\`
1. sql_query: "SELECT id FROM tracks WHERE artists LIKE '%Artist Name%'"
2. sql_execute: "INSERT INTO playlist_tracks (playlist_id, track_id, position) SELECT 'target_id', id, ROW_NUMBER() OVER() FROM tracks WHERE artists LIKE '%Artist Name%'"
\`\`\`

### Create playlist from search results:
\`\`\`
1. search_tracks: "jazz bossa nova"
2. create_playlist: "Jazz & Bossa"
3. add_tracks_to_playlist: (use collected track IDs)
\`\`\`

## Response Format

Respond with a JSON object containing:
- plan: The structured plan with intent, steps, and estimatedChanges
- confidence: A number 0-1 indicating confidence in understanding the request
- interpretation: A human-readable summary of what you will do
`;

export class ChatbotPlanner {
  private openai: OpenAI;
  private model: string = 'gpt-5';

  constructor(apiKey?: string) {
    this.openai = new OpenAI({
      apiKey: apiKey || process.env.OPENAI_API_KEY,
    });
  }

  async generatePlan(
    prompt: string,
    context: LibraryContext
  ): Promise<PlannerResult> {
    const systemPrompt = SYSTEM_PROMPT.replace('{SCHEMA}', context.schema);

    const userContext = `
## Current Library State

${context.playlistSummary}

Statistics: ${context.stats.playlists} playlists, ${context.stats.tracks} unique tracks, ${context.stats.totalPlaylistTracks} total playlist entries

## User Request

${prompt}
`;

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: systemPrompt,
          },
          {
            role: 'user',
            content: userContext,
          },
        ],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      });

      const content = response.choices[0]?.message?.content;
      if (!content) {
        throw new Error('No response from LLM');
      }

      const parsed = JSON.parse(content);
      const validated = PlannerResponseSchema.parse(parsed);

      return {
        plan: validated.plan as ChatbotPlan,
        confidence: validated.confidence,
        interpretation: validated.interpretation,
      };
    } catch (error) {
      console.error('LLM planning failed:', error);
      return this.fallbackPlan(prompt);
    }
  }

  private fallbackPlan(prompt: string): PlannerResult {
    const words = prompt.split(/\s+/).slice(0, 3);
    const playlistName = words.join(' ') + ' Playlist';
    const branchName = words.join('-').toLowerCase();

    return {
      plan: {
        intent: 'create_playlist',
        steps: [
          { type: 'create_branch', name: branchName },
          { type: 'search_tracks', query: prompt, limit: 50 },
          { type: 'create_playlist', name: playlistName },
          { type: 'commit_changes', message: `Create playlist: ${playlistName}` },
        ],
        estimatedChanges: {
          playlistsCreated: 1,
          playlistsModified: 0,
          tracksAdded: 50,
          tracksRemoved: 0,
        },
      },
      confidence: 0.3,
      interpretation: `Fallback: Creating a playlist based on "${prompt}"`,
    };
  }

  extractSearchQueries(prompt: string): string[] {
    const queries: string[] = [prompt];
    const quotedMatches = prompt.match(/"([^"]+)"/g);
    if (quotedMatches) {
      queries.push(...quotedMatches.map((m) => m.replace(/"/g, '')));
    }
    return [...new Set(queries)];
  }
}
