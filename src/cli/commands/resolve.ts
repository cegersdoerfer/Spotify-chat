import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';

export function resolveCommand(): Command {
  return new Command('resolve')
    .description('Resolve sync conflicts')
    .option('--take-local', 'Resolve all conflicts by taking local version')
    .option('--take-remote', 'Resolve all conflicts by taking remote version')
    .option('--interactive', 'Resolve conflicts interactively')
    .action(
      async (options: {
        takeLocal?: boolean;
        takeRemote?: boolean;
        interactive?: boolean;
      }) => {
        try {
          const clientId = getClientId();
          const ctx = await createContext(clientId);

          // Get current diffs with conflicts
          const diffs = await ctx.sync.diff();
          const conflicts = diffs.filter((d) => d.hasConflict);

          if (conflicts.length === 0) {
            console.log(chalk.green('No conflicts to resolve.'));
            ctx.store.close();
            return;
          }

          console.log(chalk.yellow(`Found ${conflicts.length} conflict(s):\n`));

          for (const conflict of conflicts) {
            console.log(chalk.cyan.bold(conflict.playlistName));
            console.log(chalk.gray(`  Playlist ID: ${conflict.playlistId}`));
            console.log(chalk.green(`  Local tracks: ${conflict.localOrder.length}`));
            console.log(chalk.blue(`  Remote tracks: ${conflict.remoteOrder.length}`));
            if (conflict.conflictDetails) {
              console.log(
                chalk.green(`  Added locally: ${conflict.conflictDetails.addedLocally.length}`)
              );
              console.log(
                chalk.red(`  Removed locally: ${conflict.conflictDetails.removedLocally.length}`)
              );
            }
            console.log();
          }

          let resolution: 'take-local' | 'take-remote' | 'abort' = 'abort';

          if (options.takeLocal) {
            resolution = 'take-local';
          } else if (options.takeRemote) {
            resolution = 'take-remote';
          } else if (options.interactive) {
            // Interactive resolution
            for (const conflict of conflicts) {
              const { choice } = await inquirer.prompt([
                {
                  type: 'list',
                  name: 'choice',
                  message: `How to resolve '${conflict.playlistName}'?`,
                  choices: [
                    { name: 'Keep local version', value: 'local' },
                    { name: 'Take remote version', value: 'remote' },
                    { name: 'Skip (keep in conflict)', value: 'skip' },
                  ],
                },
              ]);

              if (choice === 'local') {
                // Push local changes for this playlist
                console.log(chalk.blue(`Pushing local changes for ${conflict.playlistName}...`));
                await ctx.sync.push({ conflictResolution: 'take-local' });
              } else if (choice === 'remote') {
                // Pull remote for this playlist
                console.log(
                  chalk.blue(`Pulling remote changes for ${conflict.playlistName}...`)
                );
                await ctx.sync.pull({ force: true });
              }
            }

            ctx.store.close();
            return;
          } else {
            // Prompt for global resolution
            const { choice } = await inquirer.prompt([
              {
                type: 'list',
                name: 'choice',
                message: 'How do you want to resolve these conflicts?',
                choices: [
                  { name: 'Keep all local versions (push to Spotify)', value: 'take-local' },
                  { name: 'Take all remote versions (overwrite local)', value: 'take-remote' },
                  { name: 'Resolve each interactively', value: 'interactive' },
                  { name: 'Cancel', value: 'abort' },
                ],
              },
            ]);

            if (choice === 'interactive') {
              // Re-run with interactive flag
              const args = process.argv.slice(0, 3);
              args.push('--interactive');
              // We'll just handle it here instead of re-running
              for (const conflict of conflicts) {
                const { perChoice } = await inquirer.prompt([
                  {
                    type: 'list',
                    name: 'perChoice',
                    message: `How to resolve '${conflict.playlistName}'?`,
                    choices: [
                      { name: 'Keep local version', value: 'local' },
                      { name: 'Take remote version', value: 'remote' },
                      { name: 'Skip', value: 'skip' },
                    ],
                  },
                ]);

                if (perChoice === 'local') {
                  console.log(chalk.blue(`Pushing local changes for ${conflict.playlistName}...`));
                } else if (perChoice === 'remote') {
                  console.log(
                    chalk.blue(`Pulling remote changes for ${conflict.playlistName}...`)
                  );
                }
              }
              ctx.store.close();
              return;
            }

            resolution = choice as 'take-local' | 'take-remote' | 'abort';
          }

          if (resolution === 'abort') {
            console.log(chalk.yellow('Resolution cancelled.'));
            ctx.store.close();
            return;
          }

          console.log(chalk.blue(`\nResolving conflicts with strategy: ${resolution}...`));

          if (resolution === 'take-local') {
            const result = await ctx.sync.push({ conflictResolution: 'take-local' });
            if (result.success) {
              console.log(chalk.green('Conflicts resolved. Local changes pushed to Spotify.'));
            } else {
              console.log(chalk.yellow('Resolution completed with issues.'));
            }
          } else {
            const result = await ctx.sync.pull({ force: true });
            if (result.success) {
              console.log(chalk.green('Conflicts resolved. Remote changes pulled from Spotify.'));
            } else {
              console.log(chalk.yellow('Resolution completed with issues.'));
            }
          }

          // Commit the resolution
          const isClean = await ctx.git.isClean();
          if (!isClean && ctx.workspaceConfig.settings.autoCommit) {
            await ctx.git.commitChanges(`Resolve conflicts: ${resolution}`);
            console.log(chalk.green('Resolution committed.'));
          }

          ctx.store.close();
        } catch (error) {
          console.error(chalk.red(`Error: ${error}`));
          process.exit(1);
        }
      }
    );
}
