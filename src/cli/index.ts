#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import {
  initCommand,
  authCommand,
  pullCommand,
  pushCommand,
  statusCommand,
  diffCommand,
  watchCommand,
  branchCommand,
  applyCommand,
  resolveCommand,
  chatCommand,
} from './commands/index.js';

const program = new Command();

program
  .name('spotifyfs')
  .description(
    chalk.green('SpotifyFS') +
      ' - Local folder ↔ Spotify playlist sync with Git integration'
  )
  .version('1.0.0');

// Add all commands
program.addCommand(initCommand());
program.addCommand(authCommand());
program.addCommand(pullCommand());
program.addCommand(pushCommand());
program.addCommand(statusCommand());
program.addCommand(diffCommand());
program.addCommand(watchCommand());
program.addCommand(branchCommand());
program.addCommand(applyCommand());
program.addCommand(resolveCommand());
program.addCommand(chatCommand());

// Add global error handling
program.hook('preAction', () => {
  // Validate SPOTIFY_CLIENT_ID for commands that need it
  const commandsNeedingAuth = [
    'pull',
    'push',
    'status',
    'diff',
    'watch',
    'apply',
    'resolve',
    'chat',
  ];

  const currentCommand = program.args[0];
  if (
    commandsNeedingAuth.includes(currentCommand) &&
    !process.env.SPOTIFY_CLIENT_ID
  ) {
    console.error(
      chalk.red(
        'Error: SPOTIFY_CLIENT_ID environment variable is required.\n' +
          'Create a Spotify app at https://developer.spotify.com/dashboard'
      )
    );
    process.exit(1);
  }
});

// Parse and execute
program.parse();
