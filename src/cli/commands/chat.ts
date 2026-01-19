import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';
import { ChatbotOrchestrator } from '../../chatbot/orchestrator.js';

export function chatCommand(): Command {
  return new Command('chat')
    .description('Interactive chatbot for playlist management')
    .argument('[prompt]', 'Initial prompt for the chatbot')
    .option('--apply', 'Automatically apply the proposed changes')
    .option('--no-branch', 'Make changes directly without creating a branch')
    .action(async (prompt: string | undefined, options: { apply?: boolean; branch?: boolean }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        const chatbot = new ChatbotOrchestrator(
          ctx.spotify,
          ctx.serializer,
          ctx.git,
          ctx.store,
          ctx.workspacePath
        );

        console.log(chalk.blue.bold('\nSpotifyFS Chatbot'));
        console.log(chalk.gray('Ask me to help manage your playlists!\n'));
        console.log(chalk.gray('Examples:'));
        console.log(chalk.gray('  "Create a chill playlist with my favorite songs"'));
        console.log(chalk.gray('  "Add all bossa nova tracks to my Jazz playlist"'));
        console.log(chalk.gray('  "Remove duplicate tracks from all playlists"'));
        console.log(chalk.gray('\nType "exit" or "quit" to leave.\n'));

        const processPrompt = async (userPrompt: string) => {
          console.log(chalk.blue('\nProcessing your request...\n'));

          try {
            const result = await chatbot.processRequest(userPrompt, {
              createBranch: options.branch !== false,
              autoApply: options.apply,
            });

            console.log(chalk.cyan.bold('\n' + result.summary));

            if (result.changes.playlistsCreated > 0) {
              console.log(chalk.green(`  + ${result.changes.playlistsCreated} playlist(s) created`));
            }
            if (result.changes.playlistsModified > 0) {
              console.log(chalk.yellow(`  ~ ${result.changes.playlistsModified} playlist(s) modified`));
            }
            if (result.changes.tracksAdded > 0) {
              console.log(chalk.green(`  + ${result.changes.tracksAdded} track(s) added`));
            }
            if (result.changes.tracksRemoved > 0) {
              console.log(chalk.red(`  - ${result.changes.tracksRemoved} track(s) removed`));
            }

            if (result.branchName) {
              console.log(chalk.blue(`\nChanges are on branch: ${result.branchName}`));
              console.log(chalk.gray('To apply these changes:'));
              console.log(chalk.gray(`  spotifyfs apply ${result.branchName}`));
            }

            if (result.applied) {
              console.log(chalk.green('\nChanges have been applied to Spotify!'));
            }
          } catch (error) {
            console.error(chalk.red(`Error: ${error}`));
          }
        };

        // Handle initial prompt
        if (prompt) {
          await processPrompt(prompt);
          if (!options.apply) {
            ctx.store.close();
            return;
          }
        }

        // Interactive mode
        while (true) {
          const { userInput } = await inquirer.prompt([
            {
              type: 'input',
              name: 'userInput',
              message: chalk.green('You:'),
              prefix: '',
            },
          ]);

          const input = userInput.trim().toLowerCase();
          if (input === 'exit' || input === 'quit') {
            console.log(chalk.blue('\nGoodbye!\n'));
            break;
          }

          if (!input) continue;

          await processPrompt(userInput);
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });
}
