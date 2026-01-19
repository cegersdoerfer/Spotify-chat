import { Command } from 'commander';
import chalk from 'chalk';
import { createContext, getClientId } from '../context.js';

export function diffCommand(): Command {
  return new Command('diff')
    .description('Show differences between local workspace and Spotify')
    .option('--json', 'Output as JSON')
    .action(async (options: { json?: boolean }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        console.log(chalk.blue('Computing differences...\n'));

        const diffs = await ctx.sync.diff();

        if (options.json) {
          console.log(JSON.stringify(diffs, null, 2));
          ctx.store.close();
          return;
        }

        if (diffs.length === 0) {
          console.log(chalk.green('No differences found. Local and remote are in sync.'));
          ctx.store.close();
          return;
        }

        for (const diff of diffs) {
          console.log(
            chalk.cyan.bold(`\n${diff.playlistName}`) +
              chalk.gray(` (${diff.playlistId})`)
          );

          if (diff.hasConflict) {
            console.log(chalk.red.bold('  CONFLICT: Both local and remote have changed!'));
            if (diff.conflictDetails) {
              console.log(
                chalk.yellow(
                  `    Added locally:   ${diff.conflictDetails.addedLocally.length} tracks`
                )
              );
              console.log(
                chalk.yellow(
                  `    Removed locally: ${diff.conflictDetails.removedLocally.length} tracks`
                )
              );
            }
          }

          if (diff.additions.length > 0) {
            console.log(chalk.green(`  + Add ${diff.additions.length} tracks:`));
            for (const trackId of diff.additions.slice(0, 5)) {
              console.log(chalk.green(`      ${trackId}`));
            }
            if (diff.additions.length > 5) {
              console.log(chalk.green(`      ... and ${diff.additions.length - 5} more`));
            }
          }

          if (diff.removals.length > 0) {
            console.log(chalk.red(`  - Remove ${diff.removals.length} tracks:`));
            for (const trackId of diff.removals.slice(0, 5)) {
              console.log(chalk.red(`      ${trackId}`));
            }
            if (diff.removals.length > 5) {
              console.log(chalk.red(`      ... and ${diff.removals.length - 5} more`));
            }
          }

          if (diff.reorderNeeded && diff.additions.length === 0 && diff.removals.length === 0) {
            console.log(chalk.yellow('  ~ Tracks need to be reordered'));
          }
        }

        const conflicts = diffs.filter((d) => d.hasConflict);
        if (conflicts.length > 0) {
          console.log(
            chalk.red(
              `\n${conflicts.length} playlist(s) have conflicts that need resolution.`
            )
          );
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
