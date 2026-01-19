import { resolve } from 'path';
import { ConfigManager, StateStore, findWorkspaceRoot } from '../state/index.js';
import { SpotifyClient } from '../spotify/index.js';
import { FilesystemSerializer } from '../filesystem/index.js';
import { SyncEngine } from '../sync/index.js';
import { GitManager } from '../git/index.js';
import type { TokenData, WorkspaceConfig } from '../types/index.js';

export interface CLIContext {
  workspacePath: string;
  config: ConfigManager;
  store: StateStore;
  spotify: SpotifyClient;
  serializer: FilesystemSerializer;
  sync: SyncEngine;
  git: GitManager;
  workspaceConfig: WorkspaceConfig;
}

export async function createContext(
  clientId: string,
  workspacePath?: string
): Promise<CLIContext> {
  // Find workspace root
  const startPath = workspacePath || process.cwd();
  const resolvedPath = resolve(startPath);
  const root = findWorkspaceRoot(resolvedPath);

  if (!root) {
    throw new Error(
      `No SpotifyFS workspace found in ${resolvedPath} or any parent directory.\n` +
        'Run "spotifyfs init <path>" to create a new workspace.'
    );
  }

  const config = new ConfigManager(root);
  const workspaceConfig = config.getConfig();
  const tokens = config.getTokens();

  if (!tokens) {
    throw new Error(
      'Not authenticated. Run "spotifyfs auth" to authenticate with Spotify.'
    );
  }

  const store = new StateStore(root);

  const spotify = new SpotifyClient(tokens, clientId, async (newTokens: TokenData) => {
    config.saveTokens(newTokens);
  });

  const serializer = new FilesystemSerializer(root, {
    orderingMode: workspaceConfig.settings.orderingMode,
  });

  // Get user ID for sync engine
  let userId = workspaceConfig.spotifyUserId;
  if (!userId) {
    const user = await spotify.getCurrentUser();
    userId = user.id;
    config.updateConfig({ spotifyUserId: userId });
  }

  const sync = new SyncEngine(spotify, store, serializer, userId);
  const git = new GitManager(root);

  return {
    workspacePath: root,
    config,
    store,
    spotify,
    serializer,
    sync,
    git,
    workspaceConfig,
  };
}

export function getClientId(): string {
  const clientId = process.env.SPOTIFY_CLIENT_ID;
  if (!clientId) {
    throw new Error(
      'SPOTIFY_CLIENT_ID environment variable is required.\n' +
        'Create a Spotify app at https://developer.spotify.com/dashboard and set the client ID.'
    );
  }
  return clientId;
}
