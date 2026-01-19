import { Command } from 'commander';
import { resolve, join } from 'path';
import { existsSync, mkdirSync } from 'fs';
import chalk from 'chalk';
import { ConfigManager } from '../../state/index.js';
import { GitManager } from '../../git/index.js';
import { authenticateWithPKCE } from '../../spotify/index.js';
import { getClientId } from '../context.js';

export function initCommand(): Command {
  return new Command('init')
    .description('Initialize a new SpotifyFS workspace')
    .argument('[path]', 'Path to create the workspace', '.')
    .option('--skip-auth', 'Skip Spotify authentication')
    .option('--skip-git', 'Skip Git initialization')
    .action(async (pathArg: string, options: { skipAuth?: boolean; skipGit?: boolean }) => {
      try {
        const workspacePath = resolve(pathArg);

        // Check if already initialized
        const spotifyFsPath = join(workspacePath, '.spotifyfs');
        if (existsSync(spotifyFsPath)) {
          console.log(chalk.yellow('Workspace already initialized.'));
          return;
        }

        console.log(chalk.blue(`Initializing SpotifyFS workspace at ${workspacePath}...`));

        // Create workspace directory if it doesn't exist
        if (!existsSync(workspacePath)) {
          mkdirSync(workspacePath, { recursive: true });
        }

        // Initialize config
        const config = new ConfigManager(workspacePath);
        config.initialize();
        console.log(chalk.green('  Created .spotifyfs directory'));

        // Initialize Git
        if (!options.skipGit) {
          const git = new GitManager(workspacePath);
          await git.initialize();
          console.log(chalk.green('  Initialized Git repository'));
        }

        // Authenticate with Spotify
        if (!options.skipAuth) {
          const clientId = getClientId();
          console.log(chalk.blue('\nAuthenticating with Spotify...'));

          try {
            const tokens = await authenticateWithPKCE({ clientId });
            config.saveTokens(tokens);
            console.log(chalk.green('  Authenticated successfully!'));
          } catch (error) {
            console.log(
              chalk.yellow(
                `  Authentication skipped: ${error}\n` +
                  '  Run "spotifyfs auth" to authenticate later.'
              )
            );
          }
        }

        console.log(chalk.green('\nWorkspace initialized successfully!'));
        console.log(chalk.blue('\nNext steps:'));
        console.log('  1. Run "spotifyfs pull" to fetch your playlists');
        console.log('  2. Edit playlists in the Playlists/ folder');
        console.log('  3. Run "spotifyfs push" to sync changes to Spotify');
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
