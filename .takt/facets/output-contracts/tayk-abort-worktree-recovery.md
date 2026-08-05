```markdown
# ABORT Worktree Recovery

## Worktree identity

- Absolute path: {git rev-parse --show-toplevel}
- HEAD: {git rev-parse HEAD}

## Preserved changes

### Staged

{files and diff stat, or `none`}

### Unstaged

{files and diff stat, or `none`}

### Untracked

{files, or `none`}

## Recovery procedure

1. `cd {Absolute path}`
2. `git status --short`
3. `git diff`
4. `git diff --cached`

## Safety warning

Do not remove this worktree or run destructive Git cleanup before the changes have been reviewed and recovered.
```
