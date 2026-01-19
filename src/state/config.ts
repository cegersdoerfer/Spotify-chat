import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import type { WorkspaceConfig, WorkspaceSettings, TokenData } from '../types/index.js';

const CONFIG_FILENAME = 'config.json';
const TOKENS_FILENAME = 'tokens.json';

export function getDefaultSettings(): WorkspaceSettings {
  return {
    pullInterval: 5 * 60 * 1000, // 5 minutes
    autoCommit: true,
    orderingMode: 'prefix',
    syncLibrary: false,
    conflictPolicy: 'prompt',
  };
}

export function createDefaultConfig(workspacePath: string): WorkspaceConfig {
  return {
    version: '1.0.0',
    workspacePath,
    createdAt: new Date().toISOString(),
    settings: getDefaultSettings(),
  };
}

export class ConfigManager {
  private workspacePath: string;
  private spotifyFsPath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.spotifyFsPath = join(workspacePath, '.spotifyfs');
  }

  private ensureDirectoryExists(): void {
    if (!existsSync(this.spotifyFsPath)) {
      mkdirSync(this.spotifyFsPath, { recursive: true });
    }

    const logsDir = join(this.spotifyFsPath, 'logs');
    if (!existsSync(logsDir)) {
      mkdirSync(logsDir, { recursive: true });
    }

    const proposalsDir = join(this.spotifyFsPath, 'proposals');
    if (!existsSync(proposalsDir)) {
      mkdirSync(proposalsDir, { recursive: true });
    }
  }

  private get configPath(): string {
    return join(this.spotifyFsPath, CONFIG_FILENAME);
  }

  private get tokensPath(): string {
    return join(this.spotifyFsPath, TOKENS_FILENAME);
  }

  isInitialized(): boolean {
    return existsSync(this.configPath);
  }

  getConfig(): WorkspaceConfig {
    if (!this.isInitialized()) {
      throw new Error('Workspace not initialized. Run "spotifyfs init" first.');
    }

    const content = readFileSync(this.configPath, 'utf-8');
    return JSON.parse(content) as WorkspaceConfig;
  }

  saveConfig(config: WorkspaceConfig): void {
    this.ensureDirectoryExists();
    writeFileSync(this.configPath, JSON.stringify(config, null, 2));
  }

  updateConfig(updates: Partial<WorkspaceConfig>): WorkspaceConfig {
    const config = this.getConfig();
    const updatedConfig = { ...config, ...updates };
    this.saveConfig(updatedConfig);
    return updatedConfig;
  }

  updateSettings(settings: Partial<WorkspaceSettings>): WorkspaceConfig {
    const config = this.getConfig();
    config.settings = { ...config.settings, ...settings };
    this.saveConfig(config);
    return config;
  }

  // Token management
  hasTokens(): boolean {
    return existsSync(this.tokensPath);
  }

  getTokens(): TokenData | null {
    if (!this.hasTokens()) {
      return null;
    }

    try {
      const content = readFileSync(this.tokensPath, 'utf-8');
      return JSON.parse(content) as TokenData;
    } catch {
      return null;
    }
  }

  saveTokens(tokens: TokenData): void {
    this.ensureDirectoryExists();
    writeFileSync(this.tokensPath, JSON.stringify(tokens, null, 2), { mode: 0o600 });
  }

  deleteTokens(): void {
    if (existsSync(this.tokensPath)) {
      unlinkSync(this.tokensPath);
    }
  }

  // Initialize workspace
  initialize(clientId?: string): WorkspaceConfig {
    this.ensureDirectoryExists();

    const config = createDefaultConfig(this.workspacePath);
    this.saveConfig(config);

    // Create Playlists directory
    const playlistsDir = join(this.workspacePath, 'Playlists');
    if (!existsSync(playlistsDir)) {
      mkdirSync(playlistsDir, { recursive: true });
    }

    return config;
  }
}

// Find workspace root by looking for .spotifyfs directory
export function findWorkspaceRoot(startPath: string): string | null {
  let currentPath = startPath;

  while (currentPath !== dirname(currentPath)) {
    const spotifyFsPath = join(currentPath, '.spotifyfs');
    if (existsSync(spotifyFsPath)) {
      return currentPath;
    }
    currentPath = dirname(currentPath);
  }

  return null;
}
