import path from 'node:path';

// Agent worktrees live in the .claude folder of a checkout, each with a full copy of the sources, so the dev server must not
// watch them. Only the .claude folder of this project root is skipped: a server started inside a worktree has its own root
// under .claude/worktrees, and a glob such as **/.claude/** would make it skip every one of its own files.
export function createWatchIgnore(projectRoot) {
  const agentFolder = path.resolve(projectRoot, '.claude');
  return changedPath => {
    const resolvedPath = path.resolve(changedPath);
    return resolvedPath === agentFolder || resolvedPath.startsWith(agentFolder + path.sep);
  };
}
