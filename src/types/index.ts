// Core types for SpotifyFS

export interface SpotifyTrack {
  id: string;
  uri: string;
  name: string;
  artists: string[];
  album: string;
  durationMs: number;
  addedAt?: string;
}

export interface SpotifyPlaylist {
  id: string;
  uri: string;
  name: string;
  description: string;
  isPublic: boolean;
  collaborative: boolean;
  snapshotId: string;
  owner: {
    id: string;
    displayName: string;
  };
  trackCount: number;
}

export interface SpotifyPlaylistWithTracks extends SpotifyPlaylist {
  tracks: SpotifyTrack[];
}

export interface LocalTrackRef {
  trackId: string;
  uri: string;
  displayName: string; // "Artist - Track"
  position: number;
  filePath: string;
}

export interface LocalPlaylist {
  playlistId: string;
  name: string;
  folderPath: string;
  tracks: LocalTrackRef[];
  metadata: PlaylistMetadata;
}

export interface PlaylistMetadata {
  id: string;
  uri: string;
  name: string;
  description: string;
  isPublic: boolean;
  collaborative: boolean;
  snapshotId: string;
  owner: {
    id: string;
    displayName: string;
  };
  lastSyncedAt?: string;
}

export interface WorkspaceConfig {
  version: string;
  spotifyUserId?: string;
  workspacePath: string;
  createdAt: string;
  lastSyncAt?: string;
  settings: WorkspaceSettings;
}

export interface WorkspaceSettings {
  pullInterval?: number; // milliseconds between remote polls
  autoCommit: boolean;
  orderingMode: 'prefix' | 'orderfile';
  syncLibrary: boolean; // whether to sync liked tracks
  conflictPolicy: 'prompt' | 'take-local' | 'take-remote';
}

export interface TokenData {
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  scope: string;
}

// Sync-related types
export interface SyncState {
  playlistId: string;
  localPath: string;
  lastRemoteSnapshotId: string;
  lastLocalHash: string;
  lastSyncedAt: string;
}

export interface PlaylistDiff {
  playlistId: string;
  playlistName: string;
  additions: string[]; // track IDs to add
  removals: string[]; // track IDs to remove
  reorderNeeded: boolean;
  newOrder?: string[]; // full ordered list if reorder needed
  localOrder: string[];
  remoteOrder: string[];
  hasConflict: boolean;
  conflictDetails?: ConflictDetails;
}

export interface ConflictDetails {
  localChanges: string[];
  remoteChanges: string[];
  commonBase?: string[];
  addedLocally: string[];
  addedRemotely: string[];
  removedLocally: string[];
  removedRemotely: string[];
}

export type SyncOperation =
  | { type: 'create_playlist'; name: string; trackIds: string[] }
  | { type: 'delete_playlist'; playlistId: string }
  | { type: 'rename_playlist'; playlistId: string; newName: string }
  | { type: 'add_tracks'; playlistId: string; trackIds: string[]; position?: number }
  | { type: 'remove_tracks'; playlistId: string; trackIds: string[] }
  | { type: 'reorder_tracks'; playlistId: string; newOrder: string[] }
  | { type: 'replace_tracks'; playlistId: string; trackIds: string[] };

export interface SyncPlan {
  operations: SyncOperation[];
  conflicts: PlaylistDiff[];
  createdAt: string;
}

export interface SyncResult {
  success: boolean;
  appliedOperations: SyncOperation[];
  failedOperations: Array<{ operation: SyncOperation; error: string }>;
  conflicts: PlaylistDiff[];
  timestamp: string;
}

// Domain events
export type DomainEvent =
  | { type: 'PlaylistCreated'; folderPath: string; name: string }
  | { type: 'PlaylistRenamed'; playlistId: string; oldName: string; newName: string }
  | { type: 'PlaylistDeleted'; playlistId: string; folderPath: string }
  | { type: 'TrackAdded'; playlistId: string; trackId: string; position: number }
  | { type: 'TrackRemoved'; playlistId: string; trackId: string }
  | { type: 'TrackReordered'; playlistId: string; trackId: string; oldPosition: number; newPosition: number }
  | { type: 'PlaylistMetadataChanged'; playlistId: string; changes: Partial<PlaylistMetadata> };

// Git-related types
export interface GitBranch {
  name: string;
  isCurrent: boolean;
  isRemote: boolean;
  lastCommit?: string;
}

export interface GitCommit {
  hash: string;
  message: string;
  author: string;
  date: string;
}

export interface ProposalMetadata {
  id: string;
  userPrompt: string;
  branchName: string;
  createdAt: string;
  summary: string;
  changes: {
    playlistsCreated: number;
    playlistsModified: number;
    tracksAdded: number;
    tracksRemoved: number;
  };
  assumptions: string[];
  status: 'pending' | 'applied' | 'rejected';
}

// Chatbot types
export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
}

export interface ChatbotPlan {
  intent: string;
  steps: PlanStep[];
  estimatedChanges: {
    playlistsCreated: number;
    playlistsModified: number;
    tracksAdded: number;
    tracksRemoved: number;
  };
}

export type PlanStep =
  // Spotify API operations
  | { type: 'search_tracks'; query: string; limit: number }
  | { type: 'list_playlists' }
  | { type: 'fetch_playlist_tracks'; playlistId: string }
  | { type: 'fetch_saved_tracks'; limit: number }
  | { type: 'filter_tracks'; criteria: FilterCriteria }
  // SQL operations (local database)
  | { type: 'sql_query'; query: string; description: string }
  | { type: 'sql_execute'; query: string; description: string }
  // Playlist operations
  | { type: 'create_playlist'; name: string; description?: string }
  | { type: 'delete_playlist'; playlistId: string }
  | { type: 'rename_playlist'; playlistId: string; newName: string }
  // Track operations
  | { type: 'add_tracks_to_playlist'; playlistId: string; trackIds: string[] }
  | { type: 'remove_tracks_from_playlist'; playlistId: string; trackIds: string[] }
  | { type: 'move_tracks'; fromPlaylistId: string; toPlaylistId: string; trackIds: string[] }
  | { type: 'reorder_tracks'; playlistId: string; trackIds: string[] }
  // Git operations
  | { type: 'create_branch'; name: string }
  | { type: 'commit_changes'; message: string }
  // Sync operations
  | { type: 'sync_to_spotify' }
  | { type: 'generate_markdown' };

export interface FilterCriteria {
  genres?: string[];
  artists?: string[];
  keywords?: string[];
  yearRange?: { start: number; end: number };
  energyRange?: { min: number; max: number };
}

// API response types
export interface SpotifyPaginated<T> {
  items: T[];
  total: number;
  limit: number;
  offset: number;
  next: string | null;
  previous: string | null;
}

export interface SpotifyError {
  status: number;
  message: string;
}

// Database schema types
export interface DbPlaylistMapping {
  playlistId: string;
  localPath: string;
  snapshotId: string;
  lastSyncedAt: string;
  trackHash: string;
}

export interface DbSyncLog {
  id: number;
  timestamp: string;
  operationType: string;
  playlistId: string | null;
  details: string;
  success: boolean;
  errorMessage: string | null;
}

export interface DbProposal {
  id: string;
  branchName: string;
  userPrompt: string;
  metadata: string; // JSON
  createdAt: string;
  status: string;
}
