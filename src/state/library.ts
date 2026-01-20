import initSqlJs, { Database as SqlJsDatabase } from 'sql.js';
import { join } from 'path';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import type { SpotifyTrack, SpotifyPlaylist, SpotifyPlaylistWithTracks } from '../types/index.js';

const LIBRARY_SCHEMA_VERSION = 2;

let SQL: Awaited<ReturnType<typeof initSqlJs>> | null = null;

async function getSql(): Promise<typeof SQL> {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

export interface DbPlaylist {
  id: string;
  name: string;
  description: string;
  is_public: boolean;
  collaborative: boolean;
  snapshot_id: string;
  owner_id: string;
  owner_name: string;
  track_count: number;
  last_synced_at: string;
}

export interface DbTrack {
  id: string;
  name: string;
  artists: string; // JSON array
  album: string;
  duration_ms: number;
  uri: string;
}

export interface DbPlaylistTrack {
  playlist_id: string;
  track_id: string;
  position: number;
  added_at: string | null;
}

export class LibraryDatabase {
  private db!: SqlJsDatabase;
  private dbPath: string;
  private initialized = false;

  constructor(workspacePath: string) {
    const spotifyfsDir = join(workspacePath, '.spotifyfs');
    if (!existsSync(spotifyfsDir)) {
      mkdirSync(spotifyfsDir, { recursive: true });
    }
    this.dbPath = join(spotifyfsDir, 'library.db');
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

    // Initial schema creation
    if (version < 1) {
      this.db.run(`
        -- Schema version tracking
        CREATE TABLE IF NOT EXISTS schema_info (
          key TEXT PRIMARY KEY,
          value TEXT
        );

        -- Playlists table
        CREATE TABLE IF NOT EXISTS playlists (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          description TEXT DEFAULT '',
          is_public INTEGER DEFAULT 0,
          collaborative INTEGER DEFAULT 0,
          snapshot_id TEXT,
          owner_id TEXT,
          owner_name TEXT,
          track_count INTEGER DEFAULT 0,
          last_synced_at TEXT
        );

        -- Tracks table (cached metadata)
        CREATE TABLE IF NOT EXISTS tracks (
          id TEXT PRIMARY KEY,
          name TEXT NOT NULL,
          artists TEXT NOT NULL,
          album TEXT,
          duration_ms INTEGER,
          uri TEXT NOT NULL
        );

        -- Indexes for common queries
        CREATE INDEX IF NOT EXISTS idx_tracks_artists ON tracks(artists);
        CREATE INDEX IF NOT EXISTS idx_tracks_name ON tracks(name);
      `);
    }

    // Migration v2: Allow duplicate tracks in playlists
    // Primary key is now (playlist_id, position) instead of (playlist_id, track_id)
    if (version < 2) {
      // Drop old table if it exists and recreate with new schema
      this.db.run(`DROP TABLE IF EXISTS playlist_tracks`);
      this.db.run(`
        CREATE TABLE playlist_tracks (
          playlist_id TEXT NOT NULL,
          track_id TEXT NOT NULL,
          position INTEGER NOT NULL,
          added_at TEXT,
          PRIMARY KEY (playlist_id, position),
          FOREIGN KEY (playlist_id) REFERENCES playlists(id) ON DELETE CASCADE,
          FOREIGN KEY (track_id) REFERENCES tracks(id) ON DELETE CASCADE
        )
      `);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_playlist ON playlist_tracks(playlist_id)`);
      this.db.run(`CREATE INDEX IF NOT EXISTS idx_playlist_tracks_track ON playlist_tracks(track_id)`);
    }

    this.setSchemaVersion(LIBRARY_SCHEMA_VERSION);
    this.save();
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

  // ==================== Playlist Operations ====================

  upsertPlaylist(playlist: SpotifyPlaylist): void {
    this.db.run(`
      INSERT OR REPLACE INTO playlists
      (id, name, description, is_public, collaborative, snapshot_id, owner_id, owner_name, track_count, last_synced_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `, [
      playlist.id,
      playlist.name,
      playlist.description,
      playlist.isPublic ? 1 : 0,
      playlist.collaborative ? 1 : 0,
      playlist.snapshotId,
      playlist.owner.id,
      playlist.owner.displayName,
      playlist.trackCount,
      new Date().toISOString()
    ]);
    this.save();
  }

  getPlaylist(id: string): DbPlaylist | null {
    const result = this.db.exec('SELECT * FROM playlists WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: String(row[0]),
      name: String(row[1]),
      description: String(row[2] || ''),
      is_public: row[3] === 1,
      collaborative: row[4] === 1,
      snapshot_id: String(row[5] || ''),
      owner_id: String(row[6] || ''),
      owner_name: String(row[7] || ''),
      track_count: Number(row[8] || 0),
      last_synced_at: String(row[9] || ''),
    };
  }

  getAllPlaylists(): DbPlaylist[] {
    const result = this.db.exec('SELECT * FROM playlists ORDER BY name');
    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      description: String(row[2] || ''),
      is_public: row[3] === 1,
      collaborative: row[4] === 1,
      snapshot_id: String(row[5] || ''),
      owner_id: String(row[6] || ''),
      owner_name: String(row[7] || ''),
      track_count: Number(row[8] || 0),
      last_synced_at: String(row[9] || ''),
    }));
  }

  deletePlaylist(id: string): void {
    this.db.run('DELETE FROM playlists WHERE id = ?', [id]);
    this.save();
  }

  renamePlaylist(id: string, newName: string): void {
    this.db.run('UPDATE playlists SET name = ? WHERE id = ?', [newName, id]);
    this.save();
  }

  // ==================== Track Operations ====================

  upsertTrack(track: SpotifyTrack): void {
    this.db.run(`
      INSERT OR REPLACE INTO tracks (id, name, artists, album, duration_ms, uri)
      VALUES (?, ?, ?, ?, ?, ?)
    `, [
      track.id,
      track.name,
      JSON.stringify(track.artists),
      track.album,
      track.durationMs,
      track.uri
    ]);
    this.save();
  }

  upsertTracks(tracks: SpotifyTrack[]): void {
    for (const track of tracks) {
      this.db.run(`
        INSERT OR REPLACE INTO tracks (id, name, artists, album, duration_ms, uri)
        VALUES (?, ?, ?, ?, ?, ?)
      `, [
        track.id,
        track.name,
        JSON.stringify(track.artists),
        track.album,
        track.durationMs,
        track.uri
      ]);
    }
    this.save();
  }

  getTrack(id: string): DbTrack | null {
    const result = this.db.exec('SELECT * FROM tracks WHERE id = ?', [id]);
    if (result.length === 0 || result[0].values.length === 0) return null;

    const row = result[0].values[0];
    return {
      id: String(row[0]),
      name: String(row[1]),
      artists: String(row[2]),
      album: String(row[3] || ''),
      duration_ms: Number(row[4] || 0),
      uri: String(row[5]),
    };
  }

  searchTracks(query: string): DbTrack[] {
    const pattern = `%${query}%`;
    const result = this.db.exec(`
      SELECT * FROM tracks
      WHERE name LIKE ? OR artists LIKE ? OR album LIKE ?
      LIMIT 100
    `, [pattern, pattern, pattern]);

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      artists: String(row[2]),
      album: String(row[3] || ''),
      duration_ms: Number(row[4] || 0),
      uri: String(row[5]),
    }));
  }

  // ==================== Playlist-Track Operations ====================

  setPlaylistTracks(playlistId: string, tracks: SpotifyTrack[]): void {
    // First, ensure all tracks exist in tracks table
    this.upsertTracks(tracks);

    // Clear existing playlist tracks
    this.db.run('DELETE FROM playlist_tracks WHERE playlist_id = ?', [playlistId]);

    // Insert new playlist tracks
    for (let i = 0; i < tracks.length; i++) {
      this.db.run(`
        INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
        VALUES (?, ?, ?, ?)
      `, [playlistId, tracks[i].id, i + 1, tracks[i].addedAt || null]);
    }

    // Update track count
    this.db.run('UPDATE playlists SET track_count = ? WHERE id = ?', [tracks.length, playlistId]);
    this.save();
  }

  getPlaylistTracks(playlistId: string): Array<DbTrack & { position: number; added_at: string | null }> {
    const result = this.db.exec(`
      SELECT t.*, pt.position, pt.added_at
      FROM tracks t
      JOIN playlist_tracks pt ON t.id = pt.track_id
      WHERE pt.playlist_id = ?
      ORDER BY pt.position
    `, [playlistId]);

    if (result.length === 0) return [];

    return result[0].values.map((row) => ({
      id: String(row[0]),
      name: String(row[1]),
      artists: String(row[2]),
      album: String(row[3] || ''),
      duration_ms: Number(row[4] || 0),
      uri: String(row[5]),
      position: Number(row[6]),
      added_at: row[7] ? String(row[7]) : null,
    }));
  }

  getPlaylistTrackIds(playlistId: string): string[] {
    const result = this.db.exec(`
      SELECT track_id FROM playlist_tracks
      WHERE playlist_id = ?
      ORDER BY position
    `, [playlistId]);

    if (result.length === 0) return [];
    return result[0].values.map(r => String(r[0]));
  }

  addTrackToPlaylist(playlistId: string, trackId: string, position?: number): void {
    // Get current track count to determine position
    const result = this.db.exec(`
      SELECT COUNT(*) FROM playlist_tracks WHERE playlist_id = ?
    `, [playlistId]);
    const currentCount = result.length > 0 ? Number(result[0].values[0][0]) : 0;

    const newPosition = position ?? currentCount + 1;

    // Shift positions if inserting in middle
    if (position && position <= currentCount) {
      this.db.run(`
        UPDATE playlist_tracks
        SET position = position + 1
        WHERE playlist_id = ? AND position >= ?
      `, [playlistId, position]);
    }

    this.db.run(`
      INSERT INTO playlist_tracks (playlist_id, track_id, position, added_at)
      VALUES (?, ?, ?, ?)
    `, [playlistId, trackId, newPosition, new Date().toISOString()]);

    this.db.run('UPDATE playlists SET track_count = track_count + 1 WHERE id = ?', [playlistId]);
    this.save();
  }

  removeTrackFromPlaylist(playlistId: string, trackId: string): void {
    const result = this.db.exec(`
      SELECT position FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?
    `, [playlistId, trackId]);

    if (result.length === 0 || result[0].values.length === 0) return;

    const trackPosition = Number(result[0].values[0][0]);

    this.db.run('DELETE FROM playlist_tracks WHERE playlist_id = ? AND track_id = ?', [playlistId, trackId]);

    // Reorder remaining tracks
    this.db.run(`
      UPDATE playlist_tracks
      SET position = position - 1
      WHERE playlist_id = ? AND position > ?
    `, [playlistId, trackPosition]);

    this.db.run('UPDATE playlists SET track_count = track_count - 1 WHERE id = ?', [playlistId]);
    this.save();
  }

  reorderPlaylistTracks(playlistId: string, trackIds: string[]): void {
    for (let i = 0; i < trackIds.length; i++) {
      this.db.run(`
        UPDATE playlist_tracks SET position = ? WHERE playlist_id = ? AND track_id = ?
      `, [i + 1, playlistId, trackIds[i]]);
    }
    this.save();
  }

  // ==================== Query Operations (for LLM) ====================

  /**
   * Execute a read-only SQL query (SELECT only)
   */
  query(sql: string): unknown[] {
    // Safety: only allow SELECT statements
    const trimmed = sql.trim().toUpperCase();
    if (!trimmed.startsWith('SELECT')) {
      throw new Error('Only SELECT queries are allowed in query(). Use execute() for modifications.');
    }
    const result = this.db.exec(sql);
    if (result.length === 0) return [];

    // Convert to array of objects
    const columns = result[0].columns;
    return result[0].values.map(row => {
      const obj: Record<string, unknown> = {};
      columns.forEach((col, i) => {
        obj[col] = row[i];
      });
      return obj;
    });
  }

  /**
   * Execute a modifying SQL statement (INSERT, UPDATE, DELETE)
   * Returns the number of affected rows
   */
  execute(sql: string): { changes: number; lastInsertRowid: number | bigint } {
    const trimmed = sql.trim().toUpperCase();
    const allowed = ['INSERT', 'UPDATE', 'DELETE'];
    const isAllowed = allowed.some(cmd => trimmed.startsWith(cmd));

    if (!isAllowed) {
      throw new Error('Only INSERT, UPDATE, DELETE statements are allowed in execute().');
    }

    // Prevent dangerous operations
    if (trimmed.includes('DROP') || trimmed.includes('ALTER') || trimmed.includes('TRUNCATE')) {
      throw new Error('DROP, ALTER, and TRUNCATE operations are not allowed.');
    }

    this.db.run(sql);
    this.save();

    const changesResult = this.db.exec('SELECT changes()');
    const rowidResult = this.db.exec('SELECT last_insert_rowid()');

    return {
      changes: Number(changesResult[0]?.values[0]?.[0] || 0),
      lastInsertRowid: Number(rowidResult[0]?.values[0]?.[0] || 0),
    };
  }

  /**
   * Get database schema for LLM context
   */
  getSchema(): string {
    return `
DATABASE SCHEMA:

TABLE playlists:
  - id TEXT PRIMARY KEY (Spotify playlist ID)
  - name TEXT (playlist name)
  - description TEXT
  - is_public INTEGER (0 or 1)
  - collaborative INTEGER (0 or 1)
  - snapshot_id TEXT (Spotify version identifier)
  - owner_id TEXT
  - owner_name TEXT
  - track_count INTEGER
  - last_synced_at TEXT (ISO timestamp)

TABLE tracks:
  - id TEXT PRIMARY KEY (Spotify track ID)
  - name TEXT (track name)
  - artists TEXT (JSON array of artist names, e.g., '["Artist1", "Artist2"]')
  - album TEXT
  - duration_ms INTEGER
  - uri TEXT (Spotify URI)

TABLE playlist_tracks:
  - playlist_id TEXT (references playlists.id)
  - track_id TEXT (references tracks.id)
  - position INTEGER (1-indexed position in playlist)
  - added_at TEXT (ISO timestamp)
  - PRIMARY KEY (playlist_id, position)
  - NOTE: Same track can appear multiple times in a playlist (duplicates allowed)

USEFUL QUERIES:
- Get all tracks in a playlist: SELECT t.* FROM tracks t JOIN playlist_tracks pt ON t.id = pt.track_id WHERE pt.playlist_id = '...' ORDER BY pt.position
- Find duplicates across playlists: SELECT track_id, COUNT(*) as count FROM playlist_tracks GROUP BY track_id HAVING count > 1
- Search tracks by artist: SELECT * FROM tracks WHERE artists LIKE '%Artist Name%'
- Get playlist with track count: SELECT p.*, COUNT(pt.track_id) as actual_count FROM playlists p LEFT JOIN playlist_tracks pt ON p.id = pt.playlist_id GROUP BY p.id
`;
  }

  // ==================== Utility ====================

  /**
   * Import a full playlist with tracks from Spotify
   */
  importPlaylist(playlist: SpotifyPlaylistWithTracks): void {
    this.upsertPlaylist(playlist);
    this.setPlaylistTracks(playlist.id, playlist.tracks);
  }

  /**
   * Create a new playlist locally (before syncing to Spotify)
   */
  createLocalPlaylist(id: string, name: string, description = ''): void {
    this.db.run(`
      INSERT INTO playlists (id, name, description, is_public, collaborative, track_count, last_synced_at)
      VALUES (?, ?, ?, 0, 0, 0, ?)
    `, [id, name, description, new Date().toISOString()]);
    this.save();
  }

  /**
   * Get summary statistics
   */
  getStats(): { playlists: number; tracks: number; totalPlaylistTracks: number } {
    const playlistsResult = this.db.exec('SELECT COUNT(*) as count FROM playlists');
    const tracksResult = this.db.exec('SELECT COUNT(*) as count FROM tracks');
    const totalPlaylistTracksResult = this.db.exec('SELECT COUNT(*) as count FROM playlist_tracks');

    return {
      playlists: Number(playlistsResult[0]?.values[0]?.[0] || 0),
      tracks: Number(tracksResult[0]?.values[0]?.[0] || 0),
      totalPlaylistTracks: Number(totalPlaylistTracksResult[0]?.values[0]?.[0] || 0),
    };
  }

  close(): void {
    this.db.close();
  }
}
