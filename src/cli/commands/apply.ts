import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';

export function applyCommand(): Command {
  return new Command('apply')
    .description('Switch to a branch and push its changes to Spotify')
    .argument('[branch]', 'Branch name to apply (defaults to current branch)')
    .option('--dry-run', 'Show what would be changed without making changes')
    .option('--yes', 'Skip confirmation prompt')
    .option('--return', 'Return to original branch after applying')
    .option('--merge', 'Merge the branch into main after applying')
    .option('--delete', 'Delete the branch after applying (implies --return)')
    .action(
      async (
        branchName: string | undefined,
        options: { dryRun?: boolean; yes?: boolean; return?: boolean; merge?: boolean; delete?: boolean }
      ) => {
        try {
          const clientId = getClientId();
          const ctx = await createContext(clientId);

          const currentBranch = await ctx.git.getCurrentBranch();
          const targetBranch = branchName || currentBranch;

          // Check if branch exists (if not current)
          if (branchName && branchName !== currentBranch) {
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

            console.log(chalk.blue(`Switching to branch '${branchName}'...`));
            await ctx.git.checkout(branchName);
          }

          console.log(chalk.blue(`\nApplying '${targetBranch}' to Spotify...`));

          // Show diff
          const diffs = await ctx.sync.diff();
          if (diffs.length === 0) {
            console.log(chalk.green('No changes to apply - Spotify is already in sync.'));
            ctx.store.close();
            ctx.libraryDb.close();
            return;
          }

          console.log(chalk.blue('\nChanges to apply:'));
          for (const diff of diffs) {
            console.log(`\n  ${chalk.cyan(diff.playlistName)}`);
            if (diff.additions.length > 0) {
              console.log(chalk.green(`    + ${diff.additions.length} tracks to add`));
            }
            if (diff.removals.length > 0) {
              console.log(chalk.red(`    - ${diff.removals.length} tracks to remove`));
            }
            if (diff.reorderNeeded) {
              console.log(chalk.yellow(`    ↕ tracks will be reordered`));
            }
          }

          if (options.dryRun) {
            console.log(chalk.yellow('\n[Dry run - no changes made]'));
            if (branchName && branchName !== currentBranch) {
              await ctx.git.checkout(currentBranch);
            }
            ctx.store.close();
            ctx.libraryDb.close();
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
              if (branchName && branchName !== currentBranch) {
                await ctx.git.checkout(currentBranch);
              }
              ctx.store.close();
              ctx.libraryDb.close();
              return;
            }
          }

          // Push to Spotify
          console.log(chalk.blue('\nPushing to Spotify...'));
          const result = await ctx.sync.push();

          if (result.success) {
            console.log(chalk.green('\nSuccessfully applied to Spotify!'));
            console.log(chalk.gray(`Your Spotify now reflects branch '${targetBranch}'`));

            // Update proposal status if this is a proposal branch
            const proposal = ctx.store.getProposalByBranch(targetBranch);
            if (proposal) {
              ctx.store.updateProposalStatus(proposal.id, 'applied');
            }

            // Handle post-apply actions
            const shouldReturn = options.return || options.delete || options.merge;

            if (options.merge) {
              await ctx.git.checkout(currentBranch);
              await ctx.git.mergeBranch(targetBranch, `Merge ${targetBranch}: applied to Spotify`);
              console.log(chalk.green(`Merged '${targetBranch}' into '${currentBranch}'`));
            }

            if (options.delete) {
              if (!options.merge) {
                await ctx.git.checkout(currentBranch);
              }
              await ctx.git.deleteBranch(targetBranch, true);
              console.log(chalk.green(`Deleted branch '${targetBranch}'`));
            } else if (shouldReturn && !options.merge) {
              await ctx.git.checkout(currentBranch);
              console.log(chalk.gray(`Returned to branch '${currentBranch}'`));
            } else if (!shouldReturn && branchName) {
              console.log(chalk.gray(`Staying on branch '${targetBranch}'`));
            }
          } else {
            console.log(chalk.yellow('\nApply completed with issues.'));
            if (result.failedOperations.length > 0) {
              for (const { operation, error } of result.failedOperations) {
                console.log(chalk.red(`  - ${operation.type}: ${error}`));
              }
            }
            // Return to original branch on failure
            if (branchName && branchName !== currentBranch) {
              await ctx.git.checkout(currentBranch);
            }
          }

          ctx.store.close();
          ctx.libraryDb.close();
        } catch (error) {
          console.error(chalk.red(`Error: ${error}`));
          process.exit(1);
        }
      }
    );
}
