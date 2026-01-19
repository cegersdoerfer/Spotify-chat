import { describe, it, expect } from 'vitest';
import {
  computeTrackListHash,
  sanitizeFilename,
  extractPlaylistIdFromFolderName,
  extractTrackIdFromFilename,
  createPlaylistFolderName,
  createTrackFilename,
  parseTrackFilename,
  spotifyUriToId,
  trackIdToUri,
  chunkArray,
  arrayDiff,
  orderChanged,
} from '../utils/index.js';

describe('utils', () => {
  describe('computeTrackListHash', () => {
    it('should compute consistent hash for same input', () => {
      const ids = ['track1', 'track2', 'track3'];
      const hash1 = computeTrackListHash(ids);
      const hash2 = computeTrackListHash(ids);
      expect(hash1).toBe(hash2);
    });

    it('should compute different hash for different order', () => {
      const hash1 = computeTrackListHash(['a', 'b', 'c']);
      const hash2 = computeTrackListHash(['c', 'b', 'a']);
      expect(hash1).not.toBe(hash2);
    });

    it('should compute different hash for different content', () => {
      const hash1 = computeTrackListHash(['a', 'b']);
      const hash2 = computeTrackListHash(['a', 'c']);
      expect(hash1).not.toBe(hash2);
    });
  });

  describe('sanitizeFilename', () => {
    it('should remove invalid characters', () => {
      expect(sanitizeFilename('Test<>:"/\\|?*File')).toBe('TestFile');
    });

    it('should trim whitespace', () => {
      expect(sanitizeFilename('  Test File  ')).toBe('Test File');
    });

    it('should collapse multiple spaces', () => {
      expect(sanitizeFilename('Test   File')).toBe('Test File');
    });

    it('should truncate long names', () => {
      const longName = 'a'.repeat(150);
      expect(sanitizeFilename(longName).length).toBe(100);
    });
  });

  describe('extractPlaylistIdFromFolderName', () => {
    it('should extract playlist ID', () => {
      expect(extractPlaylistIdFromFolderName('My Playlist__abc123')).toBe('abc123');
    });

    it('should return null for invalid format', () => {
      expect(extractPlaylistIdFromFolderName('My Playlist')).toBeNull();
    });
  });

  describe('extractTrackIdFromFilename', () => {
    it('should extract track ID', () => {
      expect(extractTrackIdFromFilename('001__Artist - Track__xyz789.spotify')).toBe('xyz789');
    });

    it('should return null for invalid format', () => {
      expect(extractTrackIdFromFilename('invalid.txt')).toBeNull();
    });
  });

  describe('createPlaylistFolderName', () => {
    it('should create folder name with ID', () => {
      expect(createPlaylistFolderName('My Playlist', 'abc123')).toBe('My Playlist__abc123');
    });

    it('should sanitize the name', () => {
      expect(createPlaylistFolderName('My<>Playlist', 'abc123')).toBe('MyPlaylist__abc123');
    });
  });

  describe('createTrackFilename', () => {
    it('should create track filename', () => {
      expect(createTrackFilename(1, 'Artist - Track', 'xyz789')).toBe(
        '001__Artist - Track__xyz789.spotify'
      );
    });

    it('should pad position with zeros', () => {
      expect(createTrackFilename(99, 'Artist - Track', 'xyz789')).toBe(
        '099__Artist - Track__xyz789.spotify'
      );
    });
  });

  describe('parseTrackFilename', () => {
    it('should parse valid filename', () => {
      const result = parseTrackFilename('042__Artist Name - Track Title__abc123.spotify');
      expect(result).toEqual({
        position: 42,
        displayName: 'Artist Name - Track Title',
        trackId: 'abc123',
      });
    });

    it('should return null for invalid filename', () => {
      expect(parseTrackFilename('invalid.txt')).toBeNull();
    });
  });

  describe('spotifyUriToId', () => {
    it('should extract ID from URI', () => {
      expect(spotifyUriToId('spotify:track:4iV5W9uYEdYUVa79Axb7Rh')).toBe(
        '4iV5W9uYEdYUVa79Axb7Rh'
      );
    });
  });

  describe('trackIdToUri', () => {
    it('should create URI from ID', () => {
      expect(trackIdToUri('4iV5W9uYEdYUVa79Axb7Rh')).toBe(
        'spotify:track:4iV5W9uYEdYUVa79Axb7Rh'
      );
    });
  });

  describe('chunkArray', () => {
    it('should chunk array into pieces', () => {
      expect(chunkArray([1, 2, 3, 4, 5], 2)).toEqual([[1, 2], [3, 4], [5]]);
    });

    it('should return single chunk for small array', () => {
      expect(chunkArray([1, 2], 5)).toEqual([[1, 2]]);
    });

    it('should handle empty array', () => {
      expect(chunkArray([], 2)).toEqual([]);
    });
  });

  describe('arrayDiff', () => {
    it('should find added items', () => {
      const { added, removed, common } = arrayDiff(['a', 'b', 'c'], ['a', 'b']);
      expect(added).toEqual(['c']);
      expect(removed).toEqual([]);
      expect(common).toEqual(['a', 'b']);
    });

    it('should find removed items', () => {
      const { added, removed, common } = arrayDiff(['a', 'b'], ['a', 'b', 'c']);
      expect(added).toEqual([]);
      expect(removed).toEqual(['c']);
      expect(common).toEqual(['a', 'b']);
    });

    it('should find both added and removed', () => {
      const { added, removed, common } = arrayDiff(['a', 'b', 'x'], ['a', 'b', 'y']);
      expect(added).toEqual(['x']);
      expect(removed).toEqual(['y']);
      expect(common).toEqual(['a', 'b']);
    });
  });

  describe('orderChanged', () => {
    it('should detect order change', () => {
      expect(orderChanged(['a', 'b', 'c'], ['c', 'b', 'a'])).toBe(true);
    });

    it('should detect no change', () => {
      expect(orderChanged(['a', 'b', 'c'], ['a', 'b', 'c'])).toBe(false);
    });

    it('should detect length change', () => {
      expect(orderChanged(['a', 'b'], ['a', 'b', 'c'])).toBe(true);
    });
  });
});
