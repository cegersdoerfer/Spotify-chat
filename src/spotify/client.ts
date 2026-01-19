import type {
  SpotifyTrack,
  SpotifyPlaylist,
  SpotifyPlaylistWithTracks,
  SpotifyPaginated,
  TokenData,
} from '../types/index.js';
import { sleep, chunkArray, withRetry } from '../utils/index.js';
import { refreshAccessToken } from './auth.js';

const SPOTIFY_API_BASE = 'https://api.spotify.com/v1';
const MAX_TRACKS_PER_REQUEST = 100;
const MAX_TRACKS_TO_ADD = 100;
const MAX_TRACKS_TO_REMOVE = 100;

interface RateLimitState {
  retryAfter: number | null;
  lastRequest: number;
}

export class SpotifyClient {
  private tokenData: TokenData;
  private clientId: string;
  private rateLimitState: RateLimitState = { retryAfter: null, lastRequest: 0 };
  private onTokenRefresh?: (newToken: TokenData) => Promise<void>;

  constructor(
    tokenData: TokenData,
    clientId: string,
    onTokenRefresh?: (newToken: TokenData) => Promise<void>
  ) {
    this.tokenData = tokenData;
    this.clientId = clientId;
    this.onTokenRefresh = onTokenRefresh;
  }

  private async ensureValidToken(): Promise<void> {
    // Refresh token if it expires in the next 5 minutes
    if (Date.now() > this.tokenData.expiresAt - 5 * 60 * 1000) {
      this.tokenData = await refreshAccessToken(this.tokenData.refreshToken, this.clientId);
      if (this.onTokenRefresh) {
        await this.onTokenRefresh(this.tokenData);
      }
    }
  }

  private async request<T>(
    endpoint: string,
    options: RequestInit = {}
  ): Promise<T> {
    await this.ensureValidToken();

    // Respect rate limiting
    if (this.rateLimitState.retryAfter) {
      const waitTime = this.rateLimitState.retryAfter - Date.now();
      if (waitTime > 0) {
        await sleep(waitTime);
      }
      this.rateLimitState.retryAfter = null;
    }

    const url = endpoint.startsWith('http') ? endpoint : `${SPOTIFY_API_BASE}${endpoint}`;

    const response = await withRetry(
      async () => {
        const res = await fetch(url, {
          ...options,
          headers: {
            Authorization: `Bearer ${this.tokenData.accessToken}`,
            'Content-Type': 'application/json',
            ...options.headers,
          },
        });

        if (res.status === 429) {
          const retryAfter = parseInt(res.headers.get('Retry-After') || '5', 10);
          this.rateLimitState.retryAfter = Date.now() + retryAfter * 1000;
          throw new Error(`Rate limited. Retry after ${retryAfter} seconds`);
        }

        if (!res.ok) {
          const errorText = await res.text();
          throw new Error(`Spotify API error: ${res.status} - ${errorText}`);
        }

        // Handle 204 No Content
        if (res.status === 204) {
          return null as T;
        }

        return res.json() as Promise<T>;
      },
      {
        maxRetries: 3,
        baseDelayMs: 1000,
        shouldRetry: (error) => {
          if (error instanceof Error && error.message.includes('Rate limited')) {
            return true;
          }
          return false;
        },
      }
    );

    this.rateLimitState.lastRequest = Date.now();
    return response;
  }

  // User profile
  async getCurrentUser(): Promise<{ id: string; display_name: string }> {
    return this.request('/me');
  }

  // Playlists
  async getUserPlaylists(limit = 50, offset = 0): Promise<SpotifyPaginated<SpotifyPlaylist>> {
    const response = await this.request<{
      items: Array<{
        id: string;
        uri: string;
        name: string;
        description: string | null;
        public: boolean;
        collaborative: boolean;
        snapshot_id: string;
        owner: { id: string; display_name: string };
        tracks: { total: number };
      }>;
      total: number;
      limit: number;
      offset: number;
      next: string | null;
      previous: string | null;
    }>(`/me/playlists?limit=${limit}&offset=${offset}`);

    return {
      items: response.items.map((item) => ({
        id: item.id,
        uri: item.uri,
        name: item.name,
        description: item.description || '',
        isPublic: item.public,
        collaborative: item.collaborative,
        snapshotId: item.snapshot_id,
        owner: {
          id: item.owner.id,
          displayName: item.owner.display_name,
        },
        trackCount: item.tracks.total,
      })),
      total: response.total,
      limit: response.limit,
      offset: response.offset,
      next: response.next,
      previous: response.previous,
    };
  }

  async getAllUserPlaylists(): Promise<SpotifyPlaylist[]> {
    const playlists: SpotifyPlaylist[] = [];
    let offset = 0;
    const limit = 50;

    while (true) {
      const page = await this.getUserPlaylists(limit, offset);
      playlists.push(...page.items);

      if (!page.next || page.items.length === 0) {
        break;
      }
      offset += limit;
    }

    return playlists;
  }

  async getPlaylist(playlistId: string): Promise<SpotifyPlaylist> {
    const response = await this.request<{
      id: string;
      uri: string;
      name: string;
      description: string | null;
      public: boolean;
      collaborative: boolean;
      snapshot_id: string;
      owner: { id: string; display_name: string };
      tracks: { total: number };
    }>(`/playlists/${playlistId}`);

    return {
      id: response.id,
      uri: response.uri,
      name: response.name,
      description: response.description || '',
      isPublic: response.public,
      collaborative: response.collaborative,
      snapshotId: response.snapshot_id,
      owner: {
        id: response.owner.id,
        displayName: response.owner.display_name,
      },
      trackCount: response.tracks.total,
    };
  }

  async getPlaylistTracks(playlistId: string): Promise<SpotifyTrack[]> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;

    while (true) {
      const response = await this.request<{
        items: Array<{
          added_at: string;
          track: {
            id: string;
            uri: string;
            name: string;
            artists: Array<{ name: string }>;
            album: { name: string };
            duration_ms: number;
          } | null;
        }>;
        next: string | null;
      }>(`/playlists/${playlistId}/tracks?limit=${MAX_TRACKS_PER_REQUEST}&offset=${offset}&fields=items(added_at,track(id,uri,name,artists(name),album(name),duration_ms)),next`);

      for (const item of response.items) {
        // Skip local tracks or null tracks
        if (!item.track || !item.track.id) continue;

        tracks.push({
          id: item.track.id,
          uri: item.track.uri,
          name: item.track.name,
          artists: item.track.artists.map((a) => a.name),
          album: item.track.album.name,
          durationMs: item.track.duration_ms,
          addedAt: item.added_at,
        });
      }

      if (!response.next) break;
      offset += MAX_TRACKS_PER_REQUEST;
    }

    return tracks;
  }

  async getPlaylistWithTracks(playlistId: string): Promise<SpotifyPlaylistWithTracks> {
    const [playlist, tracks] = await Promise.all([
      this.getPlaylist(playlistId),
      this.getPlaylistTracks(playlistId),
    ]);

    return { ...playlist, tracks };
  }

  async createPlaylist(
    userId: string,
    name: string,
    options: { description?: string; isPublic?: boolean } = {}
  ): Promise<SpotifyPlaylist> {
    const response = await this.request<{
      id: string;
      uri: string;
      name: string;
      description: string | null;
      public: boolean;
      collaborative: boolean;
      snapshot_id: string;
      owner: { id: string; display_name: string };
      tracks: { total: number };
    }>(`/users/${userId}/playlists`, {
      method: 'POST',
      body: JSON.stringify({
        name,
        description: options.description || '',
        public: options.isPublic ?? false,
      }),
    });

    return {
      id: response.id,
      uri: response.uri,
      name: response.name,
      description: response.description || '',
      isPublic: response.public,
      collaborative: response.collaborative,
      snapshotId: response.snapshot_id,
      owner: {
        id: response.owner.id,
        displayName: response.owner.display_name,
      },
      trackCount: response.tracks.total,
    };
  }

  async updatePlaylistDetails(
    playlistId: string,
    details: { name?: string; description?: string; isPublic?: boolean }
  ): Promise<void> {
    await this.request(`/playlists/${playlistId}`, {
      method: 'PUT',
      body: JSON.stringify({
        name: details.name,
        description: details.description,
        public: details.isPublic,
      }),
    });
  }

  async addTracksToPlaylist(
    playlistId: string,
    trackUris: string[],
    position?: number
  ): Promise<string> {
    // Spotify limits to 100 tracks per request
    const chunks = chunkArray(trackUris, MAX_TRACKS_TO_ADD);
    let snapshotId = '';
    let currentPosition = position;

    for (const chunk of chunks) {
      const body: { uris: string[]; position?: number } = { uris: chunk };
      if (currentPosition !== undefined) {
        body.position = currentPosition;
        currentPosition += chunk.length;
      }

      const response = await this.request<{ snapshot_id: string }>(
        `/playlists/${playlistId}/tracks`,
        {
          method: 'POST',
          body: JSON.stringify(body),
        }
      );
      snapshotId = response.snapshot_id;
    }

    return snapshotId;
  }

  async removeTracksFromPlaylist(playlistId: string, trackUris: string[]): Promise<string> {
    const chunks = chunkArray(trackUris, MAX_TRACKS_TO_REMOVE);
    let snapshotId = '';

    for (const chunk of chunks) {
      const response = await this.request<{ snapshot_id: string }>(
        `/playlists/${playlistId}/tracks`,
        {
          method: 'DELETE',
          body: JSON.stringify({
            tracks: chunk.map((uri) => ({ uri })),
          }),
        }
      );
      snapshotId = response.snapshot_id;
    }

    return snapshotId;
  }

  async replacePlaylistTracks(playlistId: string, trackUris: string[]): Promise<string> {
    // First, clear the playlist with empty array
    await this.request<{ snapshot_id: string }>(`/playlists/${playlistId}/tracks`, {
      method: 'PUT',
      body: JSON.stringify({ uris: [] }),
    });

    // Then add all tracks
    if (trackUris.length === 0) {
      const playlist = await this.getPlaylist(playlistId);
      return playlist.snapshotId;
    }

    return this.addTracksToPlaylist(playlistId, trackUris, 0);
  }

  async reorderPlaylistTracks(
    playlistId: string,
    rangeStart: number,
    insertBefore: number,
    rangeLength = 1
  ): Promise<string> {
    const response = await this.request<{ snapshot_id: string }>(
      `/playlists/${playlistId}/tracks`,
      {
        method: 'PUT',
        body: JSON.stringify({
          range_start: rangeStart,
          insert_before: insertBefore,
          range_length: rangeLength,
        }),
      }
    );
    return response.snapshot_id;
  }

  // User's saved tracks (library)
  async getSavedTracks(limit = 50, offset = 0): Promise<SpotifyPaginated<SpotifyTrack>> {
    const response = await this.request<{
      items: Array<{
        added_at: string;
        track: {
          id: string;
          uri: string;
          name: string;
          artists: Array<{ name: string }>;
          album: { name: string };
          duration_ms: number;
        };
      }>;
      total: number;
      limit: number;
      offset: number;
      next: string | null;
      previous: string | null;
    }>(`/me/tracks?limit=${limit}&offset=${offset}`);

    return {
      items: response.items.map((item) => ({
        id: item.track.id,
        uri: item.track.uri,
        name: item.track.name,
        artists: item.track.artists.map((a) => a.name),
        album: item.track.album.name,
        durationMs: item.track.duration_ms,
        addedAt: item.added_at,
      })),
      total: response.total,
      limit: response.limit,
      offset: response.offset,
      next: response.next,
      previous: response.previous,
    };
  }

  async getAllSavedTracks(maxTracks = 5000): Promise<SpotifyTrack[]> {
    const tracks: SpotifyTrack[] = [];
    let offset = 0;
    const limit = 50;

    while (tracks.length < maxTracks) {
      const page = await this.getSavedTracks(limit, offset);
      tracks.push(...page.items);

      if (!page.next || page.items.length === 0) {
        break;
      }
      offset += limit;
    }

    return tracks.slice(0, maxTracks);
  }

  // Search
  async searchTracks(
    query: string,
    limit = 50,
    offset = 0
  ): Promise<SpotifyPaginated<SpotifyTrack>> {
    const response = await this.request<{
      tracks: {
        items: Array<{
          id: string;
          uri: string;
          name: string;
          artists: Array<{ name: string }>;
          album: { name: string };
          duration_ms: number;
        }>;
        total: number;
        limit: number;
        offset: number;
        next: string | null;
        previous: string | null;
      };
    }>(`/search?q=${encodeURIComponent(query)}&type=track&limit=${limit}&offset=${offset}`);

    return {
      items: response.tracks.items.map((track) => ({
        id: track.id,
        uri: track.uri,
        name: track.name,
        artists: track.artists.map((a) => a.name),
        album: track.album.name,
        durationMs: track.duration_ms,
      })),
      total: response.tracks.total,
      limit: response.tracks.limit,
      offset: response.tracks.offset,
      next: response.tracks.next,
      previous: response.tracks.previous,
    };
  }

  async getTrack(trackId: string): Promise<SpotifyTrack> {
    const response = await this.request<{
      id: string;
      uri: string;
      name: string;
      artists: Array<{ name: string }>;
      album: { name: string };
      duration_ms: number;
    }>(`/tracks/${trackId}`);

    return {
      id: response.id,
      uri: response.uri,
      name: response.name,
      artists: response.artists.map((a) => a.name),
      album: response.album.name,
      durationMs: response.duration_ms,
    };
  }

  async getTracks(trackIds: string[]): Promise<SpotifyTrack[]> {
    if (trackIds.length === 0) return [];

    // Spotify limits to 50 tracks per request
    const chunks = chunkArray(trackIds, 50);
    const tracks: SpotifyTrack[] = [];

    for (const chunk of chunks) {
      const response = await this.request<{
        tracks: Array<{
          id: string;
          uri: string;
          name: string;
          artists: Array<{ name: string }>;
          album: { name: string };
          duration_ms: number;
        } | null>;
      }>(`/tracks?ids=${chunk.join(',')}`);

      for (const track of response.tracks) {
        if (track) {
          tracks.push({
            id: track.id,
            uri: track.uri,
            name: track.name,
            artists: track.artists.map((a) => a.name),
            album: track.album.name,
            durationMs: track.duration_ms,
          });
        }
      }
    }

    return tracks;
  }

  // Audio features (for genre-based filtering)
  async getTracksAudioFeatures(
    trackIds: string[]
  ): Promise<Map<string, { energy: number; danceability: number; valence: number }>> {
    if (trackIds.length === 0) return new Map();

    const chunks = chunkArray(trackIds, 100);
    const features = new Map<string, { energy: number; danceability: number; valence: number }>();

    for (const chunk of chunks) {
      const response = await this.request<{
        audio_features: Array<{
          id: string;
          energy: number;
          danceability: number;
          valence: number;
        } | null>;
      }>(`/audio-features?ids=${chunk.join(',')}`);

      for (const feature of response.audio_features) {
        if (feature) {
          features.set(feature.id, {
            energy: feature.energy,
            danceability: feature.danceability,
            valence: feature.valence,
          });
        }
      }
    }

    return features;
  }
}
