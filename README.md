# JJS Bot

Works in any number of servers. Each server has its own settings, prefixes,
command roles, warnings, blacklist cases, and logs (all keyed by server ID).

Railway setup:
1. Push this folder to GitHub, then New Project -> Deploy from GitHub repo.
2. Variables: DISCORD_TOKEN, CLIENT_ID, DB_PATH=/data/jjsbot.db
   (GUILD_ID is no longer needed. Set it once only to clear old single-server commands.)
3. Settings -> Volumes -> add a volume mounted at /data
4. Discord Developer Portal -> Bot: enable Server Members Intent and Message Content Intent.

Adding it to more servers:
1. Developer Portal -> Installation (or OAuth2 -> URL Generator): scopes `bot` and
   `applications.commands`, with the permissions the bot needs (Manage Roles, Kick/Ban,
   Moderate Members, View Audit Log, Manage Channels, Manage Messages, etc.).
2. If the bot should be invitable by others, make sure "Public Bot" is on in the Bot tab.
3. Open the invite link in each server, then run `/setup` there (needs Administrator).

Slash commands are registered globally, so they show up in every server automatically.
Note: after the very first global registration, Discord can take a few minutes to show them.
