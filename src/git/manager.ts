import simpleGit, { SimpleGit, StatusResult } from 'simple-git';
import { join, relative } from 'path';
import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs';
import type { GitBranch, GitCommit, ProposalMetadata } from '../types/index.js';
import { generateBranchName } from '../utils/index.js';

export class GitManager {
  private git: SimpleGit;
  private workspacePath: string;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
    this.git = simpleGit(workspacePath);
  }

  async isInitialized(): Promise<boolean> {
    try {
      await this.git.status();
      return true;
    } catch {
      return false;
    }
  }

  async initialize(): Promise<void> {
    const gitDir = join(this.workspacePath, '.git');
    if (!existsSync(gitDir)) {
      await this.git.init();

      // Create .gitignore
      const gitignorePath = join(this.workspacePath, '.gitignore');
      const gitignoreContent = `# SpotifyFS
.spotifyfs/tokens.json
.spotifyfs/state.db
.spotifyfs/state.db-wal
.spotifyfs/state.db-shm
.spotifyfs/logs/
node_modules/
*.log
.DS_Store
`;
      writeFileSync(gitignorePath, gitignoreContent);

      // Initial commit
      await this.git.add('.');
      await this.git.commit('Initial SpotifyFS workspace');
    }
  }

  async status(): Promise<StatusResult> {
    return this.git.status();
  }

  async isClean(): Promise<boolean> {
    const status = await this.status();
    return status.isClean();
  }

  async getCurrentBranch(): Promise<string> {
    const status = await this.status();
    return status.current || 'main';
  }

  async getBranches(): Promise<GitBranch[]> {
    const branchSummary = await this.git.branch();
    const branches: GitBranch[] = [];

    for (const [name, data] of Object.entries(branchSummary.branches)) {
      branches.push({
        name,
        isCurrent: data.current,
        isRemote: name.startsWith('remotes/'),
        lastCommit: data.commit,
      });
    }

    return branches;
  }

  async createBranch(name: string): Promise<void> {
    await this.git.checkoutLocalBranch(name);
  }

  async checkout(branchName: string): Promise<void> {
    await this.git.checkout(branchName);
  }

  async createProposalBranch(description: string): Promise<string> {
    const branchName = generateBranchName('bot', description);
    await this.createBranch(branchName);
    return branchName;
  }

  async commitChanges(message: string): Promise<string> {
    await this.git.add('.');
    const result = await this.git.commit(message);
    return result.commit;
  }

  async commitWithMetadata(
    message: string,
    metadata: ProposalMetadata
  ): Promise<string> {
    // Save proposal metadata
    const proposalsDir = join(this.workspacePath, '.spotifyfs', 'proposals');
    mkdirSync(proposalsDir, { recursive: true });

    const metadataPath = join(proposalsDir, `${metadata.id}.json`);
    writeFileSync(metadataPath, JSON.stringify(metadata, null, 2));

    await this.git.add('.');
    const result = await this.git.commit(message);
    return result.commit;
  }

  async getRecentCommits(count = 10): Promise<GitCommit[]> {
    const log = await this.git.log({ maxCount: count });
    return log.all.map((entry) => ({
      hash: entry.hash,
      message: entry.message,
      author: entry.author_name,
      date: entry.date,
    }));
  }

  async getDiff(fromRef?: string, toRef?: string): Promise<string> {
    if (fromRef && toRef) {
      return this.git.diff([fromRef, toRef]);
    } else if (fromRef) {
      return this.git.diff([fromRef]);
    } else {
      return this.git.diff();
    }
  }

  async getStagedDiff(): Promise<string> {
    return this.git.diff(['--cached']);
  }

  async getChangedFiles(): Promise<string[]> {
    const status = await this.status();
    return [
      ...status.modified,
      ...status.created,
      ...status.deleted,
      ...status.not_added,
    ];
  }

  async mergeBranch(branchName: string, message?: string): Promise<void> {
    await this.git.merge([branchName, '-m', message || `Merge ${branchName}`]);
  }

  async deleteBranch(branchName: string, force = false): Promise<void> {
    if (force) {
      await this.git.deleteLocalBranch(branchName, true);
    } else {
      await this.git.deleteLocalBranch(branchName);
    }
  }

  async stash(): Promise<void> {
    await this.git.stash();
  }

  async stashPop(): Promise<void> {
    await this.git.stash(['pop']);
  }

  async reset(mode: 'soft' | 'hard' | 'mixed' = 'mixed', ref = 'HEAD'): Promise<void> {
    await this.git.reset([`--${mode}`, ref]);
  }

  async getProposalBranches(): Promise<GitBranch[]> {
    const branches = await this.getBranches();
    return branches.filter((b) => b.name.startsWith('bot/'));
  }

  async getConflictBranches(): Promise<GitBranch[]> {
    const branches = await this.getBranches();
    return branches.filter((b) => b.name.startsWith('conflict/'));
  }

  async createConflictBranch(playlistName: string): Promise<string> {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const branchName = `conflict/${playlistName}-${timestamp}`;
    await this.createBranch(branchName);
    return branchName;
  }

  getProposalMetadata(proposalId: string): ProposalMetadata | null {
    const metadataPath = join(
      this.workspacePath,
      '.spotifyfs',
      'proposals',
      `${proposalId}.json`
    );

    if (!existsSync(metadataPath)) {
      return null;
    }

    return JSON.parse(readFileSync(metadataPath, 'utf-8')) as ProposalMetadata;
  }

  async cherryPick(commitHash: string): Promise<void> {
    await this.git.raw(['cherry-pick', commitHash]);
  }

  async revert(commitHash: string): Promise<void> {
    await this.git.revert(commitHash);
  }

  async getFileAtRef(filePath: string, ref: string): Promise<string | null> {
    try {
      const relativePath = relative(this.workspacePath, filePath);
      const content = await this.git.show([`${ref}:${relativePath}`]);
      return content;
    } catch {
      return null;
    }
  }
}
