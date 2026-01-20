import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type {
  DbPlaylistMapping,
  DbSyncLog,
  DbProposal,
} from '../types/index.js';

const SCHEMA_VERSION = 1;

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<typeof SQL> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export class StateStore {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private initialized = false;

  constructor(workspacePath: string) {
    const spotifyfsDir = join(workspacePath, '.spotifyfs');
    if (!existsSync(spotifyfsDir)) {
      mkdirSync(spotifyfsDir, { recursive: true });
    }
    this.dbPath = join(spotifyfsDir, 'state.db');
  }

  async init(): Promise<void> {
    if (this.initialized) return;

    const sql = await getSql();
    if (!sql) throw new Error('Failed to initialize SQL.js');

    // Load existing database or create new one
    if (existsSync(this.dbPath)) {
      const buffer = readFileSync(this.dbPath);
      this.db = new sql.Database(buffer);
    } else {
      this.db = new sql.Database();
    }

    this.initializeSchema();
    this.initialized = true;
  }

  private save(): void {
    const data = this.db.export();
    const buffer = Buffer.from(data);
    writeFileSync(this.dbPath, buffer);
  }

  private initializeSchema(): void {
    const version = this.getSchemaVersion();

    if (version < SCHEMA_VERSION) {
      this.db.run(`
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
      this.save();
    }
  }

  private getSchemaVersion(): number {
    try {
      const result = this.db.exec("SELECT value FROM schema_info WHERE key = 'version'");
      if (result.length > 0 && result[0].values.length > 0) {
        return parseInt(String(result[0].values[0][0]), 10);
      }
      return 0;
    } catch {
      return 0;
    }
  }

  private setSchemaVersion(version: number): void {
    this.db.run(
      "INSERT OR REPLACE INTO schema_info (key, value) VALUES ('version', ?)",
      [String(version)]
    );
  }

  // Playlist mappings
  getPlaylistMapping(playlistId: string): DbPlaylistMapping | null {
    const result = this.db.exec(
      'SELECT * FROM playlist_mappings WHERE playlist_id = ?',
      [playlistId]
    );

    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      playlistId: String(row[0]),
      localPath: String(row[1]),
      snapshotId: String(row[2]),
      lastSyncedAt: String(row[3]),
      trackHash: String(row[4]),
    };
  }

  getPlaylistMappingByPath(localPath: string): DbPlaylistMapping | null {
    const result = this.db.exec(
      'SELECT * FROM playlist_mappings WHERE local_path = ?',
      [localPath]
    );

    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      playlistId: String(row[0]),
      localPath: String(row[1]),
      snapshotId: String(row[2]),
      lastSyncedAt: String(row[3]),
      trackHash: String(row[4]),
    };
  }

  getAllPlaylistMappings(): DbPlaylistMapping[] {
    const result = this.db.exec('SELECT * FROM playlist_mappings');

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      playlistId: String(row[0]),
      localPath: String(row[1]),
      snapshotId: String(row[2]),
      lastSyncedAt: String(row[3]),
      trackHash: String(row[4]),
    }));
  }

  upsertPlaylistMapping(mapping: DbPlaylistMapping): void {
    this.db.run(
      `INSERT OR REPLACE INTO playlist_mappings
       (playlist_id, local_path, snapshot_id, last_synced_at, track_hash)
       VALUES (?, ?, ?, ?, ?)`,
      [
        mapping.playlistId,
        mapping.localPath,
        mapping.snapshotId,
        mapping.lastSyncedAt,
        mapping.trackHash,
      ]
    );
    this.save();
  }

  deletePlaylistMapping(playlistId: string): void {
    this.db.run('DELETE FROM playlist_mappings WHERE playlist_id = ?', [playlistId]);
    this.save();
  }

  // Sync log
  logSyncOperation(
    operationType: string,
    playlistId: string | null,
    details: string,
    success: boolean,
    errorMessage?: string
  ): number {
    this.db.run(
      `INSERT INTO sync_log (timestamp, operation_type, playlist_id, details, success, error_message)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        new Date().toISOString(),
        operationType,
        playlistId,
        details,
        success ? 1 : 0,
        errorMessage || null,
      ]
    );
    this.save();

    // Get last insert rowid
    const result = this.db.exec('SELECT last_insert_rowid()');
    return Number(result[0].values[0][0]);
  }

  getRecentSyncLogs(limit = 100): DbSyncLog[] {
    const result = this.db.exec(
      'SELECT * FROM sync_log ORDER BY timestamp DESC LIMIT ?',
      [limit]
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: Number(row[0]),
      timestamp: String(row[1]),
      operationType: String(row[2]),
      playlistId: row[3] ? String(row[3]) : null,
      details: String(row[4]),
      success: row[5] === 1,
      errorMessage: row[6] ? String(row[6]) : null,
    }));
  }

  // Proposals
  saveProposal(proposal: DbProposal): void {
    this.db.run(
      `INSERT INTO proposals (id, branch_name, user_prompt, metadata, created_at, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        proposal.id,
        proposal.branchName,
        proposal.userPrompt,
        proposal.metadata,
        proposal.createdAt,
        proposal.status,
      ]
    );
    this.save();
  }

  getProposal(id: string): DbProposal | null {
    const result = this.db.exec('SELECT * FROM proposals WHERE id = ?', [id]);

    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: String(row[0]),
      branchName: String(row[1]),
      userPrompt: String(row[2]),
      metadata: String(row[3]),
      createdAt: String(row[4]),
      status: String(row[5]),
    };
  }

  getProposalByBranch(branchName: string): DbProposal | null {
    const result = this.db.exec('SELECT * FROM proposals WHERE branch_name = ?', [branchName]);

    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: String(row[0]),
      branchName: String(row[1]),
      userPrompt: String(row[2]),
      metadata: String(row[3]),
      createdAt: String(row[4]),
      status: String(row[5]),
    };
  }

  getPendingProposals(): DbProposal[] {
    const result = this.db.exec(
      "SELECT * FROM proposals WHERE status = 'pending' ORDER BY created_at DESC"
    );

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: String(row[0]),
      branchName: String(row[1]),
      userPrompt: String(row[2]),
      metadata: String(row[3]),
      createdAt: String(row[4]),
      status: String(row[5]),
    }));
  }

  updateProposalStatus(id: string, status: string): void {
    this.db.run('UPDATE proposals SET status = ? WHERE id = ?', [status, id]);
    this.save();
  }

  // Tombstones
  addTombstone(entityType: string, entityId: string): void {
    this.db.run(
      `INSERT OR REPLACE INTO tombstones (entity_type, entity_id, deleted_at)
       VALUES (?, ?, ?)`,
      [entityType, entityId, new Date().toISOString()]
    );
    this.save();
  }

  isTombstoned(entityType: string, entityId: string): boolean {
    const result = this.db.exec(
      'SELECT 1 FROM tombstones WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    );

    return result.length > 0 && result[0].values.length > 0;
  }

  removeTombstone(entityType: string, entityId: string): void {
    this.db.run(
      'DELETE FROM tombstones WHERE entity_type = ? AND entity_id = ?',
      [entityType, entityId]
    );
    this.save();
  }

  close(): void {
    this.db.close();
  }
}
