# JJS Bot

Railway setup:
1. Push this folder to GitHub, then New Project -> Deploy from GitHub repo.
2. Variables: DISCORD_TOKEN, CLIENT_ID, GUILD_ID, DB_PATH=/data/jjsbot.db
3. Settings -> Volumes -> add a volume mounted at /data
4. Discord Developer Portal -> Bot: enable Server Members Intent and Message Content Intent.
