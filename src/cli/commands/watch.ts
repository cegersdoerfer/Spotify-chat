import { Command } from 'commander';
import chalk from 'chalk';
import { createContext, getClientId } from '../context.js';
import { FilesystemWatcher } from '../../filesystem/index.js';
import type { DomainEvent } from '../../types/index.js';

export function watchCommand(): Command {
  return new Command('watch')
    .description('Watch for local changes and sync automatically')
    .option('--no-push', 'Watch for changes but do not push automatically')
    .option('--poll-interval <ms>', 'Interval for polling Spotify (in milliseconds)', '300000')
    .action(async (options: { push?: boolean; pollInterval?: string }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        const pollInterval = parseInt(options.pollInterval || '300000', 10);

        console.log(chalk.blue('Starting watch mode...'));
        console.log(chalk.gray(`  Workspace: ${ctx.workspacePath}`));
        console.log(chalk.gray(`  Auto-push: ${options.push !== false ? 'enabled' : 'disabled'}`));
        console.log(chalk.gray(`  Poll interval: ${pollInterval / 1000}s`));
        console.log(chalk.gray('\nPress Ctrl+C to stop.\n'));

        const watcher = new FilesystemWatcher(ctx.workspacePath);

        // Debounce push operations
        let pushTimer: NodeJS.Timeout | null = null;
        const schedulePush = () => {
          if (pushTimer) {
            clearTimeout(pushTimer);
          }
          pushTimer = setTimeout(async () => {
            try {
              console.log(chalk.blue('\nPushing changes to Spotify...'));
              const result = await ctx.sync.push();
              if (result.success) {
                console.log(chalk.green('Push completed successfully.'));
              } else {
                console.log(chalk.yellow('Push completed with issues.'));
              }
            } catch (error) {
              console.error(chalk.red(`Push error: ${error}`));
            }
          }, 2000);
        };

        watcher.on('event', (event: DomainEvent) => {
          const timestamp = new Date().toLocaleTimeString();
          switch (event.type) {
            case 'PlaylistCreated':
              console.log(chalk.green(`[${timestamp}] Playlist created: ${event.name}`));
              break;
            case 'PlaylistDeleted':
              console.log(chalk.red(`[${timestamp}] Playlist deleted: ${event.playlistId}`));
              break;
            case 'PlaylistRenamed':
              console.log(
                chalk.yellow(
                  `[${timestamp}] Playlist renamed: ${event.oldName} -> ${event.newName}`
                )
              );
              break;
            case 'TrackAdded':
              console.log(
                chalk.green(
                  `[${timestamp}] Track added to ${event.playlistId}: ${event.trackId}`
                )
              );
              break;
            case 'TrackRemoved':
              console.log(
                chalk.red(
                  `[${timestamp}] Track removed from ${event.playlistId}: ${event.trackId}`
                )
              );
              break;
            case 'TrackReordered':
              console.log(
                chalk.yellow(
                  `[${timestamp}] Track reordered in ${event.playlistId}: ${event.trackId}`
                )
              );
              break;
            case 'PlaylistMetadataChanged':
              console.log(
                chalk.yellow(`[${timestamp}] Playlist metadata changed: ${event.playlistId}`)
              );
              break;
          }

          if (options.push !== false) {
            schedulePush();
          }
        });

        watcher.on('error', (error: Error) => {
          console.error(chalk.red(`Watcher error: ${error.message}`));
        });

        watcher.on('ready', () => {
          console.log(chalk.green('Watcher ready.'));
        });

        watcher.start();

        // Poll for remote changes
        let pollTimer: NodeJS.Timeout;
        const pollRemote = async () => {
          try {
            console.log(chalk.gray('\nPolling Spotify for changes...'));
            const result = await ctx.sync.pull({ dryRun: true });
            if (result.appliedOperations.length > 0) {
              console.log(
                chalk.yellow(
                  `Remote changes detected. Run "spotifyfs pull" to update locally.`
                )
              );
            } else {
              console.log(chalk.gray('No remote changes.'));
            }
          } catch (error) {
            console.error(chalk.red(`Poll error: ${error}`));
          }
          pollTimer = setTimeout(pollRemote, pollInterval);
        };

        // Start polling after initial delay
        pollTimer = setTimeout(pollRemote, pollInterval);

        // Handle shutdown
        const shutdown = () => {
          console.log(chalk.blue('\nShutting down...'));
          watcher.stop();
          clearTimeout(pollTimer);
          if (pushTimer) clearTimeout(pushTimer);
          ctx.store.close();
          process.exit(0);
        };

        process.on('SIGINT', shutdown);
        process.on('SIGTERM', shutdown);
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
