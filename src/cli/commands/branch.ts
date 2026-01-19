import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createContext, getClientId } from '../context.js';

export function branchCommand(): Command {
  const cmd = new Command('branch')
    .description('Manage Git branches for SpotifyFS');

  cmd
    .command('list')
    .description('List all branches')
    .option('--proposals', 'Show only proposal branches')
    .option('--conflicts', 'Show only conflict branches')
    .action(async (options: { proposals?: boolean; conflicts?: boolean }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        let branches;
        if (options.proposals) {
          branches = await ctx.git.getProposalBranches();
          console.log(chalk.blue('Proposal branches:'));
        } else if (options.conflicts) {
          branches = await ctx.git.getConflictBranches();
          console.log(chalk.blue('Conflict branches:'));
        } else {
          branches = await ctx.git.getBranches();
          console.log(chalk.blue('All branches:'));
        }

        if (branches.length === 0) {
          console.log(chalk.gray('  (none)'));
        } else {
          for (const branch of branches) {
            const prefix = branch.isCurrent ? chalk.green('* ') : '  ';
            const name = branch.isCurrent
              ? chalk.green.bold(branch.name)
              : branch.name;
            console.log(`${prefix}${name}`);
          }
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  cmd
    .command('checkout <branch>')
    .description('Switch to a branch')
    .action(async (branchName: string) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        // Check for uncommitted changes
        const isClean = await ctx.git.isClean();
        if (!isClean) {
          const { stash } = await inquirer.prompt([
            {
              type: 'confirm',
              name: 'stash',
              message: 'You have uncommitted changes. Stash them before switching?',
              default: true,
            },
          ]);

          if (stash) {
            await ctx.git.stash();
            console.log(chalk.gray('Changes stashed.'));
          } else {
            console.log(chalk.yellow('Checkout cancelled.'));
            ctx.store.close();
            return;
          }
        }

        await ctx.git.checkout(branchName);
        console.log(chalk.green(`Switched to branch '${branchName}'`));

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  cmd
    .command('create <name>')
    .description('Create a new branch')
    .action(async (name: string) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        await ctx.git.createBranch(name);
        console.log(chalk.green(`Created and switched to branch '${name}'`));

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  cmd
    .command('delete <name>')
    .description('Delete a branch')
    .option('--force', 'Force delete even if not merged')
    .action(async (name: string, options: { force?: boolean }) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        const currentBranch = await ctx.git.getCurrentBranch();
        if (name === currentBranch) {
          console.error(chalk.red('Cannot delete the current branch.'));
          ctx.store.close();
          process.exit(1);
        }

        await ctx.git.deleteBranch(name, options.force);
        console.log(chalk.green(`Deleted branch '${name}'`));

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  cmd
    .command('diff [branch]')
    .description('Show diff between current branch and another branch')
    .action(async (branchName?: string) => {
      try {
        const clientId = getClientId();
        const ctx = await createContext(clientId);

        const diff = await ctx.git.getDiff(branchName || 'main');
        if (diff) {
          console.log(diff);
        } else {
          console.log(chalk.gray('No differences.'));
        }

        ctx.store.close();
      } catch (error) {
        console.error(chalk.red(`Error: ${error}`));
        process.exit(1);
      }
    });

  return cmd;
}
