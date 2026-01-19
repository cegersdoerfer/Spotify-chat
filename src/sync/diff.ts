import type {
  LocalPlaylist,
  SpotifyPlaylistWithTracks,
  PlaylistDiff,
  ConflictDetails,
  SyncOperation,
  SyncPlan,
} from '../types/index.js';
import { computeTrackListHash, orderChanged, trackIdToUri } from '../utils/index.js';

export interface DiffContext {
  lastSyncedRemoteSnapshotId?: string;
  lastSyncedLocalHash?: string;
}

export function computePlaylistDiff(
  local: LocalPlaylist,
  remote: SpotifyPlaylistWithTracks,
  context: DiffContext = {}
): PlaylistDiff {
  const localTrackIds = local.tracks.map((t) => t.trackId);
  const remoteTrackIds = remote.tracks.map((t) => t.id);

  const localSet = new Set(localTrackIds);
  const remoteSet = new Set(remoteTrackIds);

  // Compute additions (in local but not remote)
  const additions = localTrackIds.filter((id) => !remoteSet.has(id));

  // Compute removals (in remote but not local)
  const removals = remoteTrackIds.filter((id) => !localSet.has(id));

  // Check if reorder is needed (same tracks but different order)
  const commonLocal = localTrackIds.filter((id) => remoteSet.has(id));
  const commonRemote = remoteTrackIds.filter((id) => localSet.has(id));
  const reorderNeeded = orderChanged(commonLocal, commonRemote);

  // Detect conflicts
  const localHash = computeTrackListHash(localTrackIds);
  const remoteSnapshotChanged =
    context.lastSyncedRemoteSnapshotId !== undefined &&
    context.lastSyncedRemoteSnapshotId !== remote.snapshotId;
  const localChanged =
    context.lastSyncedLocalHash !== undefined &&
    context.lastSyncedLocalHash !== localHash;

  const hasConflict = remoteSnapshotChanged && localChanged;

  let conflictDetails: ConflictDetails | undefined;
  if (hasConflict) {
    conflictDetails = {
      localChanges: [],
      remoteChanges: [],
      addedLocally: additions,
      addedRemotely: [],
      removedLocally: removals,
      removedRemotely: [],
    };
  }

  return {
    playlistId: local.playlistId,
    playlistName: local.name,
    additions,
    removals,
    reorderNeeded,
    newOrder: reorderNeeded || additions.length > 0 || removals.length > 0
      ? localTrackIds
      : undefined,
    localOrder: localTrackIds,
    remoteOrder: remoteTrackIds,
    hasConflict,
    conflictDetails,
  };
}

export function computePullDiff(
  localPlaylists: Map<string, LocalPlaylist>,
  remotePlaylists: Map<string, SpotifyPlaylistWithTracks>
): {
  toCreate: SpotifyPlaylistWithTracks[];
  toUpdate: Array<{ local: LocalPlaylist; remote: SpotifyPlaylistWithTracks }>;
  toDelete: LocalPlaylist[];
} {
  const toCreate: SpotifyPlaylistWithTracks[] = [];
  const toUpdate: Array<{ local: LocalPlaylist; remote: SpotifyPlaylistWithTracks }> = [];
  const toDelete: LocalPlaylist[] = [];

  // Find new and updated playlists
  for (const [playlistId, remote] of remotePlaylists) {
    const local = localPlaylists.get(playlistId);
    if (!local) {
      toCreate.push(remote);
    } else {
      // Check if update needed
      const localHash = computeTrackListHash(local.tracks.map((t) => t.trackId));
      const remoteHash = computeTrackListHash(remote.tracks.map((t) => t.id));
      if (localHash !== remoteHash || local.metadata.snapshotId !== remote.snapshotId) {
        toUpdate.push({ local, remote });
      }
    }
  }

  // Find deleted playlists
  for (const [playlistId, local] of localPlaylists) {
    if (!remotePlaylists.has(playlistId)) {
      toDelete.push(local);
    }
  }

  return { toCreate, toUpdate, toDelete };
}

export function computePushPlan(
  localPlaylists: Map<string, LocalPlaylist>,
  remotePlaylists: Map<string, SpotifyPlaylistWithTracks>,
  contexts: Map<string, DiffContext>
): SyncPlan {
  const operations: SyncOperation[] = [];
  const conflicts: PlaylistDiff[] = [];

  // Find new playlists to create
  for (const [playlistId, local] of localPlaylists) {
    const remote = remotePlaylists.get(playlistId);

    if (!remote) {
      // New playlist - but we can't create it without a real playlist ID
      // This case happens when a user creates a folder locally
      // We'll handle this separately with create_playlist operation
      operations.push({
        type: 'create_playlist',
        name: local.name,
        trackIds: local.tracks.map((t) => t.trackId),
      });
    } else {
      // Existing playlist - compute diff
      const context = contexts.get(playlistId) || {};
      const diff = computePlaylistDiff(local, remote, context);

      if (diff.hasConflict) {
        conflicts.push(diff);
        continue;
      }

      // Generate operations based on diff
      if (diff.removals.length > 0) {
        operations.push({
          type: 'remove_tracks',
          playlistId,
          trackIds: diff.removals,
        });
      }

      if (diff.additions.length > 0) {
        operations.push({
          type: 'add_tracks',
          playlistId,
          trackIds: diff.additions,
        });
      }

      // If we have reorders or complex changes, use replace
      if (diff.reorderNeeded && diff.newOrder) {
        // Check if simple add/remove is enough or if we need full replace
        const needsReplace =
          diff.additions.length === 0 &&
          diff.removals.length === 0 &&
          diff.reorderNeeded;

        if (needsReplace) {
          operations.push({
            type: 'replace_tracks',
            playlistId,
            trackIds: diff.newOrder,
          });
        }
      }
    }
  }

  // Find deleted playlists
  for (const [playlistId, remote] of remotePlaylists) {
    if (!localPlaylists.has(playlistId)) {
      operations.push({
        type: 'delete_playlist',
        playlistId,
      });
    }
  }

  return {
    operations,
    conflicts,
    createdAt: new Date().toISOString(),
  };
}

export function optimizePlan(plan: SyncPlan): SyncPlan {
  const operations: SyncOperation[] = [];
  const operationsByPlaylist = new Map<string, SyncOperation[]>();

  // Group operations by playlist
  for (const op of plan.operations) {
    if ('playlistId' in op) {
      const existing = operationsByPlaylist.get(op.playlistId) || [];
      existing.push(op);
      operationsByPlaylist.set(op.playlistId, existing);
    } else {
      operations.push(op);
    }
  }

  // Optimize per-playlist operations
  for (const [playlistId, ops] of operationsByPlaylist) {
    // If there's a replace operation, it supersedes add/remove
    const hasReplace = ops.some((op) => op.type === 'replace_tracks');
    if (hasReplace) {
      const replaceOp = ops.find((op) => op.type === 'replace_tracks');
      if (replaceOp) {
        operations.push(replaceOp);
      }
    } else {
      // Keep add/remove operations
      for (const op of ops) {
        operations.push(op);
      }
    }
  }

  return {
    ...plan,
    operations,
  };
}
