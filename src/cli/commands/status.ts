import { Command } from 'commander';
import chalk from 'chalk';
import { createContext, getClientId } from '../context.js';

export function statusCommand(): Command {
  return new Command('status')
    .description('Show sync status between local workspace and Spotify')
    .action(async () => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        console.log(chalk.blue('Checking status...\n'));

        const status = await ctx.sync.status();
        const gitStatus = await ctx.git.status();
        const currentBranch = await ctx.git.getCurrentBranch();

        console.log(chalk.cyan('Git branch: ') + currentBranch);
        console.log(
          chalk.cyan('Git status: ') +
            (gitStatus.isClean() ? chalk.green('clean') : chalk.yellow('uncommitted changes'))
        );

        console.log();
        console.log(chalk.cyan('Local playlists:  ') + status.localPlaylists);
        console.log(chalk.cyan('Remote playlists: ') + status.remotePlaylists);

        if (status.pendingAdditions > 0 || status.pendingRemovals > 0) {
          console.log();
          console.log(chalk.yellow('Pending changes:'));
          if (status.pendingAdditions > 0) {
            console.log(chalk.green(`  + ${status.pendingAdditions} tracks to add`));
          }
          if (status.pendingRemovals > 0) {
            console.log(chalk.red(`  - ${status.pendingRemovals} tracks to remove`));
          }
        } else {
          console.log(chalk.green('\nNo pending changes.'));
        }

        if (status.conflicts > 0) {
          console.log(chalk.red(`\n${status.conflicts} conflicts detected!`));
          console.log(
            chalk.blue('Run "spotifyfs diff" for details or use --conflict flag when pushing.')
          );
        }

        // Show recent sync logs
        const logs = ctx.store.getRecentSyncLogs(5);
        if (logs.length > 0) {
          console.log(chalk.cyan('\nRecent sync operations:'));
          for (const log of logs) {
            const status = log.success ? chalk.green('OK') : chalk.red('FAIL');
            const time = new Date(log.timestamp).toLocaleString();
            console.log(`  [${status}] ${time} - ${log.operationType}`);
          }
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
