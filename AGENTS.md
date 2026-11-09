# Agent Harbor contributor instructions

- Read README.md and docs/architecture.md before changing execution behavior.
- Keep the TypeScript implementation small and readable, with comments explaining ownership, lifecycle and cancellation.
- Use the native Claude SDK loop; do not replace its tools with a custom Agent loop.
- Hold the session lock for the entire conversation. Confirm old containers are stopped before creating another writer for the same workspace.
- Normal turns and completed native user interrupts may retain the environment. Task timeout, interrupt timeout, failure and environment close require confirmed container cleanup. Unknown engine state must block reuse.
- Keep credentials, session files, diagnostic output and machine-specific configuration out of Git. Use .env.example for placeholders and var/ for generated data.
- Run npm test, npm run check and npm run audit:public for relevant changes. Docker verification is a separate layer; a local model fixture does not prove real-model quality.
- If AGENTS.local.md exists, read its additional local instructions. It is not part of the public repository.

## Git workflow

- Develop and commit on `main`; do not create version or feature branches unless the user explicitly changes this policy.
- Write commit titles as Conventional Commits, using `type(scope): description` with an optional scope. Describe the change in the title and refer to the commit by hash when reporting it.
- Significant, validated version changes may receive an annotated Semantic Versioning tag in the form `MAJOR.MINOR.PATCH`, such as `0.10.0`. Keep existing tags on their original commits.
- A milestone tag is separate from publishing a package or pushing to a remote.

## Product documentation

- Write public docs for a first-time user: purpose, prerequisites, steps, expected result and related help.
- Organize the site by product questions and user tasks. Keep member usage separate from administrator setup.
- Do not mix migration history, development plans, source tours or test evidence into product guides. Keep engineering material in repository docs excluded from the site.
- Use the VitePress default documentation theme, following the kb-metabolism reference. Configure its built-in homepage, navigation, sidebar, search and page outline; do not add custom CSS, theme layouts or client components.
- Check generated links and both desktop and mobile reading; simplify content when long tables overflow instead of adding styling.
- When a delivery changes user-visible behavior, UI steps, defaults or configuration, review and update the related product guides in the same change before completing the task.
- Pushes to `main` that change `docs/**` or the Pages workflow publish the documentation automatically. For an authorized push, follow the Pages run to completion and check the live pages before reporting documentation delivery complete.
- Local commits and private workspace task records do not publish a site. Keep task records private; a task-only or source-only change does not require a documentation deployment.
