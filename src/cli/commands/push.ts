import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';

export function pushCommand(): Command {
  return new Command('push')
    .description('Push local changes to Spotify')
    .option('--dry-run', 'Show what would be changed without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .option('--force', 'Push even if there are uncommitted changes')
    .option(
      '--conflict <strategy>',
      'Conflict resolution strategy: take-local, take-remote, abort',
      'abort'
    )
    .action(
      async (options: {
        dryRun?: boolean;
        yes?: boolean;
        force?: boolean;
        conflict?: string;
      }) => {
        try {
          const clientId = getClientId();
          const ctx = await createContext(clientId);

          // Check for uncommitted changes
          if (!options.force && !options.dryRun) {
            const isClean = await ctx.git.isClean();
            if (!isClean) {
              console.log(
                chalk.yellow(
                  'Warning: You have uncommitted changes. Use --force to push anyway.'
                )
              );
              const { proceed } = await inquirer.prompt([
                {
                  type: 'confirm',
                  name: 'proceed',
                  message: 'Continue anyway?',
                  default: false,
                },
              ]);
              if (!proceed) {
                console.log(chalk.yellow('Push cancelled.'));
                ctx.store.close();
                return;
              }
            }
          }

          // Show diff first
          console.log(chalk.blue('Computing changes...'));
          const diffs = await ctx.sync.diff();

          if (diffs.length === 0) {
            console.log(chalk.green('No changes to push.'));
            ctx.store.close();
            return;
          }

          console.log(chalk.blue('\nChanges to push:'));
          for (const diff of diffs) {
            console.log(`\n  ${chalk.cyan(diff.playlistName)} (${diff.playlistId})`);
            if (diff.additions.length > 0) {
              console.log(chalk.green(`    + ${diff.additions.length} tracks to add`));
            }
            if (diff.removals.length > 0) {
              console.log(chalk.red(`    - ${diff.removals.length} tracks to remove`));
            }
            if (diff.reorderNeeded) {
              console.log(chalk.yellow('    ~ Tracks will be reordered'));
            }
            if (diff.hasConflict) {
              console.log(chalk.red('    ! CONFLICT: Both local and remote changed'));
            }
          }

          if (options.dryRun) {
            console.log(chalk.yellow('\n[Dry run - no changes made]'));
            ctx.store.close();
            return;
          }

          // Confirm push
          if (!options.yes) {
            const { proceed } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'proceed',
                message: 'Push these changes to Spotify?',
                default: true,
              },
            ]);
            if (!proceed) {
              console.log(chalk.yellow('Push cancelled.'));
              ctx.store.close();
              return;
            }
          }

          console.log(chalk.blue('\nPushing changes to Spotify...'));

          const conflictStrategy = options.conflict as
            | 'take-local'
            | 'take-remote'
            | 'abort'
            | undefined;

          const result = await ctx.sync.push({
            conflictResolution: conflictStrategy,
          });

          if (result.success) {
            console.log(
              chalk.green(
                `\nSuccess! ${result.appliedOperations.length} operations applied.`
              )
            );
          } else {
            console.log(chalk.yellow('\nPush completed with issues:'));
          }

          if (result.failedOperations.length > 0) {
            console.log(chalk.red(`\n${result.failedOperations.length} operations failed:`));
            for (const { operation, error } of result.failedOperations) {
              console.log(chalk.red(`  - ${operation.type}: ${error}`));
            }
          }

          if (result.conflicts.length > 0) {
            console.log(chalk.yellow(`\n${result.conflicts.length} conflicts detected:`));
            for (const conflict of result.conflicts) {
              console.log(chalk.yellow(`  - ${conflict.playlistName}`));
            }
            console.log(
              chalk.blue(
                '\nResolve conflicts with:\n' +
                  '  spotifyfs push --conflict take-local  (use your local version)\n' +
                  '  spotifyfs push --conflict take-remote (use Spotify version)\n' +
                  '  spotifyfs pull --force                (overwrite with Spotify)'
              )
            );
          }

          ctx.store.close();
        } catch (error) {
          console.error(chalk.red(`Error: ${error}`));
          process.exit(1);
        }
      }
    );
}
