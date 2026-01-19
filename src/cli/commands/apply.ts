import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';

export function applyCommand(): Command {
  return new Command('apply')
    .description('Apply changes from a branch to Spotify')
    .argument('<branch>', 'Branch name to apply')
    .option('--dry-run', 'Show what would be changed without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .option('--merge', 'Merge the branch into main after applying')
    .option('--delete', 'Delete the branch after applying')
    .action(
      async (
        branchName: string,
        options: { dryRun?: boolean; yes?: boolean; merge?: boolean; delete?: boolean }
      ) => {
        try {
          const clientId = getClientId();
          const ctx = await createContext(clientId);

          const currentBranch = await ctx.git.getCurrentBranch();

          // Check if branch exists
          const branches = await ctx.git.getBranches();
          const branch = branches.find((b) => b.name === branchName);
          if (!branch) {
            console.error(chalk.red(`Branch '${branchName}' not found.`));
            ctx.store.close();
            process.exit(1);
          }

          // Check for uncommitted changes
          const isClean = await ctx.git.isClean();
          if (!isClean) {
            console.error(
              chalk.red('You have uncommitted changes. Commit or stash them first.')
            );
            ctx.store.close();
            process.exit(1);
          }

          console.log(chalk.blue(`Applying changes from branch '${branchName}'...`));

          // Switch to the branch
          await ctx.git.checkout(branchName);

          // Show diff
          const diffs = await ctx.sync.diff();
          if (diffs.length === 0) {
            console.log(chalk.green('No changes to apply.'));
            await ctx.git.checkout(currentBranch);
            ctx.store.close();
            return;
          }

          console.log(chalk.blue('\nChanges to apply:'));
          for (const diff of diffs) {
            console.log(`\n  ${chalk.cyan(diff.playlistName)}`);
            if (diff.additions.length > 0) {
              console.log(chalk.green(`    + ${diff.additions.length} tracks`));
            }
            if (diff.removals.length > 0) {
              console.log(chalk.red(`    - ${diff.removals.length} tracks`));
            }
          }

          if (options.dryRun) {
            console.log(chalk.yellow('\n[Dry run - no changes made]'));
            await ctx.git.checkout(currentBranch);
            ctx.store.close();
            return;
          }

          // Confirm
          if (!options.yes) {
            const { proceed } = await inquirer.prompt([
              {
                type: 'confirm',
                name: 'proceed',
                message: 'Apply these changes to Spotify?',
                default: true,
              },
            ]);

            if (!proceed) {
              console.log(chalk.yellow('Apply cancelled.'));
              await ctx.git.checkout(currentBranch);
              ctx.store.close();
              return;
            }
          }

          // Push to Spotify
          console.log(chalk.blue('\nPushing to Spotify...'));
          const result = await ctx.sync.push();

          if (result.success) {
            console.log(chalk.green('Successfully applied to Spotify!'));

            // Update proposal status if this is a proposal branch
            const proposal = ctx.store.getProposalByBranch(branchName);
            if (proposal) {
              ctx.store.updateProposalStatus(proposal.id, 'applied');
            }

            // Merge if requested
            if (options.merge) {
              await ctx.git.checkout(currentBranch);
              await ctx.git.mergeBranch(branchName, `Merge ${branchName}: applied to Spotify`);
              console.log(chalk.green(`Merged '${branchName}' into '${currentBranch}'`));
            }

            // Delete if requested
            if (options.delete) {
              if (!options.merge) {
                await ctx.git.checkout(currentBranch);
              }
              await ctx.git.deleteBranch(branchName, true);
              console.log(chalk.green(`Deleted branch '${branchName}'`));
            } else {
              await ctx.git.checkout(currentBranch);
            }
          } else {
            console.log(chalk.yellow('Apply completed with issues.'));
            if (result.failedOperations.length > 0) {
              for (const { operation, error } of result.failedOperations) {
                console.log(chalk.red(`  - ${operation.type}: ${error}`));
              }
            }
            await ctx.git.checkout(currentBranch);
          }

          ctx.store.close();
        } catch (error) {
          console.error(chalk.red(`Error: ${error}`));
          process.exit(1);
        }
      }
    );
}
