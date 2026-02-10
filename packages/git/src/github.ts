import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type GitHubIssue = {
  number: number;
  title: string;
  body: string;
  labels: string[];
};

export async function getIssue(repo: string, issueNumber: number): Promise<GitHubIssue> {
  const { stdout } = await execFileAsync('gh', [
    'issue', 'view', String(issueNumber),
    '--repo', repo,
    '--json', 'number,title,body,labels',
  ]);

  const data = JSON.parse(stdout) as { number: number; title: string; body: string; labels: { name: string }[] };
  return {
    number: data.number,
    title: data.title,
    body: data.body,
    labels: data.labels.map(l => l.name),
  };
}

export async function createPullRequest(
  repo: string,
  title: string,
  body: string,
  branch: string,
  base = 'main',
): Promise<string> {
  const { stdout } = await execFileAsync('gh', [
    'pr', 'create',
    '--repo', repo,
    '--title', title,
    '--body', body,
    '--head', branch,
    '--base', base,
  ]);
  return stdout.trim();
}
