# Security Policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Use GitHub's [private vulnerability reporting](https://docs.github.com/code-security/security-advisories/guidance-on-reporting-and-writing/privately-reporting-a-security-vulnerability)
on this repository — the **Security** tab, then **Report a vulnerability**. That keeps
the report private until a fix is available.

Expect an acknowledgement within a few days.

## What this bot holds

Anyone running Stitch is trusting it with credentials that are worth protecting:

- **`DISCORD_TOKEN`** — full control of the bot account, including reading every channel
  it can see.
- **`YOUTUBE_REFRESH_TOKEN`** — long-lived access to upload to, edit, and delete videos
  on the connected YouTube channel.

Both live in `.env`, which is gitignored along with `.env.*` variants. The most common
way these leak is not a commit of `.env` itself but a `.env.backup` or `.env.prod`
created on a server while debugging — hence the wildcard.

The published Docker image never contains `.env`; the environment is supplied at
runtime.

## Scope

Reports about the following are in scope:

- Anything that discloses those tokens, or the contents of the data volume.
- Command or filter injection through Discord-controlled input — message content,
  filenames, display names, or URLs. These reach `ffmpeg` and `yt-dlp`, so they are the
  most interesting attack surface in the project.
- Authorization flaws in the slash commands or the veto reaction, such as a route that
  ignores `ADMIN_USER_IDS`.
- Path traversal in ingest that writes outside the data directory.

Out of scope: vulnerabilities in YouTube, Discord, or ffmpeg themselves — report those
upstream — and anything requiring an attacker who already has shell access to the host.
