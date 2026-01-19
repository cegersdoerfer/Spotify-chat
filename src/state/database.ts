import Database from 'better-sqlite3';
import { join } from 'path';
import type {
  DbPlaylistMapping,
  DbSyncLog,
  DbProposal,
  TokenData,
  WorkspaceConfig,
  ProposalMetadata,
} from '../types/index.js';

const SCHEMA_VERSION = 1;

export class StateStore {
  private db: Database.Database;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    const dbPath = join(workspacePath, '.spotifyfs', 'state.db');
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.initializeSchema();
  }

  private initializeSchema(): void {
    const version = this.getSchemaVersion();

    if (version < SCHEMA_VERSION) {
      this.db.exec(`
        -- Schema version tracking
        CREATE TABLE IF NOT EXISTS schema_info (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        -- Playlist mappings: local path <-> Spotify playlist
        CREATE TABLE IF NOT EXISTS playlist_mappings (
          playlist_id TEXT PRIMARY KEY,
          local_path TEXT NOT NULL UNIQUE,
          snapshot_id TEXT NOT NULL,
          last_synced_at TEXT NOT NULL,
          track_hash TEXT NOT NULL
        );

        -- Sync operation log
        CREATE TABLE IF NOT EXISTS sync_log (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          timestamp TEXT NOT NULL,
          operation_type TEXT NOT NULL,
          playlist_id TEXT,
          details TEXT NOT NULL,
          success INTEGER NOT NULL,
          error_message TEXT
        );

        -- Chatbot proposals
        CREATE TABLE IF NOT EXISTS proposals (
          id TEXT PRIMARY KEY,
          branch_name TEXT NOT NULL,
          user_prompt TEXT NOT NULL,
          metadata TEXT NOT NULL,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending'
        );

        -- Tombstones for deleted entities
        CREATE TABLE IF NOT EXISTS tombstones (
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          deleted_at TEXT NOT NULL,
          PRIMARY KEY (entity_type, entity_id)
        );

        -- Create indexes
        CREATE INDEX IF NOT EXISTS idx_sync_log_timestamp ON sync_log(timestamp);
        CREATE INDEX IF NOT EXISTS idx_sync_log_playlist ON sync_log(playlist_id);
        CREATE INDEX IF NOT EXISTS idx_proposals_status ON proposals(status);
      `);

      this.setSchemaVersion(SCHEMA_VERSION);
    }
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db
        .prepare("SELECT value FROM schema_info WHERE key = 'version'")
        .get() as { value: string } | undefined;
      return result ? parseInt(result.value, 10) : 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number): void {
    this.db
      .prepare(
        "INSERT OR REPLACE INTO schema_info (key, value) VALUES ('version', ?)"
      )
      .run(String(version));
  }

  // Playlist mappings
  getPlaylistMapping(playlistId: string): DbPlaylistMapping | null {
    const row = this.db
      .prepare('SELECT * FROM playlist_mappings WHERE playlist_id = ?')
      .get(playlistId) as {
        playlist_id: string;
        local_path: string;
        snapshot_id: string;
        last_synced_at: string;
        track_hash: string;
      } | undefined;

    if (!row) return null;

    return {
      playlistId: row.playlist_id,
      localPath: row.local_path,
      snapshotId: row.snapshot_id,
      lastSyncedAt: row.last_synced_at,
      trackHash: row.track_hash,
    };
  }

  getPlaylistMappingByPath(localPath: string): DbPlaylistMapping | null {
    const row = this.db
      .prepare('SELECT * FROM playlist_mappings WHERE local_path = ?')
      .get(localPath) as {
        playlist_id: string;
        local_path: string;
        snapshot_id: string;
        last_synced_at: string;
        track_hash: string;
      } | undefined;

    if (!row) return null;

    return {
      playlistId: row.playlist_id,
      localPath: row.local_path,
      snapshotId: row.snapshot_id,
      lastSyncedAt: row.last_synced_at,
      trackHash: row.track_hash,
    };
  }

  getAllPlaylistMappings(): DbPlaylistMapping[] {
    const rows = this.db
      .prepare('SELECT * FROM playlist_mappings')
      .all() as Array<{
        playlist_id: string;
        local_path: string;
        snapshot_id: string;
        last_synced_at: string;
        track_hash: string;
      }>;

    return rows.map((row) => ({
      playlistId: row.playlist_id,
      localPath: row.local_path,
      snapshotId: row.snapshot_id,
      lastSyncedAt: row.last_synced_at,
      trackHash: row.track_hash,
    }));
  }

  upsertPlaylistMapping(mapping: DbPlaylistMapping): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO playlist_mappings
         (playlist_id, local_path, snapshot_id, last_synced_at, track_hash)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(
        mapping.playlistId,
        mapping.localPath,
        mapping.snapshotId,
        mapping.lastSyncedAt,
        mapping.trackHash
      );
  }

  deletePlaylistMapping(playlistId: string): void {
    this.db
      .prepare('DELETE FROM playlist_mappings WHERE playlist_id = ?')
      .run(playlistId);
  }

  // Sync log
  logSyncOperation(
    operationType: string,
    playlistId: string | null,
    details: string,
    success: boolean,
    errorMessage?: string
  ): number {
    const result = this.db
      .prepare(
        `INSERT INTO sync_log (timestamp, operation_type, playlist_id, details, success, error_message)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        new Date().toISOString(),
        operationType,
        playlistId,
        details,
        success ? 1 : 0,
        errorMessage || null
      );

    return result.lastInsertRowid as number;
  }

  getRecentSyncLogs(limit = 100): DbSyncLog[] {
    const rows = this.db
      .prepare(
        'SELECT * FROM sync_log ORDER BY timestamp DESC LIMIT ?'
      )
      .all(limit) as Array<{
        id: number;
        timestamp: string;
        operation_type: string;
        playlist_id: string | null;
        details: string;
        success: number;
        error_message: string | null;
      }>;

    return rows.map((row) => ({
      id: row.id,
      timestamp: row.timestamp,
      operationType: row.operation_type,
      playlistId: row.playlist_id,
      details: row.details,
      success: row.success === 1,
      errorMessage: row.error_message,
    }));
  }

  // Proposals
  saveProposal(proposal: DbProposal): void {
    this.db
      .prepare(
        `INSERT INTO proposals (id, branch_name, user_prompt, metadata, created_at, status)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(
        proposal.id,
        proposal.branchName,
        proposal.userPrompt,
        proposal.metadata,
        proposal.createdAt,
        proposal.status
      );
  }

  getProposal(id: string): DbProposal | null {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE id = ?')
      .get(id) as {
        id: string;
        branch_name: string;
        user_prompt: string;
        metadata: string;
        created_at: string;
        status: string;
      } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      branchName: row.branch_name,
      userPrompt: row.user_prompt,
      metadata: row.metadata,
      createdAt: row.created_at,
      status: row.status,
    };
  }

  getProposalByBranch(branchName: string): DbProposal | null {
    const row = this.db
      .prepare('SELECT * FROM proposals WHERE branch_name = ?')
      .get(branchName) as {
        id: string;
        branch_name: string;
        user_prompt: string;
        metadata: string;
        created_at: string;
        status: string;
      } | undefined;

    if (!row) return null;

    return {
      id: row.id,
      branchName: row.branch_name,
      userPrompt: row.user_prompt,
      metadata: row.metadata,
      createdAt: row.created_at,
      status: row.status,
    };
  }

  getPendingProposals(): DbProposal[] {
    const rows = this.db
      .prepare("SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at DESC")
      .all() as Array<{
        id: string;
        branch_name: string;
        user_prompt: string;
        metadata: string;
        created_at: string;
        status: string;
      }>;

    return rows.map((row) => ({
      id: row.id,
      branchName: row.branch_name,
      userPrompt: row.user_prompt,
      metadata: row.metadata,
      createdAt: row.created_at,
      status: row.status,
    }));
  }

  updateProposalStatus(id: string, status: string): void {
    this.db
      .prepare('UPDATE proposals SET status = ? WHERE id = ?')
      .run(status, id);
  }

  // Tombstones
  addTombstone(entityType: string, entityId: string): void {
    this.db
      .prepare(
        `INSERT OR REPLACE INTO tombstones (entity_type, entity_id, deleted_at)
         VALUES (?, ?, ?)`
      )
      .run(entityType, entityId, new Date().toISOString());
  }

  isTombstoned(entityType: string, entityId: string): boolean {
    const row = this.db
      .prepare(
        'SELECT 1 FROM tombstones WHERE entity_type = ? AND entity_id = ?'
      )
      .get(entityType, entityId);

    return !!row;
  }

  removeTombstone(entityType: string, entityId: string): void {
    this.db
      .prepare(
        'DELETE FROM tombstones WHERE entity_type = ? AND entity_id = ?'
      )
      .run(entityType, entityId);
  }

  // Transaction support
  transaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  close(): void {
    this.db.close();
  }
}
