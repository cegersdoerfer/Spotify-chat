import { describe, it, expect } from 'vitest';
import { computePlaylistDiff, computePullDiff, computePushPlan } from '../sync/diff.js';
import type { LocalPlaylist, SpotifyPlaylistWithTracks, PlaylistMetadata } from '../types/index.js';

function createMockLocalPlaylist(
  id: string,
  name: string,
  trackIds: string[]
): LocalPlaylist {
  return {
    playlistId: id,
    name,
    folderPath: `/path/to/${name}__${id}`,
    tracks: trackIds.map((trackId, index) => ({
      trackId,
      uri: `spotify:track:${trackId}`,
      displayName: `Track ${trackId}`,
      position: index + 1,
      filePath: `/path/to/${name}__${id}/tracks/${index + 1}__Track ${trackId}__${trackId}.spotify`,
    })),
    metadata: {
      id,
      uri: `spotify:playlist:${id}`,
      name,
      description: '',
      isPublic: false,
      collaborative: false,
      snapshotId: 'snapshot1',
      owner: { id: 'user1', displayName: 'User' },
    },
  };
}

function createMockRemotePlaylist(
  id: string,
  name: string,
  trackIds: string[],
  snapshotId = 'snapshot1'
): SpotifyPlaylistWithTracks {
  return {
    id,
    uri: `spotify:playlist:${id}`,
    name,
    description: '',
    isPublic: false,
    collaborative: false,
    snapshotId,
    owner: { id: 'user1', displayName: 'User' },
    trackCount: trackIds.length,
    tracks: trackIds.map((trackId) => ({
      id: trackId,
      uri: `spotify:track:${trackId}`,
      name: `Track ${trackId}`,
      artists: ['Artist'],
      album: 'Album',
      durationMs: 180000,
    })),
  };
}

describe('computePlaylistDiff', () => {
  it('should detect additions', () => {
    const local = createMockLocalPlaylist('pl1', 'Test', ['a', 'b', 'c']);
    const remote = createMockRemotePlaylist('pl1', 'Test', ['a', 'b']);

    const diff = computePlaylistDiff(local, remote);

    expect(diff.additions).toEqual(['c']);
    expect(diff.removals).toEqual([]);
    expect(diff.hasConflict).toBe(false);
  });

  it('should detect removals', () => {
    const local = createMockLocalPlaylist('pl1', 'Test', ['a', 'b']);
    const remote = createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c']);

    const diff = computePlaylistDiff(local, remote);

    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual(['c']);
    expect(diff.hasConflict).toBe(false);
  });

  it('should detect reorder', () => {
    const local = createMockLocalPlaylist('pl1', 'Test', ['c', 'b', 'a']);
    const remote = createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c']);

    const diff = computePlaylistDiff(local, remote);

    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.reorderNeeded).toBe(true);
  });

  it('should detect no changes', () => {
    const local = createMockLocalPlaylist('pl1', 'Test', ['a', 'b', 'c']);
    const remote = createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c']);

    const diff = computePlaylistDiff(local, remote);

    expect(diff.additions).toEqual([]);
    expect(diff.removals).toEqual([]);
    expect(diff.reorderNeeded).toBe(false);
  });

  it('should detect conflict when both sides changed', () => {
    const local = createMockLocalPlaylist('pl1', 'Test', ['a', 'b', 'x']);
    const remote = createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c'], 'snapshot2');

    const diff = computePlaylistDiff(local, remote, {
      lastSyncedRemoteSnapshotId: 'snapshot1',
      lastSyncedLocalHash: 'oldhash',
    });

    expect(diff.hasConflict).toBe(true);
  });
});

describe('computePullDiff', () => {
  it('should detect new playlists', () => {
    const local = new Map<string, LocalPlaylist>();
    const remote = new Map<string, SpotifyPlaylistWithTracks>();
    remote.set('pl1', createMockRemotePlaylist('pl1', 'Test', ['a', 'b']));

    const { toCreate, toUpdate, toDelete } = computePullDiff(local, remote);

    expect(toCreate.length).toBe(1);
    expect(toCreate[0].id).toBe('pl1');
    expect(toUpdate.length).toBe(0);
    expect(toDelete.length).toBe(0);
  });

  it('should detect deleted playlists', () => {
    const local = new Map<string, LocalPlaylist>();
    local.set('pl1', createMockLocalPlaylist('pl1', 'Test', ['a', 'b']));
    const remote = new Map<string, SpotifyPlaylistWithTracks>();

    const { toCreate, toUpdate, toDelete } = computePullDiff(local, remote);

    expect(toCreate.length).toBe(0);
    expect(toUpdate.length).toBe(0);
    expect(toDelete.length).toBe(1);
    expect(toDelete[0].playlistId).toBe('pl1');
  });

  it('should detect updated playlists', () => {
    const local = new Map<string, LocalPlaylist>();
    local.set('pl1', createMockLocalPlaylist('pl1', 'Test', ['a', 'b']));
    const remote = new Map<string, SpotifyPlaylistWithTracks>();
    remote.set('pl1', createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c'], 'snapshot2'));

    const { toCreate, toUpdate, toDelete } = computePullDiff(local, remote);

    expect(toCreate.length).toBe(0);
    expect(toUpdate.length).toBe(1);
    expect(toDelete.length).toBe(0);
  });
});

describe('computePushPlan', () => {
  it('should generate add operation', () => {
    const local = new Map<string, LocalPlaylist>();
    local.set('pl1', createMockLocalPlaylist('pl1', 'Test', ['a', 'b', 'c']));
    const remote = new Map<string, SpotifyPlaylistWithTracks>();
    remote.set('pl1', createMockRemotePlaylist('pl1', 'Test', ['a', 'b']));
    const contexts = new Map();

    const plan = computePushPlan(local, remote, contexts);

    const addOp = plan.operations.find((op) => op.type === 'add_tracks');
    expect(addOp).toBeDefined();
    if (addOp && addOp.type === 'add_tracks') {
      expect(addOp.trackIds).toEqual(['c']);
    }
  });

  it('should generate remove operation', () => {
    const local = new Map<string, LocalPlaylist>();
    local.set('pl1', createMockLocalPlaylist('pl1', 'Test', ['a', 'b']));
    const remote = new Map<string, SpotifyPlaylistWithTracks>();
    remote.set('pl1', createMockRemotePlaylist('pl1', 'Test', ['a', 'b', 'c']));
    const contexts = new Map();

    const plan = computePushPlan(local, remote, contexts);

    const removeOp = plan.operations.find((op) => op.type === 'remove_tracks');
    expect(removeOp).toBeDefined();
    if (removeOp && removeOp.type === 'remove_tracks') {
      expect(removeOp.trackIds).toEqual(['c']);
    }
  });

  it('should generate create operation for new playlist', () => {
    const local = new Map<string, LocalPlaylist>();
    local.set('new1', createMockLocalPlaylist('new1', 'New Playlist', ['a', 'b']));
    const remote = new Map<string, SpotifyPlaylistWithTracks>();
    const contexts = new Map();

    const plan = computePushPlan(local, remote, contexts);

    const createOp = plan.operations.find((op) => op.type === 'create_playlist');
    expect(createOp).toBeDefined();
  });
});
