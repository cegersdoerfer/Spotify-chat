import { Command } from 'commander';
import chalk from 'chalk';
import { ConfigManager, findWorkspaceRoot } from '../../state/index.js';
import { authenticateWithPKCE } from '../../spotify/index.js';
import { getClientId } from '../context.js';

export function authCommand(): Command {
  return new Command('auth')
    .description('Authenticate with Spotify')
    .option('--logout', 'Remove stored credentials')
    .action(async (options: { logout?: boolean }) => {
      try {
        const workspacePath = findWorkspaceRoot(process.cwd());
        if (!workspacePath) {
          console.error(
            chalk.red('Not in a SpotifyFS workspace. Run "spotifyfs init" first.')
          );
          process.exit(1);
        }

        const config = new ConfigManager(workspacePath);

        if (options.logout) {
          config.deleteTokens();
          console.log(chalk.green('Logged out successfully.'));
          return;
        }

        const clientId = getClientId();
        console.log(chalk.blue('Authenticating with Spotify...'));

        const tokens = await authenticateWithPKCE({ clientId });
        config.saveTokens(tokens);

        console.log(chalk.green('Authenticated successfully!'));
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
