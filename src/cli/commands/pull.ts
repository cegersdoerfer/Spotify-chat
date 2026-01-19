import { Command } from 'commander';
import chalk from 'chalk';
import { createContext, getClientId } from '../context.js';

export function pullCommand(): Command {
  return new Command('pull')
    .description('Pull playlists from Spotify to local workspace')
    .option('--dry-run', 'Show what would be changed without making changes')
    .option('--force', 'Overwrite local changes without prompting')
    .action(async (options: { dryRun?: boolean; force?: boolean }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        console.log(chalk.blue('Fetching playlists from Spotify...'));

        const result = await ctx.sync.pull({
          dryRun: options.dryRun,
          force: options.force,
        });

        if (options.dryRun) {
          console.log(chalk.yellow('\n[Dry run - no changes made]'));
        }

        if (result.appliedOperations.length === 0 && result.failedOperations.length === 0) {
          console.log(chalk.green('Already up to date.'));
        } else {
          if (result.appliedOperations.length > 0) {
            console.log(chalk.green(`\n${result.appliedOperations.length} operations applied.`));
          }

          if (result.failedOperations.length > 0) {
            console.log(chalk.red(`\n${result.failedOperations.length} operations failed:`));
            for (const { operation, error } of result.failedOperations) {
              console.log(chalk.red(`  - ${operation.type}: ${error}`));
            }
          }
        }

        // Auto-commit if enabled
        if (ctx.workspaceConfig.settings.autoCommit && !options.dryRun) {
          const isClean = await ctx.git.isClean();
          if (!isClean) {
            await ctx.git.commitChanges(`Pull from Spotify at ${new Date().toISOString()}`);
            console.log(chalk.green('Changes committed to Git.'));
          }
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
