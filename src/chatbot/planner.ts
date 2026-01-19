import type {
  ChatbotPlan,
  PlanStep,
  FilterCriteria,
  SpotifyTrack,
  LocalPlaylist,
} from '../types/index.js';

// Keywords and patterns for intent detection
const INTENT_PATTERNS = {
  createPlaylist: [
    /create\s+(a\s+)?(.+?)?\s*playlist/i,
    /make\s+(a\s+)?(.+?)?\s*playlist/i,
    /new\s+playlist/i,
  ],
  addTracks: [
    /add\s+(.+?)?\s*(tracks?|songs?)/i,
    /include\s+(.+?)?\s*(tracks?|songs?)/i,
    /put\s+(.+?)\s+in/i,
  ],
  removeTracks: [
    /remove\s+(.+?)?\s*(tracks?|songs?)/i,
    /delete\s+(.+?)?\s*(tracks?|songs?)/i,
    /take\s+out/i,
  ],
  filterByGenre: [
    /(.+?)\s+(tracks?|songs?|music)/i,
    /genre[:\s]+(.+)/i,
  ],
  filterByArtist: [
    /by\s+(.+)/i,
    /artist[:\s]+(.+)/i,
    /from\s+(.+)/i,
  ],
  useSavedTracks: [
    /my\s+(saved\s+)?(tracks?|songs?|library)/i,
    /liked\s+(tracks?|songs?)/i,
    /my\s+favorites?/i,
  ],
  useExistingPlaylist: [
    /from\s+(.+?)\s+playlist/i,
    /in\s+(.+?)\s+playlist/i,
  ],
};

// Genre keywords mapping
const GENRE_KEYWORDS: Record<string, string[]> = {
  'bossa nova': ['bossa', 'bossa nova', 'brazilian jazz', 'mpb'],
  jazz: ['jazz', 'bebop', 'swing', 'cool jazz', 'fusion'],
  rock: ['rock', 'alternative', 'indie rock', 'classic rock'],
  pop: ['pop', 'dance pop', 'synth pop', 'electropop'],
  electronic: ['electronic', 'edm', 'house', 'techno', 'ambient'],
  classical: ['classical', 'orchestra', 'symphony', 'piano'],
  hip_hop: ['hip hop', 'rap', 'hip-hop', 'trap'],
  rnb: ['r&b', 'rnb', 'soul', 'neo-soul'],
  country: ['country', 'americana', 'bluegrass'],
  metal: ['metal', 'heavy metal', 'death metal', 'thrash'],
  chill: ['chill', 'lofi', 'lo-fi', 'relaxing', 'calm', 'ambient'],
  workout: ['workout', 'gym', 'exercise', 'running', 'pump'],
  party: ['party', 'dance', 'club', 'upbeat'],
  focus: ['focus', 'study', 'concentration', 'work'],
  sleep: ['sleep', 'lullaby', 'relax', 'calm', 'peaceful'],
};

export interface PlannerResult {
  plan: ChatbotPlan;
  confidence: number;
  interpretation: string;
}

export class ChatbotPlanner {
  analyzeIntent(prompt: string): {
    intent: string;
    entities: Record<string, string>;
    confidence: number;
  } {
    const lowerPrompt = prompt.toLowerCase();
    let intent = 'unknown';
    const entities: Record<string, string> = {};
    let confidence = 0.5;

    // Check for create playlist intent
    for (const pattern of INTENT_PATTERNS.createPlaylist) {
      const match = prompt.match(pattern);
      if (match) {
        intent = 'create_playlist';
        if (match[2]) {
          entities.playlistName = match[2].trim();
        }
        confidence = 0.8;
        break;
      }
    }

    // Check for add tracks intent
    if (intent === 'unknown') {
      for (const pattern of INTENT_PATTERNS.addTracks) {
        const match = prompt.match(pattern);
        if (match) {
          intent = 'add_tracks';
          confidence = 0.7;
          break;
        }
      }
    }

    // Check for remove tracks intent
    if (intent === 'unknown') {
      for (const pattern of INTENT_PATTERNS.removeTracks) {
        const match = prompt.match(pattern);
        if (match) {
          intent = 'remove_tracks';
          confidence = 0.7;
          break;
        }
      }
    }

    // Detect genre filter
    for (const [genre, keywords] of Object.entries(GENRE_KEYWORDS)) {
      for (const keyword of keywords) {
        if (lowerPrompt.includes(keyword)) {
          entities.genre = genre;
          if (intent === 'unknown') {
            intent = 'create_playlist';
            entities.playlistName = `${genre.charAt(0).toUpperCase() + genre.slice(1)} Mix`;
          }
          confidence = Math.max(confidence, 0.7);
          break;
        }
      }
      if (entities.genre) break;
    }

    // Detect if user wants to use saved tracks
    for (const pattern of INTENT_PATTERNS.useSavedTracks) {
      if (pattern.test(prompt)) {
        entities.useSavedTracks = 'true';
        confidence = Math.max(confidence, 0.75);
        break;
      }
    }

    // Detect target playlist
    for (const pattern of INTENT_PATTERNS.useExistingPlaylist) {
      const match = prompt.match(pattern);
      if (match) {
        entities.targetPlaylist = match[1].trim();
        confidence = Math.max(confidence, 0.7);
        break;
      }
    }

    return { intent, entities, confidence };
  }

  generatePlan(prompt: string, existingPlaylists: LocalPlaylist[]): PlannerResult {
    const { intent, entities, confidence } = this.analyzeIntent(prompt);
    const steps: PlanStep[] = [];
    let interpretation = '';

    switch (intent) {
      case 'create_playlist': {
        const playlistName =
          entities.playlistName ||
          entities.genre?.charAt(0).toUpperCase() + entities.genre?.slice(1) + ' Mix' ||
          'New Playlist';

        interpretation = `Creating a new playlist called "${playlistName}"`;

        // Gather tracks based on criteria
        if (entities.useSavedTracks) {
          steps.push({ type: 'fetch_saved_tracks', limit: 500 });
          interpretation += ' from your saved tracks';
        }

        // Search for genre-specific tracks
        if (entities.genre) {
          const searchQuery = GENRE_KEYWORDS[entities.genre]?.[0] || entities.genre;
          steps.push({ type: 'search_tracks', query: searchQuery, limit: 100 });
          interpretation += ` with ${entities.genre} music`;
        }

        // If we have existing playlists with relevant names, include them
        if (entities.genre) {
          for (const playlist of existingPlaylists) {
            const lowerName = playlist.name.toLowerCase();
            const genreKeywords = GENRE_KEYWORDS[entities.genre] || [entities.genre];
            if (genreKeywords.some((kw) => lowerName.includes(kw))) {
              steps.push({ type: 'fetch_playlist_tracks', playlistId: playlist.playlistId });
            }
          }
        }

        // Filter if we have criteria
        if (entities.genre) {
          steps.push({
            type: 'filter_tracks',
            criteria: {
              genres: [entities.genre],
              keywords: GENRE_KEYWORDS[entities.genre] || [entities.genre],
            },
          });
        }

        // Create the playlist
        steps.push({ type: 'create_branch', name: playlistName.toLowerCase().replace(/\s+/g, '-') });
        steps.push({ type: 'create_playlist', name: playlistName });
        steps.push({ type: 'commit_changes', message: `Create playlist: ${playlistName}` });

        break;
      }

      case 'add_tracks': {
        interpretation = 'Adding tracks';

        if (entities.useSavedTracks) {
          steps.push({ type: 'fetch_saved_tracks', limit: 200 });
          interpretation += ' from your saved tracks';
        }

        if (entities.genre) {
          steps.push({
            type: 'filter_tracks',
            criteria: { genres: [entities.genre] },
          });
          interpretation += ` with ${entities.genre} genre`;
        }

        if (entities.targetPlaylist) {
          interpretation += ` to ${entities.targetPlaylist}`;
        }

        steps.push({ type: 'create_branch', name: 'add-tracks' });
        steps.push({ type: 'commit_changes', message: 'Add tracks to playlist' });

        break;
      }

      case 'remove_tracks': {
        interpretation = 'Removing tracks';

        if (entities.targetPlaylist) {
          interpretation += ` from ${entities.targetPlaylist}`;
        }

        steps.push({ type: 'create_branch', name: 'remove-tracks' });
        steps.push({ type: 'commit_changes', message: 'Remove tracks from playlist' });

        break;
      }

      default: {
        // Default: try to create a playlist based on the prompt
        const words = prompt.split(/\s+/).slice(0, 3);
        const playlistName = words.join(' ') + ' Playlist';

        interpretation = `Creating a playlist based on: "${prompt}"`;

        steps.push({ type: 'search_tracks', query: prompt, limit: 50 });
        steps.push({ type: 'create_branch', name: 'new-playlist' });
        steps.push({ type: 'create_playlist', name: playlistName });
        steps.push({ type: 'commit_changes', message: `Create playlist: ${playlistName}` });
      }
    }

    // Estimate changes
    const estimatedChanges = {
      playlistsCreated: steps.filter((s) => s.type === 'create_playlist').length,
      playlistsModified: 0,
      tracksAdded: entities.useSavedTracks ? 50 : 20, // Rough estimate
      tracksRemoved: intent === 'remove_tracks' ? 10 : 0,
    };

    return {
      plan: {
        intent,
        steps,
        estimatedChanges,
      },
      confidence,
      interpretation,
    };
  }

  extractSearchQueries(prompt: string): string[] {
    const queries: string[] = [];

    // Add the main prompt as a search query
    queries.push(prompt);

    // Extract quoted strings
    const quotedMatches = prompt.match(/"([^"]+)"/g);
    if (quotedMatches) {
      queries.push(...quotedMatches.map((m) => m.replace(/"/g, '')));
    }

    // Extract genre keywords
    for (const [genre, keywords] of Object.entries(GENRE_KEYWORDS)) {
      for (const keyword of keywords) {
        if (prompt.toLowerCase().includes(keyword)) {
          queries.push(keyword);
          break;
        }
      }
    }

    return [...new Set(queries)];
  }
}
