# Ice-Agent Git Rules

These rules apply specifically to the **Ice-Agent** project.

## Repository

The project repository is:

```
https://github.com/zcslack17858645276-del/Ice-Agent.git
```

The primary branch is:

```
main
```

The default remote is:

```
origin
```

## 1. Never blindly commit the entire project

Do **not** blindly run:

```
git add .
```

and immediately commit the result.

Before every commit, inspect the repository:

```
git status --short
```

Review all untracked and modified files before staging them.

Only commit files that belong to the Ice-Agent source project.

## 2. Never commit build artifacts

Ice-Agent may generate a large number of files when running development or Tauri builds.

These generated files must **not** be committed to GitHub.

In particular, do not commit:

```
node_modules/
dist/
src-tauri/target/
target/
```

Tauri build artifacts must also not be committed, including files such as:

```
*.exe
*.msi
*.nsis.zip
```

and other generated installer or binary artifacts.

The local build output must remain available locally when needed, but it should not be included in Git commits.

## 3. Keep `.gitignore` up to date

The project root must contain an appropriate `.gitignore`.

At minimum, generated files and local-only files should be excluded.

Typical entries include:

```
node_modules/
dist/
src-tauri/target/
target/

*.exe
*.msi
*.nsis.zip

.env
.env.*
!.env.example

*.log

.vscode/
.idea/

.DS_Store
Thumbs.db
```

Do not use overly broad rules that could accidentally exclude Ice-Agent source code or required configuration files.

## 4. Important project files must remain tracked

The following types of files should normally be committed when they are part of the project:

```
src/
src-tauri/src/
src-tauri/icons/
src-tauri/Cargo.toml
src-tauri/Cargo.lock
src-tauri/tauri.conf.json
package.json
package-lock.json
vite.config.*
README.md
PLAN.md
AGENTS.md
RULES.md
GIT_RULES.md
```

The exact file list may evolve as the project develops.

If a new source file, configuration file, documentation file, or other important project file is created, do not exclude it simply because it is new or unfamiliar.

## 5. Do not commit secrets

Never commit:

```
API keys
access tokens
passwords
private keys
.env files containing real credentials
local credentials
```

If configuration examples are needed, use placeholders:

```
.env.example
```

Never put real credentials into the repository.

## 6. Check whether generated files are already tracked

If a build directory or generated file was previously committed, adding it to `.gitignore` is not enough.

Check whether it is already tracked:

```
git ls-files src-tauri/target
```

If necessary, remove it from Git tracking without deleting the local files:

```
git rm -r --cached src-tauri/target
```

Do not physically delete local build files unless explicitly requested.

## 7. Review staged files before committing

After selecting files for the commit, always inspect the staged changes:

```
git status
git diff --cached --stat
```

For important commits, also inspect:

```
git diff --cached
```

Before committing, verify that:

- Ice-Agent source code is included.
- Required configuration files are included.
- Required documentation is included.
- `node_modules/` is excluded.
- `dist/` is excluded.
- `src-tauri/target/` is excluded.
- Tauri build artifacts are excluded.
- Secrets and credentials are excluded.
- Unrelated files are excluded.

## 8. Commit messages

Use clear and meaningful commit messages.

Examples:

```
git commit -m "feat: complete phase0"
git commit -m "feat: add desktop assistant foundation"
git commit -m "fix: resolve application startup issue"
git commit -m "docs: update development documentation"
```

Avoid meaningless messages such as:

```
update
test
changes
stuff
```

## 9. Push only after the commit is verified

Before pushing, verify the current branch:

```
git branch --show-current
```

For the Ice-Agent project, the main development branch is:

```
main
```

Verify the remote when necessary:

```
git remote -v
```

The expected remote repository is:

```
https://github.com/zcslack17858645276-del/Ice-Agent.git
```

Push to the main branch with:

```
git push -u origin main
```

After the upstream branch has been established, use:

```
git push
```

Do **not** use force push:

```
git push --force
```

or:

```
git push -f
```

unless explicitly authorized.

## 10. Authentication errors

If Git reports an authentication error such as:

```
could not read Username for 'https://github.com'
```

or:

```
failed to execute prompt script
```

do not modify the project or Git history to work around the problem.

Report the authentication problem.

Once GitHub authentication has been fixed, retry:

```
git push -u origin main
```

## 11. "Everything up-to-date" does not mean all local files were uploaded

If Git reports:

```
Everything up-to-date
```

this only means that the commits being pushed already exist on the remote branch.

It does **not** mean that all local files have been uploaded.

Untracked files are not part of a commit.

The required workflow is:

```
Project files
     ↓
git add
     ↓
Staged files
     ↓
git commit
     ↓
Commit
     ↓
git push
     ↓
GitHub
```

Therefore, always check:

```
git status
```

before assuming that the repository is fully synchronized.

## 12. Standard Ice-Agent workflow

When asked to commit and push Ice-Agent changes, follow this procedure:

```
# Check repository state
git status --short

# Check current branch
git branch --show-current

# Review .gitignore
# Update it if necessary.

# Stage only appropriate project files
git add <files>

# Review staged changes
git status
git diff --cached --stat

# Commit
git commit -m "<appropriate commit message>"

# Push
git push
```

For the initial push of the `main` branch:

```
git push -u origin main
```

## 13. Important rule for Tauri builds

Running:

```
npm run tauri build
```

may generate many files under:

```
src-tauri/target/
```

These files are **local build outputs**, not project source files.

Do not commit them.

The purpose of the Git repository is to preserve the Ice-Agent source code and the files required to reproduce the application, rather than storing local compiler output or generated binaries.

## 14. Final verification

After pushing, verify:

```
git status
```

The working tree should contain only intentional local changes or ignored build artifacts.

Then verify that the latest commit exists on the remote:

```
git log -1 --oneline
```

and:

```
git status -sb
```

Do not claim that the project was successfully pushed unless the push command actually completed successfully.

## Core Principle

For Ice-Agent:

> **Commit the project source and required project files. Never commit local build output, generated artifacts, dependencies, secrets, or unrelated files.**

When there is uncertainty about whether a file should be committed, inspect the file and its purpose first rather than blindly adding or deleting it.