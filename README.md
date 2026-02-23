# MeridusBot

A standalone Discord bot that receives GitHub events via webhooks and sends rich embed notifications to Discord channels. Also communicates with projectmeridus (website) via HTTP APIs.

## Features

- **Discord Slash Commands**: `/ping`, `/status`, `/subscribe`, `/unsubscribe`, `/list`, `/test`
- **GitHub Webhook Integration**: Receives push, pull request, issues, and release events
- **Rich Embed Notifications**: Beautiful Discord embeds for GitHub events
- **projectmeridus Integration**: API for managing subscriptions from the main website

## Prerequisites

- Node.js 18+
- Discord Bot Token
- Discord Application ID and Public Key

## Installation

```bash
npm install
```

## Configuration

Create a `.env` file in the root directory with the following variables:

```env
# Discord Configuration
DISCORD_BOT_TOKEN=your_bot_token_here
DISCORD_APP_ID=your_app_id_here
DISCORD_PUBLIC_KEY=your_public_key_here

# projectmeridus Integration
MERIDUS_URL=http://localhost:8080
MERIDUS_API_KEY=your_api_key_here

# GitHub Webhook (optional)
GITHUB_WEBHOOK_SECRET=your_webhook_secret_here

# Server Configuration (optional)
BOT_URL=http://localhost:3000
PORT=3000
```

### Environment Variables

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `DISCORD_BOT_TOKEN` | Yes | - | Discord bot token for authentication |
| `DISCORD_APP_ID` | Yes | - | Discord application ID |
| `DISCORD_PUBLIC_KEY` | Yes | - | Discord public key for verifying interactions |
| `MERIDUS_URL` | Yes | - | URL of the projectmeridus website |
| `MERIDUS_API_KEY` | Yes | - | API key for communicating with projectmeridus |
| `GITHUB_WEBHOOK_SECRET` | No | - | Secret for verifying GitHub webhook signatures |
| `BOT_URL` | No | `http://localhost:3000` | Public URL where the bot is hosted |
| `PORT` | No | `3000` | Port for the Express server |

## Running

```bash
# Development
node index.js

# Production (with PM2)
pm2 start index.js --name meridus-bot
```

## Discord Commands

- `/ping` - Check if bot is online
- `/status` - View bot status and uptime
- `/subscribe <channel> <repo> [events]` - Subscribe to GitHub events
- `/unsubscribe <channel> [repo]` - Unsubscribe from events
- `/list [channel]` - List subscriptions
- `/test` - Send a test notification

## API Endpoints

- `GET /` - Health check
- `POST /api/discord/interactions` - Discord slash commands
- `POST /api/webhooks/github` - GitHub webhook receiver
- `POST /api/subscriptions` - Manage subscriptions (requires API key)

## License

MIT
