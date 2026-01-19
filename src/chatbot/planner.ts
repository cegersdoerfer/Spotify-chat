import OpenAI from 'openai';
import { z } from 'zod';
import type {
  ChatbotPlan,
  PlanStep,
  LocalPlaylist,
} from '../types/index.js';

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
  z.object({ type: z.literal('search_tracks'), query: z.string(), limit: z.number() }),
  z.object({ type: z.literal('list_playlists') }),
  z.object({ type: z.literal('fetch_playlist_tracks'), playlistId: z.string() }),
  z.object({ type: z.literal('fetch_saved_tracks'), limit: z.number() }),
  z.object({ type: z.literal('filter_tracks'), criteria: FilterCriteriaSchema }),
  z.object({ type: z.literal('create_playlist'), name: z.string() }),
  z.object({ type: z.literal('add_tracks_to_playlist'), playlistId: z.string(), trackIds: z.array(z.string()) }),
  z.object({ type: z.literal('remove_tracks_from_playlist'), playlistId: z.string(), trackIds: z.array(z.string()) }),
  z.object({ type: z.literal('create_branch'), name: z.string() }),
  z.object({ type: z.literal('commit_changes'), message: z.string() }),
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

const SYSTEM_PROMPT = `You are the SpotifyFS Planner, an AI that helps users manage their Spotify playlists through a local filesystem interface.

Your job is to analyze user requests and create a structured plan of steps to accomplish their goal.

## Available Step Types

You can use the following step types in your plan:

1. **search_tracks** - Search Spotify for tracks
   - query: string (search query)
   - limit: number (max tracks to return, recommend 50-100)

2. **list_playlists** - Get all user's playlists (read-only, for gathering info)

3. **fetch_playlist_tracks** - Get all tracks from a specific playlist
   - playlistId: string (the playlist ID)

4. **fetch_saved_tracks** - Get user's liked/saved tracks
   - limit: number (max tracks, recommend 200-500)

5. **filter_tracks** - Filter collected tracks by criteria
   - criteria: object with optional fields:
     - genres: string[] (genre keywords to match)
     - artists: string[] (artist names to match)
     - keywords: string[] (keywords to search in track/artist/album names)
     - yearRange: { start: number, end: number }
     - energyRange: { min: number, max: number } (0-1 scale)

6. **create_playlist** - Create a new playlist
   - name: string (playlist name)

7. **add_tracks_to_playlist** - Add tracks to an existing playlist
   - playlistId: string
   - trackIds: string[] (can be empty if using filtered tracks from context)

8. **remove_tracks_from_playlist** - Remove tracks from a playlist
   - playlistId: string
   - trackIds: string[]

9. **create_branch** - Create a Git branch for the changes (always do this before making changes)
   - name: string (branch name, use lowercase with hyphens)

10. **commit_changes** - Commit the changes to Git (always do this after making changes)
    - message: string (commit message)

## Planning Guidelines

1. Always start with a **create_branch** step before making any changes
2. Always end with a **commit_changes** step after making changes
3. Gather data first (search, fetch), then filter, then create/modify
4. When creating playlists based on genres or moods, use both search_tracks AND fetch_saved_tracks for better results
5. Use filter_tracks to narrow down collected tracks to match the user's intent
6. Be generous with track limits - it's better to collect more and filter than to miss good tracks
7. For genre-based requests, include relevant keywords in the filter criteria

## Response Format

You must respond with a JSON object containing:
- plan: The structured plan with intent, steps, and estimatedChanges
- confidence: A number 0-1 indicating how confident you are in understanding the request
- interpretation: A human-readable summary of what you understood and will do

## Existing Playlists Context

The user's existing playlists will be provided. Use their IDs when referencing existing playlists.
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
    existingPlaylists: LocalPlaylist[]
  ): Promise<PlannerResult> {
    const playlistContext = existingPlaylists.length > 0
      ? `\n\nUser's existing playlists:\n${existingPlaylists
          .map((p) => `- "${p.name}" (ID: ${p.playlistId}, ${p.tracks.length} tracks)`)
          .join('\n')}`
      : '\n\nUser has no existing playlists yet.';

    try {
      const response = await this.openai.chat.completions.create({
        model: this.model,
        messages: [
          {
            role: 'system',
            content: SYSTEM_PROMPT + playlistContext,
          },
          {
            role: 'user',
            content: prompt,
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
      // If LLM fails, return a low-confidence fallback
      console.error('LLM planning failed:', error);
      return this.fallbackPlan(prompt);
    }
  }

  private fallbackPlan(prompt: string): PlannerResult {
    // Simple fallback if LLM is unavailable
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

  // Utility method to extract search queries (can still be useful)
  extractSearchQueries(prompt: string): string[] {
    const queries: string[] = [prompt];

    // Extract quoted strings
    const quotedMatches = prompt.match(/"([^"]+)"/g);
    if (quotedMatches) {
      queries.push(...quotedMatches.map((m) => m.replace(/"/g, '')));
    }

    return [...new Set(queries)];
  }
}
