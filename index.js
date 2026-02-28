/**
 * MeridusBot - Main Entry Point
 * 
 * A standalone Discord bot that receives GitHub events via webhooks
 * and sends rich embed notifications to Discord channels.
 * 
 * Communication: This bot communicates with projectmeridus (website) via HTTP APIs
 */

require('dotenv').config();
const { Client, Intents, Routes } = require('discord.js');
const express = require('express');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// Helper to get base URL from MERIDUS_URL
function getBaseUrl() {
    if (!MERIDUS_URL) return 'https://www.meridusdev.in.th';
    return MERIDUS_URL.replace('/api/auth/callback?service=discord', '');
}

// Configuration
const {
    DISCORD_BOT_TOKEN,
    DISCORD_APP_ID,
    DISCORD_PUBLIC_KEY,
    BOT_URL = 'http://localhost:3000',
    PORT = 3000,
    MERIDUS_URL,
    MERIDUS_API_KEY,
    GITHUB_WEBHOOK_SECRET
} = process.env;

// Create Discord client
const client = new Client({
    intents: [
        Intents.FLAGS.GUILDS,
        Intents.FLAGS.GUILD_MESSAGES,
        Intents.FLAGS.MESSAGE_CONTENT,
    ],
});

// Bot state
const botState = {
    subscriptions: new Map(), // channelId -> { repos: [], events: [] }
    connected: false,
    startTime: Date.now(),
};

// ============================================
// Express Routes (Web Server)
// ============================================

// Health check
app.get('/', (req, res) => {
    res.json({
        status: 'ok',
        bot: 'MeridusBot',
        version: '1.0.0',
        uptime: Date.now() - botState.startTime,
        connected: botState.connected,
    });
});

// Discord Interactions are now handled by the website at /api/discord/interactions

// GitHub Webhook Receiver (from projectmeridus)
app.post('/api/webhooks/github', (req, res) => {
    const signature = req.headers['x-hub-signature-256'];
    const event = req.headers['x-github-event'];
    
    // Verify GitHub signature if secret is set
    if (GITHUB_WEBHOOK_SECRET) {
        const hash = crypto
            .createHmac('sha256', GITHUB_WEBHOOK_SECRET)
            .update(JSON.stringify(req.body))
            .digest('hex');
        const expected = `sha256=${hash}`;
        
        if (signature !== expected) {
            console.log('[GitHub Webhook] Invalid signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }
    }
    
    console.log(`[GitHub Webhook] Event: ${event}`);
    
    // Process the GitHub event
    handleGitHubEvent(event, req.body)
        .then(() => res.json({ received: true, event }))
        .catch(err => {
            console.error('[GitHub Webhook] Error:', err);
            res.json({ received: true, error: err.message });
        });
});

// API for projectmeridus to manage subscriptions
app.post('/api/subscriptions', async (req, res) => {
    const { action, channelId, repo, events } = req.body;
    
    // Verify API key
    if (MERIDUS_API_KEY && req.headers['x-api-key'] !== MERIDUS_API_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    
    try {
        if (action === 'add') {
            if (!botState.subscriptions.has(channelId)) {
                botState.subscriptions.set(channelId, { repos: [], events: [] });
            }
            const sub = botState.subscriptions.get(channelId);
            if (repo && !sub.repos.includes(repo)) {
                sub.repos.push(repo);
            }
            if (events) {
                sub.events = [...new Set([...sub.events, ...events])];
            }
            return res.json({ success: true, subscription: sub });
        }
        
        if (action === 'remove') {
            if (repo) {
                const sub = botState.subscriptions.get(channelId);
                if (sub) {
                    sub.repos = sub.repos.filter(r => r !== repo);
                }
            }
            return res.json({ success: true });
        }
        
        if (action === 'list') {
            return res.json({ subscriptions: Object.fromEntries(botState.subscriptions) });
        }
        
        res.json({ error: 'Unknown action' });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Status endpoint - combines bot status with website status
app.get('/api/status', async (req, res) => {
    const botStatus = {
        connected: botState.connected,
        uptime: Math.floor((Date.now() - botState.startTime) / 1000),
        subscriptions: botState.subscriptions.size,
    };
    
    let websiteStatus = null;
    let websiteError = null;
    
    if (MERIDUS_URL && MERIDUS_API_KEY) {
            const baseUrl = getBaseUrl();
        try {
            const response = await fetch(`${baseUrl}/api/meridus/status`, {
                headers: {
                    'x-api-key': MERIDUS_API_KEY,
                },
            });
            if (response.ok) {
                websiteStatus = await response.json();
            } else {
                websiteError = `HTTP ${response.status}`;
            }
        } catch (err) {
            websiteError = err.message;
        }
    }
    
    res.json({
        bot: botStatus,
        website: websiteStatus,
        websiteError: websiteError,
    });
});

// ============================================
// Command Handlers
// ============================================

async function handleSlashCommand(commandName, options, req, res) {
    const args = parseOptions(options);
    
    switch (commandName) {
        case 'ping':
            return {
                type: 4,
                data: { content: '🏓 Pong! Bot is online.' }
            };
            
        case 'status':
            return await handleStatusCommand(args);
            
        case 'subscribe':
            return await handleSubscribeCommand(args);
            
        case 'unsubscribe':
            return await handleUnsubscribeCommand(args);
            
        case 'list':
            return await handleListCommand(args);
            
        case 'test':
            return await handleTestCommand(args);
            
        case 'repos':
            return await handleReposCommand(args);
            
        case 'issues':
            return await handleIssuesCommand(args);
            
        case 'commits':
            return await handleCommitsCommand(args);
            
        default:
            return {
                type: 4,
                data: { content: `❌ Unknown command: ${commandName}` }
            };
    }
}

function parseOptions(options) {
    const args = {};
    for (const opt of options) {
        if (opt.options) {
            Object.assign(args, parseOptions(opt.options));
        } else {
            args[opt.name] = opt.value;
        }
    }
    return args;
}

async function handleStatusCommand(args) {
    const status = {
        connected: botState.connected,
        uptime: Math.floor((Date.now() - botState.startTime) / 1000),
        subscriptions: botState.subscriptions.size,
    };
    
    return {
        type: 4,
        data: {
            embeds: [{
                title: '📊 MeridusBot Status',
                color: 0x7289da,
                fields: [
                    { name: 'Status', value: status.connected ? '🟢 Online' : '🔴 Offline', inline: true },
                    { name: 'Uptime', value: `${status.uptime}s`, inline: true },
                    { name: 'Subscriptions', value: `${status.subscriptions} channels`, inline: true },
                ],
                timestamp: new Date().toISOString(),
            }]
        }
    };
}

async function handleSubscribeCommand(args) {
    const channelId = args.channel;
    const repo = args.repo;
    const events = (args.events || 'push,issues,pull_request,release').split(',');
    
    if (!channelId || !repo) {
        return {
            type: 4,
            data: { content: '❌ Usage: /subscribe <channel> <repo> [events]' }
        };
    }
    
    if (!botState.subscriptions.has(channelId)) {
        botState.subscriptions.set(channelId, { repos: [], events: [] });
    }
    
    const sub = botState.subscriptions.get(channelId);
    sub.repos.push(repo);
    sub.events = [...new Set([...sub.events, ...events])];
    
    return {
        type: 4,
        data: {
            embeds: [{
                title: '✅ Subscribed',
                description: `Now receiving events for **${repo}** in this channel`,
                color: 0x238636,
                fields: [
                    { name: 'Events', value: sub.events.join(', ') },
                ],
            }]
        }
    };
}

async function handleUnsubscribeCommand(args) {
    const channelId = args.channel;
    const repo = args.repo;
    
    if (!channelId) {
        return {
            type: 4,
            data: { content: '❌ Usage: /unsubscribe <channel> [repo]' }
        };
    }
    
    const sub = botState.subscriptions.get(channelId);
    if (!sub) {
        return { type: 4, data: { content: '❌ No subscriptions found' } };
    }
    
    if (repo) {
        sub.repos = sub.repos.filter(r => r !== repo);
    } else {
        botState.subscriptions.delete(channelId);
    }
    
    return {
        type: 4,
        data: { content: repo ? `✅ Unsubscribed from ${repo}` : '✅ All subscriptions removed' }
    };
}

async function handleListCommand(args) {
    const channelId = args.channel;
    
    if (channelId) {
        const sub = botState.subscriptions.get(channelId);
        if (!sub || sub.repos.length === 0) {
            return { type: 4, data: { content: '❌ No subscriptions for this channel' } };
        }
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '📋 Subscriptions',
                    color: 0x7289da,
                    fields: [
                        { name: 'Repositories', value: sub.repos.join('\n') || 'None' },
                        { name: 'Events', value: sub.events.join(', ') || 'All' },
                    ],
                }]
            }
        };
    }
    
    // List all subscriptions
    const allSubs = Array.from(botState.subscriptions.entries()).map(([ch, sub]) => {
        return `<#${ch}>: ${sub.repos.join(', ')}`;
    });
    
    return {
        type: 4,
        data: {
            embeds: [{
                title: '📋 All Subscriptions',
                color: 0x7289da,
                description: allSubs.length > 0 ? allSubs.join('\n') : 'No subscriptions',
            }]
        }
    };
}

async function handleTestCommand(args) {
    return {
        type: 4,
        data: {
            embeds: [{
                title: '🧪 Test Notification',
                description: 'If you see this, the bot is working correctly!',
                color: 0x7289da,
                fields: [
                    { name: 'Time', value: new Date().toISOString() },
                    { name: 'Status', value: '✅ Bot is operational' },
                ],
                timestamp: new Date().toISOString(),
            }]
        }
    };
}

async function handleReposCommand(args) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return {
            type: 4,
            data: { content: '❌ MERIDUS_URL or MERIDUS_API_KEY not configured' }
        };
    }
    
    const baseUrl = getBaseUrl();
    
    try {
        const response = await fetch(`${baseUrl}/api/github/repos`, {
            headers: {
                'x-api-key': MERIDUS_API_KEY,
            },
        });
        
        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ Error fetching repos: HTTP ${response.status}` }
            };
        }
        
        const repos = await response.json();
        
        if (!Array.isArray(repos) || repos.length === 0) {
            return {
                type: 4,
                data: { content: '📭 No repositories found' }
            };
        }
        
        const repoList = repos.slice(0, 10).map(r => 
            `[${r.full_name}](${r.html_url}) - ⭐ ${r.stargazers_count || 0}`
        ).join('\n');
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '📚 GitHub Repositories',
                    color: 0x238636,
                    description: repoList,
                    footer: { text: `Showing ${Math.min(repos.length, 10)} of ${repos.length} repos` },
                    timestamp: new Date().toISOString(),
                }]
            }
        };
    } catch (err) {
        return {
            type: 4,
            data: { content: `❌ Error: ${err.message}` }
        };
    }
}

async function handleIssuesCommand(args) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return {
            type: 4,
            data: { content: '❌ MERIDUS_URL or MERIDUS_API_KEY not configured' }
        };
    }
    
    const baseUrl = getBaseUrl();
    const repo = args.repo;
    const url = repo 
        ? `${baseUrl}/api/github/issues?repo=${encodeURIComponent(repo)}`
        : `${baseUrl}/api/github/issues`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'x-api-key': MERIDUS_API_KEY,
            },
        });
        
        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ Error fetching issues: HTTP ${response.status}` }
            };
        }
        
        const issues = await response.json();
        
        if (!Array.isArray(issues) || issues.length === 0) {
            return {
                type: 4,
                data: { content: '📭 No issues found' }
            };
        }
        
        const issueList = issues.slice(0, 10).map(i => 
            `[#${i.number}](${i.html_url}) ${i.state === 'open' ? '🟢' : '🔴'} ${i.title.substring(0, 60)}`
        ).join('\n');
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '📋 GitHub Issues',
                    color: 0xF85149,
                    description: issueList,
                    footer: { text: `Showing ${Math.min(issues.length, 10)} of ${issues.length} issues` },
                    timestamp: new Date().toISOString(),
                }]
            }
        };
    } catch (err) {
        return {
            type: 4,
            data: { content: `❌ Error: ${err.message}` }
        };
    }
}

async function handleCommitsCommand(args) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return {
            type: 4,
            data: { content: '❌ MERIDUS_URL or MERIDUS_API_KEY not configured' }
        };
    }
    
    const baseUrl = getBaseUrl();
    const repo = args.repo;
    const url = repo 
        ? `${baseUrl}/api/github/commits?repo=${encodeURIComponent(repo)}`
        : `${baseUrl}/api/github/commits`;
    
    try {
        const response = await fetch(url, {
            headers: {
                'x-api-key': MERIDUS_API_KEY,
            },
        });
        
        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ Error fetching commits: HTTP ${response.status}` }
            };
        }
        
        const commits = await response.json();
        
        if (!Array.isArray(commits) || commits.length === 0) {
            return {
                type: 4,
                data: { content: '📭 No commits found' }
            };
        }
        
        const commitList = commits.slice(0, 10).map(c => 
            `[\`${c.sha.substring(0, 7)}\`](${c.html_url}) ${c.commit.message.split('\n')[0].substring(0, 50)} - ${c.commit.author.name}`
        ).join('\n');
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '📤 Recent Commits',
                    color: 0x238636,
                    description: commitList,
                    footer: { text: `Showing ${Math.min(commits.length, 10)} of ${commits.length} commits` },
                    timestamp: new Date().toISOString(),
                }]
            }
        };
    } catch (err) {
        return {
            type: 4,
            data: { content: `❌ Error: ${err.message}` }
        };
    }
}

// ============================================
// GitHub Event Handler
// ============================================

async function handleGitHubEvent(event, payload) {
    const repo = payload.repository?.full_name;
    if (!repo) return;
    
    console.log(`[GitHub] Processing ${event} for ${repo}`);
    
    // Find subscriptions for this repo
    for (const [channelId, sub] of botState.subscriptions) {
        // Check if repo matches
        const repoMatch = sub.repos.length === 0 || sub.repos.some(r => 
            r === repo || r === '*'
        );
        
        if (!repoMatch) continue;
        
        // Check if event is enabled
        const eventMatch = sub.events.length === 0 || sub.events.includes(event);
        
        if (!eventMatch) continue;
        
        // Send notification
        const embed = createGitHubEmbed(event, payload);
        
        try {
            const channel = await client.channels.fetch(channelId);
            if (channel) {
                await channel.send({ embeds: [embed] });
                console.log(`[GitHub] Sent notification to ${channelId}`);
            }
        } catch (err) {
            console.error(`[GitHub] Failed to send to ${channelId}:`, err.message);
        }
    }
}

function createGitHubEmbed(event, payload) {
    const repo = payload.repository;
    const colorMap = {
        push: 0x238636,
        pull_request: 0x8257E5,
        issues: 0xF85149,
        issue_comment: 0xF85149,
        release: 0x4A9EFF,
        fork: 0x6E7681,
        watch: 0xE3B341,
        create: 0x238636,
        delete: 0xF85149,
    };
    
    const emojiMap = {
        push: '📤',
        pull_request: '🔀',
        issues: '📋',
        issue_comment: '💬',
        release: '🚀',
        fork: '🍴',
        watch: '⭐',
        create: '✨',
        delete: '🗑️',
    };
    
    const embed = {
        color: colorMap[event] || 0x7289da,
        timestamp: new Date().toISOString(),
        footer: { text: 'MeridusBot • GitHub' },
    };
    
    switch (event) {
        case 'push':
            const commits = payload.commits || [];
            const branch = payload.ref?.split('/').pop();
            embed.title = `${emojiMap.push} Push to ${repo.full_name}`;
            embed.url = payload.compare;
            embed.fields = [
                { name: 'Branch', value: `\`${branch}\``, inline: true },
                { name: 'Commits', value: `${commits.length}`, inline: true },
                { name: 'Author', value: payload.sender?.login || 'Unknown', inline: true },
                {
                    name: 'Changes',
                    value: commits.slice(0, 3).map(c => 
                        `[\`${c.id.slice(0, 7)}\`](${repo.html_url}/commit/${c.id}) ${c.message.split('\n')[0]}`
                    ).join('\n') || 'No commit info'
                }
            ];
            break;
            
        case 'pull_request':
            const pr = payload.pull_request;
            embed.title = `${emojiMap.pull_request} Pull Request ${payload.action}: #${pr.number}`;
            embed.url = pr.html_url;
            embed.fields = [
                { name: 'Title', value: pr.title, inline: false },
                { name: 'Author', value: pr.user.login, inline: true },
                { name: 'State', value: pr.merged ? 'Merged' : pr.state, inline: true },
                { name: 'Branch', value: `${pr.head.ref} → ${pr.base.ref}`, inline: false },
            ];
            break;
            
        case 'issues':
            const issue = payload.issue;
            embed.title = `${emojiMap.issues} Issue ${payload.action}: #${issue.number}`;
            embed.url = issue.html_url;
            embed.fields = [
                { name: 'Title', value: issue.title, inline: false },
                { name: 'Author', value: issue.user.login, inline: true },
                { name: 'State', value: issue.state, inline: true },
            ];
            if (issue.labels?.length) {
                embed.fields.push({
                    name: 'Labels',
                    value: issue.labels.map(l => `\`${l.name}\``).join(', ')
                });
            }
            break;
            
        case 'release':
            const release = payload.release;
            embed.title = `${emojiMap.release} Release ${payload.action}: ${release.tag_name}`;
            embed.url = release.html_url;
            embed.fields = [
                { name: 'Tag', value: release.tag_name, inline: true },
                { name: 'Author', value: release.author.login, inline: true },
                { name: 'Pre-release', value: release.prerelease ? 'Yes' : 'No', inline: true },
            ];
            if (release.body) {
                embed.fields.push({
                    name: 'Notes',
                    value: release.body.substring(0, 200)
                });
            }
            break;
            
        default:
            embed.title = `${emojiMap[event] || '📋'} ${event} on ${repo.full_name}`;
            embed.description = `Event: ${event}`;
    }
    
    return embed;
}

// ============================================
// Discord Bot Events
// ============================================

client.once('ready', async () => {
    console.log(`[Discord] Bot logged in as ${client.user.tag}`);
    botState.connected = true;
    
    // Set bot activity
    client.user.setActivity({
        name: 'GitHub Repositories',
        type: 'WATCHING',
    });
    
    // Register slash commands
    const commands = [
        {
            name: 'ping',
            description: 'Check bot connectivity',
        },
        {
            name: 'status',
            description: 'Check bot status and subscriptions',
        },
        {
            name: 'subscribe',
            description: 'Subscribe to GitHub repository events',
            options: [
                {
                    name: 'channel',
                    description: 'Discord channel for notifications',
                    type: 7, // CHANNEL
                    required: true,
                },
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3, // STRING
                    required: true,
                },
                {
                    name: 'events',
                    description: 'Events to receive (comma-separated)',
                    type: 3, // STRING
                    required: false,
                },
            ],
        },
        {
            name: 'unsubscribe',
            description: 'Unsubscribe from repository events',
            options: [
                {
                    name: 'channel',
                    description: 'Discord channel',
                    type: 7, // CHANNEL
                    required: true,
                },
                {
                    name: 'repo',
                    description: 'GitHub repository (leave empty to remove all)',
                    type: 3,
                    required: false,
                },
            ],
        },
        {
            name: 'list',
            description: 'List subscriptions',
            options: [
                {
                    name: 'channel',
                    description: 'Filter by channel',
                    type: 7,
                    required: false,
                },
            ],
        },
        {
            name: 'test',
            description: 'Send a test notification',
        },
        {
            name: 'repos',
            description: 'List GitHub repositories',
        },
        {
            name: 'issues',
            description: 'List GitHub issues',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: false,
                },
            ],
        },
        {
            name: 'commits',
            description: 'List recent commits',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: false,
                },
            ],
        },
    ];
    
    try {
        await client.application.commands.set(commands);
        console.log('[Discord] Slash commands registered');
    } catch (err) {
        console.error('[Discord] Failed to register commands:', err);
    }
});

client.on('interactionCreate', async (interaction) => {
    if (!interaction.isCommand()) return;
    
    const { commandName, options } = interaction;
    console.log(`[Discord] Command: ${commandName}`);
    
    try {
        const response = await handleSlashCommand(
            commandName,
            options.data?.map(o => ({ name: o.name, value: o.value, options: o.options })) || [],
            { headers: {} },
            null
        );
        
        if (response) {
            await interaction.reply(response.data || { content: 'Done' });
        }
    } catch (err) {
        console.error('[Discord] Command error:', err);
        await interaction.reply({ content: `❌ Error: ${err.message}` });
    }
});

client.on('error', (err) => {
    console.error('[Discord] Client error:', err);
});

// ============================================
// Start Server
// ============================================

// Start Express server
app.listen(PORT, () => {
    console.log(`[Server] Web server running on port ${PORT}`);
});

// Login to Discord
if (DISCORD_BOT_TOKEN) {
    client.login(DISCORD_BOT_TOKEN);
} else {
    console.log('[Bot] DISCORD_BOT_TOKEN not set, running web server only');
}

module.exports = { app, client, botState };
