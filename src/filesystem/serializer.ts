import {
  writeFileSync,
  readFileSync,
  readdirSync,
  mkdirSync,
  existsSync,
  rmSync,
  renameSync,
  statSync,
} from 'fs';
import { join, basename, dirname } from 'path';
import type {
  LocalPlaylist,
  LocalTrackRef,
  PlaylistMetadata,
  SpotifyPlaylistWithTracks,
  SpotifyTrack,
} from '../types/index.js';
import {
  createPlaylistFolderName,
  createTrackFilename,
  parseTrackFilename,
  extractPlaylistIdFromFolderName,
  sanitizeFilename,
  trackIdToUri,
} from '../utils/index.js';

const PLAYLIST_METADATA_FILE = 'playlist.json';
const ORDER_FILE = 'order.json';
const TRACKS_DIR = 'tracks';

export interface SerializerOptions {
  orderingMode: 'prefix' | 'orderfile';
}

export class FilesystemSerializer {
  private workspacePath: string;
  private playlistsPath: string;
  private options: SerializerOptions;

  constructor(workspacePath: string, options: SerializerOptions) {
    this.workspacePath = workspacePath;
    this.playlistsPath = join(workspacePath, 'Playlists');
    this.options = options;
  }

  // Write a Spotify playlist to the filesystem
  writePlaylist(playlist: SpotifyPlaylistWithTracks): string {
    const folderName = createPlaylistFolderName(playlist.name, playlist.id);
    const playlistPath = join(this.playlistsPath, folderName);
    const tracksPath = join(playlistPath, TRACKS_DIR);

    // Create directories
    mkdirSync(tracksPath, { recursive: true });

    // Write playlist metadata
    const metadata: PlaylistMetadata = {
      id: playlist.id,
      uri: playlist.uri,
      name: playlist.name,
      description: playlist.description,
      isPublic: playlist.isPublic,
      collaborative: playlist.collaborative,
      snapshotId: playlist.snapshotId,
      owner: playlist.owner,
      lastSyncedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(playlistPath, PLAYLIST_METADATA_FILE),
      JSON.stringify(metadata, null, 2)
    );

    // Clear existing track files
    if (existsSync(tracksPath)) {
      const existingFiles = readdirSync(tracksPath);
      for (const file of existingFiles) {
        if (file.endsWith('.spotify')) {
          rmSync(join(tracksPath, file));
        }
      }
    }

    // Write track reference files
    if (this.options.orderingMode === 'prefix') {
      for (let i = 0; i < playlist.tracks.length; i++) {
        const track = playlist.tracks[i];
        const displayName = `${track.artists.join(', ')} - ${track.name}`;
        const filename = createTrackFilename(i + 1, displayName, track.id);
        writeFileSync(
          join(tracksPath, filename),
          `spotify:track:${track.id}\n`
        );
      }
    } else {
      // Order file mode
      const orderData = playlist.tracks.map((t) => t.id);
      writeFileSync(
        join(playlistPath, ORDER_FILE),
        JSON.stringify(orderData, null, 2)
      );

      // Write track files without position prefix
      for (const track of playlist.tracks) {
        const displayName = `${track.artists.join(', ')} - ${track.name}`;
        const safeDisplayName = sanitizeFilename(displayName);
        const filename = `${safeDisplayName}__${track.id}.spotify`;
        writeFileSync(
          join(tracksPath, filename),
          `spotify:track:${track.id}\n`
        );
      }
    }

    return playlistPath;
  }

  // Read a playlist from the filesystem
  readPlaylist(playlistPath: string): LocalPlaylist | null {
    const metadataPath = join(playlistPath, PLAYLIST_METADATA_FILE);
    if (!existsSync(metadataPath)) {
      return null;
    }

    const metadata = JSON.parse(
      readFileSync(metadataPath, 'utf-8')
    ) as PlaylistMetadata;

    const tracksPath = join(playlistPath, TRACKS_DIR);
    const tracks: LocalTrackRef[] = [];

    if (existsSync(tracksPath)) {
      const files = readdirSync(tracksPath)
        .filter((f) => f.endsWith('.spotify'))
        .sort();

      if (this.options.orderingMode === 'prefix') {
        for (const file of files) {
          const parsed = parseTrackFilename(file);
          if (parsed) {
            const content = readFileSync(join(tracksPath, file), 'utf-8').trim();
            const trackId = content.split(':').pop() || parsed.trackId;
            tracks.push({
              trackId,
              uri: trackIdToUri(trackId),
              displayName: parsed.displayName,
              position: parsed.position,
              filePath: join(tracksPath, file),
            });
          }
        }
        // Sort by position
        tracks.sort((a, b) => a.position - b.position);
      } else {
        // Order file mode
        const orderFilePath = join(playlistPath, ORDER_FILE);
        let order: string[] = [];

        if (existsSync(orderFilePath)) {
          order = JSON.parse(readFileSync(orderFilePath, 'utf-8')) as string[];
        }

        // Create a map of track ID to track info
        const trackMap = new Map<string, { displayName: string; filePath: string }>();
        for (const file of files) {
          const match = file.match(/__([a-zA-Z0-9]+)\.spotify$/);
          if (match) {
            const trackId = match[1];
            const displayName = file.replace(`__${trackId}.spotify`, '');
            trackMap.set(trackId, {
              displayName,
              filePath: join(tracksPath, file),
            });
          }
        }

        // Build tracks array based on order
        let position = 1;
        for (const trackId of order) {
          const info = trackMap.get(trackId);
          if (info) {
            tracks.push({
              trackId,
              uri: trackIdToUri(trackId),
              displayName: info.displayName,
              position,
              filePath: info.filePath,
            });
            position++;
          }
        }

        // Add any tracks not in order file
        for (const [trackId, info] of trackMap) {
          if (!order.includes(trackId)) {
            tracks.push({
              trackId,
              uri: trackIdToUri(trackId),
              displayName: info.displayName,
              position,
              filePath: info.filePath,
            });
            position++;
          }
        }
      }
    }

    return {
      playlistId: metadata.id,
      name: metadata.name,
      folderPath: playlistPath,
      tracks,
      metadata,
    };
  }

  // Read all playlists from the workspace
  readAllPlaylists(): LocalPlaylist[] {
    const playlists: LocalPlaylist[] = [];

    if (!existsSync(this.playlistsPath)) {
      return playlists;
    }

    const entries = readdirSync(this.playlistsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name.startsWith('.')) continue;

      const playlistPath = join(this.playlistsPath, entry.name);
      const playlist = this.readPlaylist(playlistPath);
      if (playlist) {
        playlists.push(playlist);
      }
    }

    return playlists;
  }

  // Delete a playlist from the filesystem
  deletePlaylist(playlistPath: string): void {
    if (existsSync(playlistPath)) {
      rmSync(playlistPath, { recursive: true, force: true });
    }
  }

  // Rename a playlist folder
  renamePlaylist(oldPath: string, newName: string, playlistId: string): string {
    const newFolderName = createPlaylistFolderName(newName, playlistId);
    const newPath = join(dirname(oldPath), newFolderName);

    if (oldPath !== newPath) {
      renameSync(oldPath, newPath);

      // Update metadata
      const metadataPath = join(newPath, PLAYLIST_METADATA_FILE);
      if (existsSync(metadataPath)) {
        const metadata = JSON.parse(
          readFileSync(metadataPath, 'utf-8')
        ) as PlaylistMetadata;
        metadata.name = newName;
        writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));
      }
    }

    return newPath;
  }

  // Add a track to a playlist
  addTrack(playlistPath: string, track: SpotifyTrack, position?: number): void {
    const tracksPath = join(playlistPath, TRACKS_DIR);
    mkdirSync(tracksPath, { recursive: true });

    if (this.options.orderingMode === 'prefix') {
      // Read existing tracks to determine position
      const files = readdirSync(tracksPath)
        .filter((f) => f.endsWith('.spotify'))
        .sort();

      const pos = position ?? files.length + 1;

      // If inserting in the middle, we need to rename subsequent files
      if (position !== undefined && position <= files.length) {
        // Rename files from the end to avoid conflicts
        for (let i = files.length - 1; i >= position - 1; i--) {
          const oldFile = files[i];
          const parsed = parseTrackFilename(oldFile);
          if (parsed) {
            const newFilename = createTrackFilename(
              parsed.position + 1,
              parsed.displayName,
              parsed.trackId
            );
            renameSync(join(tracksPath, oldFile), join(tracksPath, newFilename));
          }
        }
      }

      const displayName = `${track.artists.join(', ')} - ${track.name}`;
      const filename = createTrackFilename(pos, displayName, track.id);
      writeFileSync(
        join(tracksPath, filename),
        `spotify:track:${track.id}\n`
      );
    } else {
      // Order file mode
      const displayName = `${track.artists.join(', ')} - ${track.name}`;
      const safeDisplayName = sanitizeFilename(displayName);
      const filename = `${safeDisplayName}__${track.id}.spotify`;
      writeFileSync(
        join(tracksPath, filename),
        `spotify:track:${track.id}\n`
      );

      // Update order file
      const orderFilePath = join(playlistPath, ORDER_FILE);
      let order: string[] = [];
      if (existsSync(orderFilePath)) {
        order = JSON.parse(readFileSync(orderFilePath, 'utf-8')) as string[];
      }

      if (position !== undefined && position <= order.length) {
        order.splice(position - 1, 0, track.id);
      } else {
        order.push(track.id);
      }

      writeFileSync(orderFilePath, JSON.stringify(order, null, 2));
    }
  }

  // Remove a track from a playlist
  removeTrack(playlistPath: string, trackId: string): void {
    const tracksPath = join(playlistPath, TRACKS_DIR);
    if (!existsSync(tracksPath)) return;

    const files = readdirSync(tracksPath).filter((f) => f.endsWith('.spotify'));

    // Find and remove the track file
    for (const file of files) {
      if (file.includes(`__${trackId}.spotify`)) {
        rmSync(join(tracksPath, file));
        break;
      }
    }

    if (this.options.orderingMode === 'prefix') {
      // Renumber remaining files
      const remainingFiles = readdirSync(tracksPath)
        .filter((f) => f.endsWith('.spotify'))
        .sort();

      for (let i = 0; i < remainingFiles.length; i++) {
        const oldFile = remainingFiles[i];
        const parsed = parseTrackFilename(oldFile);
        if (parsed && parsed.position !== i + 1) {
          const newFilename = createTrackFilename(
            i + 1,
            parsed.displayName,
            parsed.trackId
          );
          renameSync(join(tracksPath, oldFile), join(tracksPath, newFilename));
        }
      }
    } else {
      // Update order file
      const orderFilePath = join(playlistPath, ORDER_FILE);
      if (existsSync(orderFilePath)) {
        let order = JSON.parse(readFileSync(orderFilePath, 'utf-8')) as string[];
        order = order.filter((id) => id !== trackId);
        writeFileSync(orderFilePath, JSON.stringify(order, null, 2));
      }
    }
  }

  // Reorder tracks in a playlist
  reorderTracks(playlistPath: string, newOrder: string[]): void {
    const tracksPath = join(playlistPath, TRACKS_DIR);
    if (!existsSync(tracksPath)) return;

    if (this.options.orderingMode === 'prefix') {
      // Read all track files
      const files = readdirSync(tracksPath).filter((f) => f.endsWith('.spotify'));
      const trackFiles = new Map<string, { displayName: string; content: string }>();

      for (const file of files) {
        const parsed = parseTrackFilename(file);
        if (parsed) {
          const content = readFileSync(join(tracksPath, file), 'utf-8');
          trackFiles.set(parsed.trackId, {
            displayName: parsed.displayName,
            content,
          });
          rmSync(join(tracksPath, file));
        }
      }

      // Rewrite files in new order
      for (let i = 0; i < newOrder.length; i++) {
        const trackId = newOrder[i];
        const info = trackFiles.get(trackId);
        if (info) {
          const filename = createTrackFilename(i + 1, info.displayName, trackId);
          writeFileSync(join(tracksPath, filename), info.content);
        }
      }
    } else {
      // Just update order file
      const orderFilePath = join(playlistPath, ORDER_FILE);
      writeFileSync(orderFilePath, JSON.stringify(newOrder, null, 2));
    }
  }

  // Create a new empty playlist folder
  createPlaylistFolder(name: string, playlistId: string): string {
    const folderName = createPlaylistFolderName(name, playlistId);
    const playlistPath = join(this.playlistsPath, folderName);
    const tracksPath = join(playlistPath, TRACKS_DIR);

    mkdirSync(tracksPath, { recursive: true });

    return playlistPath;
  }

  // Get playlist path by ID
  getPlaylistPathById(playlistId: string): string | null {
    if (!existsSync(this.playlistsPath)) return null;

    const entries = readdirSync(this.playlistsPath, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const extractedId = extractPlaylistIdFromFolderName(entry.name);
      if (extractedId === playlistId) {
        return join(this.playlistsPath, entry.name);
      }
    }

    return null;
  }

  // Check if a path is a valid playlist folder
  isPlaylistFolder(path: string): boolean {
    const metadataPath = join(path, PLAYLIST_METADATA_FILE);
    return existsSync(metadataPath);
  }

  // Get the playlists directory path
  getPlaylistsPath(): string {
    return this.playlistsPath;
  }
}
