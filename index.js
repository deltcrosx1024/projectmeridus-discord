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
    GITHUB_WEBHOOK_SECRET,
    GITHUB_TOKEN
} = process.env;

// Embed color constants
const EmbedColors = {
    SUCCESS: 0x238636,   // Green
    ERROR: 0xF85149,     // Red
    INFO: 0x8257E5,      // Purple
    WARNING: 0xE3B341,   // Orange/Yellow
    GITHUB: 0x6E7681,    // Dark Gray
};

// Create Discord client
const client = new Client({
    intents: [
        3276799, // All intents except GUILD_PRESENCES and GUILD_MEMBERS (to avoid privileged intents)
        Intents.FLAGS.GUILD_PRESENCES,
        Intents.FLAGS.GUILD_MEMBERS,
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

async function handleSlashCommand(commandName, options, req, res, interaction = null) {
    console.log(`[handleSlashCommand] Received commandName: "${commandName}" (type: ${typeof commandName})`);
    const args = parseOptions(options);

    // Handle subcommands for 'repo' and 'webhook'
    const subcommand = options.find(opt => opt.type === 1 || opt.type === 2);
    if (subcommand) {
        args.subcommand = subcommand.name;
        // Merge subcommand options into args
        if (subcommand.options) {
            for (const opt of subcommand.options) {
                args[opt.name] = opt.value;
            }
        }
    }

    // Get user ID from interaction if available
    const userId = interaction?.user?.id || null;
    args.userId = userId;

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
            
        // NEW COMMANDS
        case 'repo':
            if (args.subcommand === 'info') {
                return await handleRepoInfoCommand(args);
            }
            return {
                type: 4,
                data: { content: '❌ Unknown subcommand. Use: /repo info' }
            };
            
        case 'pr':
            return await handlePRCommand(args);
            
        case 'star':
            return await handleStarCommand(args);
            
        case 'watch':
            return await handleWatchCommand(args);
            
        case 'webhook':
            return await handleWebhookCommand(args);
            
        case 'merge':
            return await handleMergeCommand(args);
            
        case 'search':
            return await handleSearchCommand(args);
            
        // PROJECTMERIDUS INTEGRATION COMMANDS
        case 'issue':
            if (args.subcommand === 'create') {
                return await handleIssueCreateCommand(args, userId);
            }
            return await handleIssuesCommand(args);

        case 'release':
            return await handleReleaseCommand(args);

        case 'branch':
            return await handleBranchCommand(args);

        case 'contributors':
            return await handleContributorsCommand(args);

        case 'workflow':
            return await handleWorkflowCommand(args);

        case 'user':
            if (args.subcommand === 'link') {
                return await handleUserLinkCommand(args);
            } else if (args.subcommand === 'unlink') {
                return await handleUserUnlinkCommand(args);
            } else if (args.subcommand === 'status') {
                return await handleUserStatusCommand(args);
            }
            return {
                type: 4,
                data: { content: '❌ Unknown subcommand. Use: /user link, /user unlink, /user status' }
            };

        // QOL FEATURES - New Commands
        case 'help':
            return await handleHelpCommand(args);

        case 'mystats':
            return await handleMyStatsCommand(args);

        case 'actions':
            return await handleActionsCommand(args);

        case 'reviews':
            return await handleReviewsCommand(args);

        case 'settings':
            return await handleSettingsCommand(args);

        case 'export':
            return await handleExportCommand(args);

        default:
            console.log(`[DEBUG] Unknown command received: "${commandName}"`);
            console.log(`[DEBUG] Command name length: ${commandName.length}`);
            console.log(`[DEBUG] Command name chars:`, [...commandName].map(c => c.charCodeAt(0)));
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
// NEW COMMAND HANDLERS
// ============================================

// Helper to get GitHub token for user from projectmeridus database
async function getGitHubToken(discordUserId = null) {
    // If no discord user ID, fall back to server token
    if (!discordUserId || !MERIDUS_URL || !MERIDUS_API_KEY) {
        return GITHUB_TOKEN;
    }

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/user/github-token?discordId=${discordUserId}`, {
            headers: {
                'x-api-key': MERIDUS_API_KEY,
                'Accept': 'application/json',
            },
        });

        if (!response.ok) {
            console.log(`[getGitHubToken] Failed to fetch token for ${discordUserId}: HTTP ${response.status}`);
            return GITHUB_TOKEN; // Fall back to server token
        }

        const data = await response.json();
        if (data.token) {
            console.log(`[getGitHubToken] Retrieved token for Discord user ${discordUserId}`);
            return data.token;
        }

        return GITHUB_TOKEN; // Fall back to server token if no user token
    } catch (err) {
        console.error(`[getGitHubToken] Error fetching token: ${err.message}`);
        return GITHUB_TOKEN; // Fall back to server token on error
    }
}

// Helper to link Discord user with projectmeridus account
async function linkDiscordUser(discordUserId, githubToken, metadata = {}) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return { ok: false, message: 'MERIDUS_URL or MERIDUS_API_KEY not configured' };
    }

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/user/link`, {
            method: 'POST',
            headers: {
                'x-api-key': MERIDUS_API_KEY,
                'Content-Type': 'application/json',
            },
            body: JSON.stringify({
                discordId: discordUserId,
                githubToken: githubToken,
                metadata: metadata,
            }),
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            return { 
                ok: false, 
                message: error.message || `HTTP ${response.status}` 
            };
        }

        const data = await response.json();
        return { ok: true, data };
    } catch (err) {
        console.error(`[linkDiscordUser] Error: ${err.message}`);
        return { ok: false, message: err.message };
    }
}

// Helper to unlink Discord user from projectmeridus
async function unlinkDiscordUser(discordUserId) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return { ok: false, message: 'MERIDUS_URL or MERIDUS_API_KEY not configured' };
    }

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/user/unlink?discordId=${discordUserId}`, {
            method: 'DELETE',
            headers: {
                'x-api-key': MERIDUS_API_KEY,
            },
        });

        if (!response.ok) {
            const error = await response.json().catch(() => ({}));
            return { 
                ok: false, 
                message: error.message || `HTTP ${response.status}` 
            };
        }

        return { ok: true };
    } catch (err) {
        console.error(`[unlinkDiscordUser] Error: ${err.message}`);
        return { ok: false, message: err.message };
    }
}

// Helper to check if Discord user is linked
async function isDiscordUserLinked(discordUserId) {
    if (!MERIDUS_URL || !MERIDUS_API_KEY) {
        return false;
    }

    try {
        const baseUrl = getBaseUrl();
        const response = await fetch(`${baseUrl}/api/user/status?discordId=${discordUserId}`, {
            headers: {
                'x-api-key': MERIDUS_API_KEY,
            },
        });

        if (!response.ok) {
            return false;
        }

        const data = await response.json();
        return data.linked === true;
    } catch (err) {
        console.error(`[isDiscordUserLinked] Error: ${err.message}`);
        return false;
    }
}

// Helper to parse owner/repo from input
function parseRepoInput(input) {
    const parts = input.split('/');
    if (parts.length !== 2) return null;
    return { owner: parts[0], repo: parts[1] };
}

// Format number with commas
function formatNumber(num) {
    return num?.toLocaleString() || '0';
}

// Format date
function formatDate(dateStr) {
    if (!dateStr) return 'Unknown';
    const date = new Date(dateStr);
    return date.toLocaleDateString('en-US', { 
        year: 'numeric', 
        month: 'short', 
        day: 'numeric' 
    });
}

// /repo info command handler
async function handleRepoInfoCommand(args) {
    const repoInput = args.repo;
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured. Please set GITHUB_TOKEN.' }
        };
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (response.status === 401) {
            return {
                type: 4,
                data: { content: '🔒 GitHub token expired or invalid.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const data = await response.json();

        const fields = [
            { name: '⭐ Stars', value: formatNumber(data.stargazers_count), inline: true },
            { name: '🍴 Forks', value: formatNumber(data.forks_count), inline: true },
            { name: '👁️ Watchers', value: formatNumber(data.watchers_count), inline: true },
            { name: '📋 Open Issues', value: formatNumber(data.open_issues_count), inline: true },
            { name: '💻 Language', value: data.language || 'Not specified', inline: true },
            { name: '📅 Created', value: formatDate(data.created_at), inline: true },
            { name: '🔄 Updated', value: formatDate(data.updated_at), inline: true },
        ];

        if (data.license) {
            fields.push({ name: '📄 License', value: data.license.name, inline: true });
        }

        if (data.homepage) {
            fields.push({ name: '🌐 Homepage', value: `[Visit](${data.homepage})`, inline: true });
        }

        if (data.topics && data.topics.length > 0) {
            fields.push({ 
                name: '🏷️ Topics', 
                value: data.topics.slice(0, 10).map(t => `\`${t}\``).join(', ') 
            });
        }

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `📦 ${data.full_name}`,
                    description: data.description || 'No description available',
                    url: data.html_url,
                    color: EmbedColors.INFO,
                    fields: fields,
                    thumbnail: { url: data.owner?.avatar_url },
                    timestamp: new Date().toISOString(),
                    footer: { text: `Default branch: ${data.default_branch}` }
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

// /pr command handler
async function handlePRCommand(args) {
    const repoInput = args.repo;
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls?state=open&per_page=10`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const prs = await response.json();

        if (prs.length === 0) {
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: `🔀 Open Pull Requests: ${owner}/${repo}`,
                        description: '🎉 No open pull requests!',
                        color: EmbedColors.SUCCESS,
                        url: `https://github.com/${owner}/${repo}/pulls`
                    }]
                }
            };
        }

        const prList = prs.map(pr => {
            const emoji = pr.draft ? '🟡' : (pr.state === 'open' ? '🟢' : '🔴');
            const labels = pr.labels?.length > 0 
                ? pr.labels.map(l => `\`${l.name}\``).join(' ') 
                : '';
            const reviewStatus = pr.requested_reviewers?.length > 0 
                ? `👥 ${pr.requested_reviewers.length} reviewers` 
                : '';
            return `${emoji} [#${pr.number}](${pr.html_url}) **${pr.title.substring(0, 60)}${pr.title.length > 60 ? '...' : ''}**\n` +
                   `   By **${pr.user.login}** • ${formatDate(pr.created_at)}${labels ? ' • ' + labels : ''}${reviewStatus ? ' • ' + reviewStatus : ''}`;
        }).join('\n\n');

        const linkToMore = prs.length >= 10 
            ? `\n\n[View all pull requests](https://github.com/${owner}/${repo}/pulls)` 
            : '';

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `🔀 Open Pull Requests: ${owner}/${repo}`,
                    description: prList + linkToMore,
                    color: EmbedColors.INFO,
                    footer: { text: `Showing ${prs.length} open PRs` },
                    timestamp: new Date().toISOString()
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

// /star command handler
async function handleStarCommand(args) {
    const repoInput = args.repo;
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        // Star the repository
        const starResponse = await fetch(`https://api.github.com/user/starred/${owner}/${repo}`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0',
                'Content-Length': '0'
            }
        });

        if (starResponse.status === 401) {
            return {
                type: 4,
                data: { content: '🔒 GitHub token expired or lacks permissions (needs `public_repo` or `repo` scope).' }
            };
        }

        if (starResponse.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (starResponse.status === 204 || starResponse.status === 304) {
            // Get updated star count
            const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'MeridusBot/1.0'
                }
            });
            
            let starCount = 'unknown';
            if (repoResponse.ok) {
                const repoData = await repoResponse.json();
                starCount = formatNumber(repoData.stargazers_count);
            }

            const alreadyStarred = starResponse.status === 304;

            return {
                type: 4,
                data: {
                    embeds: [{
                        title: alreadyStarred ? '⭐ Already Starred' : '⭐ Repository Starred!',
                        description: alreadyStarred 
                            ? `You already starred **${owner}/${repo}**`
                            : `Successfully starred **${owner}/${repo}**`,
                        color: EmbedColors.WARNING,
                        fields: [
                            { name: 'Total Stars', value: `⭐ ${starCount}`, inline: true },
                            { name: 'Repository', value: `[View on GitHub](https://github.com/${owner}/${repo})`, inline: true }
                        ],
                        timestamp: new Date().toISOString()
                    }]
                }
            };
        }

        return {
            type: 4,
            data: { content: `❌ Failed to star repository. Status: ${starResponse.status}` }
        };
    } catch (err) {
        return {
            type: 4,
            data: { content: `❌ Error: ${err.message}` }
        };
    }
}

// /watch command handler
async function handleWatchCommand(args) {
    const repoInput = args.repo;
    const action = args.action || 'toggle';
    
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        // Get current subscription status
        const subResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/subscription`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        let currentlySubscribed = false;
        if (subResponse.ok) {
            const subData = await subResponse.json();
            currentlySubscribed = subData.subscribed;
        }

        // Determine new state
        let newState;
        if (action === 'subscribe' || action === 'watch') {
            newState = true;
        } else if (action === 'unsubscribe' || action === 'unwatch') {
            newState = false;
        } else {
            // toggle
            newState = !currentlySubscribed;
        }

        // Set subscription
        const updateResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/subscription`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                subscribed: newState,
                ignored: false
            })
        });

        if (updateResponse.status === 401) {
            return {
                type: 4,
                data: { content: '🔒 GitHub token expired or lacks permissions.' }
            };
        }

        if (updateResponse.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        const statusText = newState ? '👁️ Watching' : '🚫 Not Watching';
        const color = newState ? EmbedColors.SUCCESS : EmbedColors.WARNING;

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `${statusText}: ${owner}/${repo}`,
                    description: newState 
                        ? `You are now watching **${owner}/${repo}**. You'll receive notifications for this repository.`
                        : `You are no longer watching **${owner}/${repo}**. Notifications disabled.`,
                    color: color,
                    fields: [
                        { 
                            name: 'Previous Status', 
                            value: currentlySubscribed ? '👁️ Watching' : '🚫 Not Watching', 
                            inline: true 
                        },
                        { 
                            name: 'Current Status', 
                            value: statusText, 
                            inline: true 
                        }
                    ],
                    timestamp: new Date().toISOString()
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

// /webhook command handler
async function handleWebhookCommand(args) {
    const repoInput = args.repo;
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/hooks`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (response.status === 403) {
            return {
                type: 4,
                data: { content: '🔒 Insufficient permissions to view webhooks.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const webhooks = await response.json();
        
        // Check if Meridus webhook is configured
        const baseUrl = getBaseUrl();
        const meridusWebhookUrl = `${baseUrl}/api/webhooks/github`;
        const meridusWebhook = webhooks.find(h => 
            h.config?.url?.includes('meridus') || 
            h.config?.url === meridusWebhookUrl
        );

        if (webhooks.length === 0) {
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: `🔗 Webhook Status: ${owner}/${repo}`,
                        description: '❌ No webhooks configured for this repository.',
                        color: EmbedColors.WARNING,
                        fields: [
                            { name: 'Setup Required', value: `[Configure webhooks](https://github.com/${owner}/${repo}/settings/hooks)` }
                        ]
                    }]
                }
            };
        }

        const webhookList = webhooks.map(h => {
            const isActive = h.active ? '🟢' : '🔴';
            const isMeridus = h === meridusWebhook ? ' ✨ (Meridus)' : '';
            const events = h.events?.slice(0, 5).join(', ') + (h.events?.length > 5 ? '...' : '');
            return `${isActive} **${h.name}**${isMeridus}\n   Events: ${events || 'None'}`;
        }).join('\n\n');

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `🔗 Webhook Status: ${owner}/${repo}`,
                    description: webhookList,
                    color: meridusWebhook ? EmbedColors.SUCCESS : EmbedColors.WARNING,
                    fields: [
                        { 
                            name: 'Meridus Webhook', 
                            value: meridusWebhook ? '✅ Configured' : '❌ Not found\nExpected URL: `' + meridusWebhookUrl + '`', 
                            inline: false 
                        },
                        { 
                            name: 'Total Webhooks', 
                            value: `${webhooks.length}`, 
                            inline: true 
                        }
                    ],
                    timestamp: new Date().toISOString()
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

// /merge command handler
async function handleMergeCommand(args) {
    const repoInput = args.repo;
    const prNumber = args.number;
    const method = args.method || 'merge';
    
    if (!repoInput || !prNumber) {
        return {
            type: 4,
            data: { content: '❌ Usage: /merge <repo> <number> [method]' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    // Validate merge method
    const validMethods = ['merge', 'squash', 'rebase'];
    if (!validMethods.includes(method)) {
        return {
            type: 4,
            data: { content: `❌ Invalid merge method. Use: merge, squash, or rebase` }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        // First, get PR details to show in response
        const prResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (prResponse.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Pull request not found.' }
            };
        }

        if (!prResponse.ok) {
            return {
                type: 4,
                data: { content: `❌ Failed to fetch PR: HTTP ${prResponse.status}` }
            };
        }

        const prData = await prResponse.json();

        if (prData.state !== 'open') {
            return {
                type: 4,
                data: { content: `❌ PR #${prNumber} is already ${prData.state}.` }
            };
        }

        // Attempt merge
        const mergeResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}/pulls/${prNumber}/merge`, {
            method: 'PUT',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0',
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                commit_title: `Merge pull request #${prNumber} from ${prData.head.ref}`,
                merge_method: method
            })
        });

        const mergeData = await mergeResponse.json();

        if (mergeResponse.status === 405) {
            return {
                type: 4,
                data: { content: `❌ PR #${prNumber} cannot be merged. It may have conflicts or not be mergeable.` }
            };
        }

        if (mergeResponse.status === 409) {
            return {
                type: 4,
                data: { content: `❌ PR #${prNumber} has merge conflicts that must be resolved first.` }
            };
        }

        if (!mergeResponse.ok) {
            return {
                type: 4,
                data: { content: `❌ Merge failed: ${mergeData.message || 'Unknown error'}` }
            };
        }

        return {
            type: 4,
            data: {
                embeds: [{
                    title: '✅ Pull Request Merged',
                    description: `[#${prNumber}](${prData.html_url}) **${prData.title}**`,
                    color: EmbedColors.SUCCESS,
                    fields: [
                        { name: 'Method', value: method.charAt(0).toUpperCase() + method.slice(1), inline: true },
                        { name: 'Author', value: prData.user.login, inline: true },
                        { name: 'Commit SHA', value: `\`${mergeData.sha?.substring(0, 7) || 'N/A'}\``, inline: true },
                        { name: 'Branch', value: `${prData.head.ref} → ${prData.base.ref}`, inline: false }
                    ],
                    timestamp: new Date().toISOString()
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

// /search command handler
async function handleSearchCommand(args) {
    const query = args.query;
    const type = args.type || 'repos';
    
    if (!query) {
        return {
            type: 4,
            data: { content: '❌ Please provide a search query' }
        };
    }

    const validTypes = ['repos', 'issues', 'code', 'users', 'commits'];
    if (!validTypes.includes(type)) {
        return {
            type: 4,
            data: { content: `❌ Invalid search type. Use: repos, issues, code, users, or commits` }
        };
    }

    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        let endpoint, title, color, resultFormatter;
        
        switch (type) {
            case 'repos':
                endpoint = `https://api.github.com/search/repositories?q=${encodeURIComponent(query)}&per_page=5`;
                title = '🔍 Repository Search';
                color = EmbedColors.INFO;
                resultFormatter = (item) => {
                    return `[${item.full_name}](${item.html_url}) ⭐ ${formatNumber(item.stargazers_count)}\n` +
                           `   ${item.description?.substring(0, 80) || 'No description'}${item.description?.length > 80 ? '...' : ''}`;
                };
                break;
                
            case 'issues':
                endpoint = `https://api.github.com/search/issues?q=${encodeURIComponent(query)}&per_page=5`;
                title = '🔍 Issue Search';
                color = EmbedColors.ERROR;
                resultFormatter = (item) => {
                    const emoji = item.state === 'open' ? '🟢' : '🔴';
                    return `${emoji} [#${item.number}](${item.html_url}) ${item.title.substring(0, 60)}${item.title.length > 60 ? '...' : ''}\n` +
                           `   in **${item.repository_url?.split('/').pop() || 'unknown'}** by ${item.user?.login || 'unknown'}`;
                };
                break;
                
            case 'code':
                endpoint = `https://api.github.com/search/code?q=${encodeURIComponent(query)}&per_page=5`;
                title = '🔍 Code Search';
                color = EmbedColors.SUCCESS;
                resultFormatter = (item) => {
                    return `[${item.name}](${item.html_url})\n` +
                           `   in **${item.repository?.full_name || 'unknown'}**`;
                };
                break;
                
            case 'users':
                endpoint = `https://api.github.com/search/users?q=${encodeURIComponent(query)}&per_page=5`;
                title = '🔍 User Search';
                color = EmbedColors.WARNING;
                resultFormatter = (item) => {
                    return `[${item.login}](${item.html_url}) ${item.type}\n` +
                           `   [Profile](${item.html_url})`;
                };
                break;
                
            case 'commits':
                endpoint = `https://api.github.com/search/commits?q=${encodeURIComponent(query)}&per_page=5`;
                title = '🔍 Commit Search';
                color = EmbedColors.GITHUB;
                resultFormatter = (item) => {
                    return `[\`${item.sha?.substring(0, 7) || 'N/A'}\`](${item.html_url}) ${item.commit?.message?.split('\n')[0]?.substring(0, 50) || 'No message'}${item.commit?.message?.length > 50 ? '...' : ''}\n` +
                           `   by **${item.commit?.author?.name || item.author?.login || 'unknown'}** in ${item.repository?.full_name || 'unknown'}`;
                };
                break;
        }

        const response = await fetch(endpoint, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': type === 'commits' ? 'application/vnd.github.cloak-preview+json' : 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ Search failed: HTTP ${response.status}` }
            };
        }

        const data = await response.json();
        const items = data.items || [];

        if (items.length === 0) {
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: title,
                        description: `No results found for "**${query}**"`,
                        color: EmbedColors.WARNING
                    }]
                }
            };
        }

        const resultsList = items.map(resultFormatter).join('\n\n');
        const githubSearchUrl = `https://github.com/search?q=${encodeURIComponent(query)}&type=${type}`;

        return {
            type: 4,
            data: {
                embeds: [{
                    title: title,
                    description: resultsList,
                    color: color,
                    fields: [
                        { name: 'Total Results', value: formatNumber(data.total_count), inline: true },
                        { name: 'View All', value: `[Search on GitHub](${githubSearchUrl})`, inline: true }
                    ],
                    footer: { text: `Showing top ${items.length} results` },
                    timestamp: new Date().toISOString()
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

// /user link command handler
async function handleUserLinkCommand(args) {
    const userId = args.userId;
    const token = args.token;

    if (!userId) {
        return {
            type: 4,
            data: { content: '❌ Unable to identify user.' }
        };
    }

    if (!token) {
        // Check if already linked
        const isLinked = await isDiscordUserLinked(userId);
        if (isLinked) {
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: '✅ Account Linked',
                        description: 'Your Discord account is already linked to projectmeridus.',
                        color: EmbedColors.SUCCESS,
                        fields: [
                            { name: 'Discord ID', value: userId, inline: true },
                            { name: 'Status', value: '🟢 Active', inline: true },
                        ],
                        footer: { text: 'Use /user unlink to remove the link' }
                    }]
                }
            };
        }

        return {
            type: 4,
            data: {
                embeds: [{
                    title: '🔗 Link Your Account',
                    description: 'To link your Discord account with projectmeridus, visit the website and authorize GitHub access.',
                    color: EmbedColors.INFO,
                    fields: [
                        { name: 'Step 1', value: `Visit [Meridus](${getBaseUrl()}) and login with GitHub`, inline: false },
                        { name: 'Step 2', value: 'Go to Settings → Discord Integration', inline: false },
                        { name: 'Step 3', value: `Connect your Discord account (ID: \`${userId}\`)`, inline: false },
                    ],
                    footer: { text: 'Your GitHub token will be securely stored' }
                }]
            }
        };
    }

    // Link with provided token (for admin/debug purposes)
    const result = await linkDiscordUser(userId, token, {
        linkedAt: new Date().toISOString(),
        source: 'discord_bot'
    });

    if (!result.ok) {
        return {
            type: 4,
            data: { content: `❌ Failed to link account: ${result.message}` }
        };
    }

    return {
        type: 4,
        data: {
            embeds: [{
                title: '✅ Account Linked Successfully',
                description: 'Your Discord account is now linked to projectmeridus.',
                color: EmbedColors.SUCCESS,
                fields: [
                    { name: 'Discord ID', value: userId, inline: true },
                    { name: 'Status', value: '🟢 Active', inline: true },
                    { name: 'Next Steps', value: 'Use GitHub commands with your personal token!' },
                ],
                timestamp: new Date().toISOString()
            }]
        }
    };
}

// /user unlink command handler
async function handleUserUnlinkCommand(args) {
    const userId = args.userId;

    if (!userId) {
        return {
            type: 4,
            data: { content: '❌ Unable to identify user.' }
        };
    }

    const isLinked = await isDiscordUserLinked(userId);
    if (!isLinked) {
        return {
            type: 4,
            data: { content: 'ℹ️ Your Discord account is not linked to projectmeridus.' }
        };
    }

    const result = await unlinkDiscordUser(userId);

    if (!result.ok) {
        return {
            type: 4,
            data: { content: `❌ Failed to unlink account: ${result.message}` }
        };
    }

    return {
        type: 4,
        data: {
            embeds: [{
                title: '✅ Account Unlinked',
                description: 'Your Discord account has been unlinked from projectmeridus.',
                color: EmbedColors.WARNING,
                fields: [
                    { name: 'Discord ID', value: userId, inline: true },
                    { name: 'Status', value: '🔴 Unlinked', inline: true },
                ],
                footer: { text: 'Use /user link to reconnect' },
                timestamp: new Date().toISOString()
            }]
        }
    };
}

// /user status command handler
async function handleUserStatusCommand(args) {
    const userId = args.userId;

    if (!userId) {
        return {
            type: 4,
            data: { content: '❌ Unable to identify user.' }
        };
    }

    const isLinked = await isDiscordUserLinked(userId);

    if (isLinked) {
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '👤 Account Status',
                    description: 'Your Discord account is linked to projectmeridus.',
                    color: EmbedColors.SUCCESS,
                    fields: [
                        { name: 'Discord ID', value: `\`${userId}\``, inline: true },
                        { name: 'GitHub Link', value: '🟢 Connected', inline: true },
                        { name: 'Token Status', value: '✅ Active', inline: true },
                    ],
                    footer: { text: 'Your GitHub token is securely stored' }
                }]
            }
        };
    }

    return {
        type: 4,
        data: {
            embeds: [{
                title: '👤 Account Status',
                description: 'Your Discord account is not linked to projectmeridus.',
                color: EmbedColors.WARNING,
                fields: [
                    { name: 'Discord ID', value: `\`${userId}\``, inline: true },
                    { name: 'GitHub Link', value: '🔴 Not Connected', inline: true },
                ],
                footer: { text: 'Use /user link to connect your account' }
            }]
        }
    };
}

// ============================================
// NEW FEATURES - ProjectMeridus Integration
// ============================================

// /issue create command - Create GitHub issues from Discord
async function handleIssueCreateCommand(args, userId) {
    const repoInput = args.repo;
    const title = args.title;
    const body = args.body || '';
    const labels = args.labels || '';
    
    if (!repoInput || !title) {
        return {
            type: 4,
            data: { content: '❌ Usage: /issue create <repo> <title> [body] [labels]' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        const issueData = {
            title: title,
            body: body + (userId ? `\n\n_Created via MeridusBot by Discord user_` : ''),
        };

        if (labels) {
            issueData.labels = labels.split(',').map(l => l.trim());
        }

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/issues`, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'Content-Type': 'application/json',
                'User-Agent': 'MeridusBot/1.0'
            },
            body: JSON.stringify(issueData)
        });

        if (response.status === 401) {
            return {
                type: 4,
                data: { content: '🔒 GitHub token expired or lacks permissions.' }
            };
        }

        if (response.status === 403) {
            return {
                type: 4,
                data: { content: '🔒 Insufficient permissions to create issues in this repository.' }
            };
        }

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (!response.ok) {
            const errorData = await response.json().catch(() => ({}));
            return {
                type: 4,
                data: { content: `❌ Failed to create issue: ${errorData.message || `HTTP ${response.status}`}` }
            };
        }

        const data = await response.json();

        return {
            type: 4,
            data: {
                embeds: [{
                    title: '✅ Issue Created',
                    description: `[#${data.number}](${data.html_url}) **${data.title}**`,
                    color: EmbedColors.SUCCESS,
                    fields: [
                        { name: 'Repository', value: `${owner}/${repo}`, inline: true },
                        { name: 'State', value: data.state, inline: true },
                        { name: 'Labels', value: data.labels?.map(l => `\`${l.name}\``).join(', ') || 'None', inline: true },
                    ],
                    timestamp: new Date().toISOString()
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

// /release command - List repository releases
async function handleReleaseCommand(args) {
    const repoInput = args.repo;
    const limit = Math.min(args.limit || 5, 10);
    
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/releases?per_page=${limit}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const releases = await response.json();

        if (releases.length === 0) {
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: `🚀 Releases: ${owner}/${repo}`,
                        description: '📭 No releases found for this repository.',
                        color: EmbedColors.WARNING,
                        url: `https://github.com/${owner}/${repo}/releases`
                    }]
                }
            };
        }

        const releaseList = releases.map(r => {
            const emoji = r.prerelease ? '🧪' : '🚀';
            const date = formatDate(r.published_at);
            const name = r.name || r.tag_name;
            return `${emoji} [${name}](${r.html_url}) \`${r.tag_name}\`\n   Released: ${date}${r.prerelease ? ' • Pre-release' : ''}`;
        }).join('\n\n');

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `🚀 Releases: ${owner}/${repo}`,
                    description: releaseList,
                    color: EmbedColors.INFO,
                    footer: { text: `Showing ${releases.length} releases` },
                    timestamp: new Date().toISOString()
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

// /branch command - List repository branches
async function handleBranchCommand(args) {
    const repoInput = args.repo;
    const limit = Math.min(args.limit || 10, 20);
    
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        // Get default branch info first
        const repoResponse = await fetch(`https://api.github.com/repos/${owner}/${repo}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        let defaultBranch = 'main';
        if (repoResponse.ok) {
            const repoData = await repoResponse.json();
            defaultBranch = repoData.default_branch;
        }

        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/branches?per_page=${limit}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const branches = await response.json();

        if (branches.length === 0) {
            return {
                type: 4,
                data: { content: '📭 No branches found.' }
            };
        }

        const branchList = branches.map(b => {
            const isDefault = b.name === defaultBranch;
            const protectedEmoji = b.protected ? '🔒' : '';
            const defaultEmoji = isDefault ? '⭐' : '🌿';
            return `${defaultEmoji} \`${b.name}\`${isDefault ? ' (default)' : ''} ${protectedEmoji}`;
        }).join('\n');

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `🌿 Branches: ${owner}/${repo}`,
                    description: branchList,
                    color: EmbedColors.INFO,
                    fields: [
                        { name: 'Default Branch', value: `\`${defaultBranch}\``, inline: true },
                        { name: 'Protected', value: branches.filter(b => b.protected).length.toString(), inline: true },
                    ],
                    footer: { text: `Showing ${branches.length} branches` },
                    timestamp: new Date().toISOString()
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

// /contributors command - Show repository contributors
async function handleContributorsCommand(args) {
    const repoInput = args.repo;
    const limit = Math.min(args.limit || 10, 20);
    
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/contributors?per_page=${limit}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Accept': 'application/vnd.github.v3+json',
                'User-Agent': 'MeridusBot/1.0'
            }
        });

        if (response.status === 404) {
            return {
                type: 4,
                data: { content: '❌ Repository not found.' }
            };
        }

        if (response.status === 403) {
            return {
                type: 4,
                data: { content: '🔒 Contributor data is not available for this repository.' }
            };
        }

        if (!response.ok) {
            return {
                type: 4,
                data: { content: `❌ GitHub API error: HTTP ${response.status}` }
            };
        }

        const contributors = await response.json();

        if (contributors.length === 0) {
            return {
                type: 4,
                data: { content: '📭 No contributors found.' }
            };
        }

        const contributorList = contributors.map((c, i) => {
            const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : '•';
            return `${medal} [${c.login}](${c.html_url}) - **${formatNumber(c.contributions)}** contributions`;
        }).join('\n');

        const totalContributions = contributors.reduce((sum, c) => sum + c.contributions, 0);

        return {
            type: 4,
            data: {
                embeds: [{
                    title: `👥 Top Contributors: ${owner}/${repo}`,
                    description: contributorList,
                    color: EmbedColors.INFO,
                    thumbnail: { url: contributors[0]?.avatar_url },
                    fields: [
                        { name: 'Total Contributors', value: formatNumber(contributors.length), inline: true },
                        { name: 'Total Contributions', value: formatNumber(totalContributions), inline: true },
                    ],
                    footer: { text: `Showing top ${contributors.length} contributors` },
                    timestamp: new Date().toISOString()
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

// /workflow command - List and trigger workflows
async function handleWorkflowCommand(args) {
    const repoInput = args.repo;
    const action = args.action || 'list';
    
    if (!repoInput) {
        return {
            type: 4,
            data: { content: '❌ Please provide a repository (format: owner/repo)' }
        };
    }

    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return {
            type: 4,
            data: { content: '❌ Invalid repository format. Use: owner/repo' }
        };
    }

    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return {
            type: 4,
            data: { content: '🔒 GitHub token not configured.' }
        };
    }

    try {
        if (action === 'list') {
            // List workflows
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/workflows`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'MeridusBot/1.0'
                }
            });

            if (response.status === 404) {
                return {
                    type: 4,
                    data: { content: '❌ Repository not found.' }
                };
            }

            if (!response.ok) {
                return {
                    type: 4,
                    data: { content: `❌ GitHub API error: HTTP ${response.status}` }
                };
            }

            const data = await response.json();
            const workflows = data.workflows || [];

            if (workflows.length === 0) {
                return {
                    type: 4,
                    data: {
                        embeds: [{
                            title: `⚙️ Workflows: ${owner}/${repo}`,
                            description: '📭 No GitHub Actions workflows found.',
                            color: EmbedColors.WARNING
                        }]
                    }
                };
            }

            const workflowList = workflows.map(w => {
                const stateEmoji = w.state === 'active' ? '🟢' : w.state === 'disabled_manually' ? '🔴' : '🟡';
                return `${stateEmoji} [${w.name}](${w.html_url})\n   State: ${w.state} • ID: \`${w.id}\``;
            }).join('\n\n');

            return {
                type: 4,
                data: {
                    embeds: [{
                        title: `⚙️ GitHub Actions Workflows: ${owner}/${repo}`,
                        description: workflowList,
                        color: EmbedColors.INFO,
                        footer: { text: `${workflows.length} workflows` },
                        timestamp: new Date().toISOString()
                    }]
                }
            };
        } else if (action === 'runs') {
            // List recent runs
            const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`, {
                headers: {
                    'Authorization': `Bearer ${token}`,
                    'Accept': 'application/vnd.github.v3+json',
                    'User-Agent': 'MeridusBot/1.0'
                }
            });

            if (!response.ok) {
                return {
                    type: 4,
                    data: { content: `❌ GitHub API error: HTTP ${response.status}` }
                };
            }

            const data = await response.json();
            const runs = data.workflow_runs || [];

            if (runs.length === 0) {
                return {
                    type: 4,
                    data: { content: '📭 No recent workflow runs.' }
                };
            }

            const runList = runs.map(r => {
                const conclusionEmoji = r.conclusion === 'success' ? '✅' : 
                                       r.conclusion === 'failure' ? '❌' : 
                                       r.conclusion === 'cancelled' ? '🚫' : '🟡';
                return `${conclusionEmoji} [${r.name}](${r.html_url}) #${r.run_number}\n   Branch: \`${r.head_branch}\` • ${formatDate(r.created_at)}`;
            }).join('\n\n');

            return {
                type: 4,
                data: {
                    embeds: [{
                        title: `🔧 Recent Workflow Runs: ${owner}/${repo}`,
                        description: runList,
                        color: EmbedColors.INFO,
                        footer: { text: `Showing ${runs.length} recent runs` },
                        timestamp: new Date().toISOString()
                    }]
                }
            };
        }

        return {
            type: 4,
            data: { content: '❌ Unknown action. Use: list, runs' }
        };
    } catch (err) {
        return {
            type: 4,
            data: { content: `❌ Error: ${err.message}` }
        };
    }
}

// ============================================
// QOL FEATURES - New Command Handlers
// ============================================

// In-memory storage for QOL features
const userPreferences = new Map();
const commandCooldowns = new Map();

// Default cooldowns in seconds
const DEFAULT_COOLDOWNS = {
    repos: 30, issues: 15, commits: 15, pr: 20, search: 10,
    status: 5, ping: 5, test: 60, mystats: 30, actions: 30, reviews: 20
};

// Helper: Check cooldown
function checkCooldown(userId, command) {
    const key = `${userId}:${command}`;
    const cooldownSeconds = DEFAULT_COOLDOWNS[command] || 5;
    const lastUsed = commandCooldowns.get(key);
    if (!lastUsed) return 0;
    const elapsed = (Date.now() - lastUsed) / 1000;
    const remaining = Math.ceil(cooldownSeconds - elapsed);
    return remaining > 0 ? remaining : 0;
}

// Helper: Set cooldown
function setCooldown(userId, command) {
    commandCooldowns.set(`${userId}:${command}`, Date.now());
}

// Helper: Get user prefs
function getUserPrefs(userId) {
    if (!userPreferences.has(userId)) {
        userPreferences.set(userId, {
            dmNotifications: false,
            digestMode: 'instant',
            silentMode: null,
            mutedRepos: [],
            githubUsername: null
        });
    }
    return userPreferences.get(userId);
}

// Helper: Format error with suggestion
function formatErrorWithSuggestion(err, context) {
    const status = err?.status;
    if (status === 401) {
        return '🔒 **GitHub authentication failed**\n\nYour token has expired. Please re-link your account:\n' +
            `${getBaseUrl()}`;
    }
    if (status === 403) {
        return '⏱️ **Rate limit exceeded**\n\nPlease try again later.';
    }
    if (status === 404) {
        if (context === 'repo') return '❌ **Repository not found**\n\nCheck the format: `owner/repo`';
        return '❌ **Not found**\n\nThe requested resource does not exist.';
    }
    return `❌ **Error**: ${err.message || 'Unknown error'}`;
}

// 1. Help Command
async function handleHelpCommand(args) {
    const cmd = args.command;
    
    if (cmd) {
        const details = {
            repos: 'List your GitHub repositories with pagination.',
            issues: 'List open issues across your repositories.',
            commits: 'Show recent commits.',
            pr: 'List pull requests for a repository.',
            search: 'Search GitHub repositories, issues, or code.',
            subscribe: 'Subscribe a channel to GitHub events (Admin only).',
            settings: 'Manage your DM notifications, digest mode, etc.',
            mystats: 'View your GitHub statistics.',
            actions: 'View GitHub Actions workflow runs.',
            reviews: 'Show PRs awaiting your review.'
        };
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: `📖 /${cmd} - Help`,
                    description: details[cmd] || 'No detailed help available.',
                    color: EmbedColors.INFO
                }]
            }
        };
    }
    
    return {
        type: 4,
        data: {
            embeds: [{
                title: '📚 MeridusBot Commands',
                description: 'Use `/help command:<name>` for detailed info.',
                color: EmbedColors.PRIMARY,
                fields: [
                    { name: 'ℹ️ General', value: '`/ping`, `/status`, `/help`', inline: false },
                    { name: '📁 GitHub', value: '`/repos`, `/issues`, `/commits`, `/pr`, `/search`, `/mystats`, `/actions`, `/reviews`', inline: false },
                    { name: '🔔 Subscriptions', value: '`/subscribe`, `/unsubscribe`, `/list`', inline: false },
                    { name: '⚙️ Settings', value: '`/settings`, `/export`', inline: false }
                ]
            }]
        }
    };
}

// 2. MyStats Command
async function handleMyStatsCommand(args) {
    const userId = args.userId;
    const remaining = checkCooldown(userId, 'mystats');
    if (remaining > 0) {
        return { type: 4, data: { content: `⏱️ Please wait ${remaining}s before using this command again.`, flags: 64 } };
    }
    setCooldown(userId, 'mystats');
    
    const token = await getGitHubToken(userId);
    if (!token) {
        return { type: 4, data: { content: '🔒 GitHub not linked. Please log in at ' + getBaseUrl() } };
    }
    
    try {
        const response = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        if (!response.ok) throw { status: response.status };
        
        const user = await response.json();
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: `📊 Stats for ${user.login}`,
                    color: EmbedColors.PRIMARY,
                    thumbnail: { url: user.avatar_url },
                    fields: [
                        { name: '📁 Public Repos', value: user.public_repos.toString(), inline: true },
                        { name: '👥 Followers', value: user.followers.toString(), inline: true },
                        { name: '👤 Following', value: user.following.toString(), inline: true },
                        { name: '📅 Joined', value: new Date(user.created_at).toLocaleDateString(), inline: true },
                        { name: '🏢 Company', value: user.company || 'N/A', inline: true },
                        { name: '📍 Location', value: user.location || 'N/A', inline: true }
                    ]
                }]
            }
        };
    } catch (err) {
        return { type: 4, data: { content: formatErrorWithSuggestion(err, 'user') } };
    }
}

// 3. Actions Command
async function handleActionsCommand(args) {
    const repoInput = args.repo;
    
    if (!repoInput) {
        return { type: 4, data: { content: '❌ Please provide a repository (format: owner/repo)' } };
    }
    
    const parsed = parseRepoInput(repoInput);
    if (!parsed) {
        return { type: 4, data: { content: '❌ Invalid repository format. Use: owner/repo' } };
    }
    
    const { owner, repo } = parsed;
    const token = await getGitHubToken(args.userId);
    
    if (!token) {
        return { type: 4, data: { content: '🔒 GitHub token not configured.' } };
    }
    
    try {
        const response = await fetch(`https://api.github.com/repos/${owner}/${repo}/actions/runs?per_page=5`, {
            headers: { 'Authorization': `Bearer ${token}`, 'Accept': 'application/vnd.github.v3+json' }
        });
        
        if (!response.ok) throw { status: response.status };
        
        const data = await response.json();
        const runs = data.workflow_runs || [];
        
        if (runs.length === 0) {
            return { type: 4, data: { content: `🔧 No recent workflow runs in **${owner}/${repo}**.` } };
        }
        
        const runList = runs.map(r => {
            const emoji = r.conclusion === 'success' ? '✅' : r.conclusion === 'failure' ? '❌' : '⏳';
            return `${emoji} **${r.name}** - ${r.head_branch} (${r.event})`;
        }).join('\n');
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: `🔧 Recent Actions in ${owner}/${repo}`,
                    description: runList,
                    color: EmbedColors.INFO,
                    footer: { text: 'Last 5 workflow runs' }
                }]
            }
        };
    } catch (err) {
        return { type: 4, data: { content: formatErrorWithSuggestion(err, 'actions') } };
    }
}

// 4. Reviews Command
async function handleReviewsCommand(args) {
    const userId = args.userId;
    const token = await getGitHubToken(userId);
    
    if (!token) {
        return { type: 4, data: { content: '🔒 GitHub not linked.' } };
    }
    
    try {
        // Get current user
        const userRes = await fetch('https://api.github.com/user', {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        const user = await userRes.json();
        
        // Search for PRs awaiting review
        const searchRes = await fetch(`https://api.github.com/search/issues?q=is:pr+is:open+review-requested:${user.login}&per_page=10`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });
        
        if (!searchRes.ok) throw { status: searchRes.status };
        
        const searchData = await searchRes.json();
        const prs = searchData.items || [];
        
        if (prs.length === 0) {
            return { type: 4, data: { content: '🎉 No pull requests awaiting your review!' } };
        }
        
        const prList = prs.map(p => {
            const repo = p.repository_url?.split('/').slice(-2).join('/') || 'unknown';
            return `• **${repo}#${p.number}** ${p.title}`;
        }).join('\n');
        
        return {
            type: 4,
            data: {
                embeds: [{
                    title: '👀 Review Requests',
                    description: prList,
                    color: EmbedColors.WARNING,
                    footer: { text: `${prs.length} PRs awaiting review` }
                }]
            }
        };
    } catch (err) {
        return { type: 4, data: { content: formatErrorWithSuggestion(err, 'reviews') } };
    }
}

// 5. Settings Command
async function handleSettingsCommand(args) {
    const userId = args.userId;
    if (!userId) {
        return { type: 4, data: { content: '❌ Could not identify user.' } };
    }
    
    const action = args.action || 'view';
    const value = args.value || '';
    const prefs = getUserPrefs(userId);
    
    switch (action) {
        case 'view': {
            const silentStatus = prefs.silentMode?.enabled 
                ? `🔇 Until ${new Date(prefs.silentMode.until).toLocaleString()}` 
                : '🔊 Off';
            
            return {
                type: 4,
                data: {
                    embeds: [{
                        title: '⚙️ Your Settings',
                        color: EmbedColors.INFO,
                        fields: [
                            { name: '📩 DM Notifications', value: prefs.dmNotifications ? '✅ Enabled' : '❌ Disabled', inline: true },
                            { name: '📊 Digest Mode', value: prefs.digestMode, inline: true },
                            { name: '🔇 Silent Mode', value: silentStatus, inline: true },
                            { name: '🔗 GitHub Username', value: prefs.githubUsername || 'Not set', inline: true },
                            { name: '🔕 Muted Repos', value: prefs.mutedRepos.length > 0 ? prefs.mutedRepos.join(', ') : 'None', inline: false }
                        ]
                    }]
                }
            };
        }
        
        case 'dm': {
            prefs.dmNotifications = !prefs.dmNotifications;
            return { type: 4, data: { content: `📩 DM notifications ${prefs.dmNotifications ? '✅ enabled' : '❌ disabled'}.` } };
        }
        
        case 'digest': {
            if (!['instant', 'hourly', 'daily'].includes(value)) {
                return { type: 4, data: { content: '❌ Invalid mode. Use: instant, hourly, or daily' } };
            }
            prefs.digestMode = value;
            return { type: 4, data: { content: `📊 Digest mode set to **${value}**.` } };
        }
        
        case 'silent_on': {
            const duration = parseInt(value) || 60;
            const until = new Date();
            until.setMinutes(until.getMinutes() + duration);
            prefs.silentMode = { enabled: true, until: until.toISOString() };
            return { type: 4, data: { content: `🔇 Silent mode enabled for ${duration} minutes.` } };
        }
        
        case 'silent_off': {
            prefs.silentMode = { enabled: false, until: null };
            return { type: 4, data: { content: '🔊 Silent mode disabled.' } };
        }
        
        case 'mute': {
            if (!value) return { type: 4, data: { content: '❌ Please specify a repository to mute.' } };
            if (!prefs.mutedRepos.includes(value.toLowerCase())) {
                prefs.mutedRepos.push(value.toLowerCase());
            }
            return { type: 4, data: { content: `🔕 Muted **${value}**.` } };
        }
        
        case 'unmute': {
            if (!value) return { type: 4, data: { content: '❌ Please specify a repository to unmute.' } };
            prefs.mutedRepos = prefs.mutedRepos.filter(r => r !== value.toLowerCase());
            return { type: 4, data: { content: `🔔 Unmuted **${value}**.` } };
        }
        
        case 'github_user': {
            if (!value) return { type: 4, data: { content: '❌ Please specify your GitHub username.' } };
            prefs.githubUsername = value;
            return { type: 4, data: { content: `🔗 GitHub username set to **${value}**.` } };
        }
        
        default:
            return { type: 4, data: { content: '❌ Unknown action. Use: view, dm, digest, silent_on, silent_off, mute, unmute, github_user' } };
    }
}

// 6. Export Command
async function handleExportCommand(args) {
    // Check permissions (Admin only)
    // Note: In original code, permissions would be checked in switch case
    
    const data = {
        exported_at: new Date().toISOString(),
        subscriptions: Array.from(botState.subscriptions.entries()).map(([channelId, sub]) => ({
            channelId,
            ...sub
        }))
    };
    
    return {
        type: 4,
        data: {
            content: `📤 **${data.subscriptions.length} subscription(s) exported.**\n\`\`\`json\n${JSON.stringify(data, null, 2).substring(0, 1900)}\`\`\``,
            flags: 64
        }
    };
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
        workflow_run: 0x4A9EFF,
        discussion: 0x8257E5,
        pull_request_review: 0x238636,
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
        workflow_run: '⚙️',
        workflow_job: '🔧',
        discussion: '💭',
        discussion_comment: '💬',
        pull_request_review: '👁️',
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
            
        // NEW EVENT HANDLERS
        
        case 'workflow_run':
            const wfRun = payload.workflow_run;
            const wfConclusion = wfRun.conclusion;
            const statusEmoji = wfConclusion === 'success' ? '✅' : 
                               wfConclusion === 'failure' ? '❌' : 
                               wfConclusion === 'cancelled' ? '🚫' : '🟡';
            const statusColor = wfConclusion === 'success' ? 0x238636 : 
                               wfConclusion === 'failure' ? 0xF85149 : 
                               wfConclusion === 'cancelled' ? 0xE3B341 : 0x6E7681;
            
            embed.title = `${emojiMap.workflow_run} Workflow ${wfRun.status === 'completed' ? wfRun.conclusion : wfRun.status}: ${wfRun.name}`;
            embed.url = wfRun.html_url;
            embed.color = statusColor;
            embed.fields = [
                { name: 'Repository', value: repo.full_name, inline: true },
                { name: 'Branch', value: `\`${wfRun.head_branch}\``, inline: true },
                { name: 'Triggered by', value: payload.sender?.login || 'Unknown', inline: true },
                { name: 'Commit', value: `\`${wfRun.head_sha?.substring(0, 7)}\``, inline: true },
                { name: 'Run Number', value: `#${wfRun.run_number}`, inline: true },
            ];
            if (wfRun.conclusion === 'failure' && wfRun.run_attempt > 1) {
                embed.fields.push({ 
                    name: 'Attempt', 
                    value: `${wfRun.run_attempt}`, 
                    inline: true 
                });
            }
            break;
            
        case 'workflow_job':
            const job = payload.workflow_job;
            const jobStatus = job.conclusion || job.status;
            const jobEmoji = jobStatus === 'success' ? '✅' : 
                            jobStatus === 'failure' ? '❌' : 
                            jobStatus === 'cancelled' ? '🚫' : '🔧';
            embed.title = `${jobEmoji} Job ${jobStatus}: ${job.name}`;
            embed.url = job.html_url;
            embed.color = jobStatus === 'success' ? 0x238636 : 
                         jobStatus === 'failure' ? 0xF85149 : 0x6E7681;
            embed.fields = [
                { name: 'Workflow', value: job.workflow_name || 'Unknown', inline: true },
                { name: 'Repository', value: repo.full_name, inline: true },
                { name: 'Runner', value: job.runner_name || 'N/A', inline: true },
            ];
            if (job.started_at && job.completed_at) {
                const start = new Date(job.started_at);
                const end = new Date(job.completed_at);
                const duration = Math.round((end - start) / 1000);
                embed.fields.push({ 
                    name: 'Duration', 
                    value: `${Math.floor(duration / 60)}m ${duration % 60}s`, 
                    inline: true 
                });
            }
            break;
            
        case 'discussion':
            const discussion = payload.discussion;
            const categoryEmoji = discussion.category?.emoji || '💭';
            embed.title = `${categoryEmoji} Discussion ${payload.action}: ${discussion.title.substring(0, 80)}`;
            embed.url = discussion.html_url;
            embed.fields = [
                { name: 'Author', value: discussion.user?.login || 'Unknown', inline: true },
                { name: 'Category', value: discussion.category?.name || 'General', inline: true },
                { name: 'State', value: discussion.state || 'open', inline: true },
            ];
            if (discussion.body) {
                embed.fields.push({
                    name: 'Preview',
                    value: discussion.body.substring(0, 150) + (discussion.body.length > 150 ? '...' : '')
                });
            }
            break;
            
        case 'discussion_comment':
            const discComment = payload.comment;
            const parentDiscussion = payload.discussion;
            embed.title = `💬 New comment on: ${parentDiscussion?.title?.substring(0, 60) || 'Discussion'}`;
            embed.url = discComment.html_url;
            embed.fields = [
                { name: 'Author', value: discComment.user?.login || 'Unknown', inline: true },
                { name: 'Discussion', value: `[View](${parentDiscussion?.html_url})`, inline: true },
            ];
            if (discComment.body) {
                embed.fields.push({
                    name: 'Comment',
                    value: discComment.body.substring(0, 200) + (discComment.body.length > 200 ? '...' : '')
                });
            }
            break;
            
        case 'pull_request_review':
            const review = payload.review;
            const reviewPR = payload.pull_request;
            const reviewStateEmoji = review.state === 'approved' ? '✅' :
                                    review.state === 'changes_requested' ? '❌' :
                                    review.state === 'commented' ? '💬' : '👁️';
            embed.title = `${reviewStateEmoji} PR Review ${review.state}: #${reviewPR.number}`;
            embed.url = review.html_url;
            embed.fields = [
                { name: 'Reviewer', value: review.user?.login || 'Unknown', inline: true },
                { name: 'PR Title', value: reviewPR.title?.substring(0, 60) || 'Unknown', inline: true },
                { name: 'State', value: review.state, inline: true },
            ];
            if (review.body) {
                embed.fields.push({
                    name: 'Review Comment',
                    value: review.body.substring(0, 200) + (review.body.length > 200 ? '...' : '')
                });
            }
            break;
            
        case 'pull_request_review_comment':
            const prComment = payload.comment;
            const commentPR = payload.pull_request;
            embed.title = `💬 Review comment on: #${commentPR.number}`;
            embed.url = prComment.html_url;
            embed.fields = [
                { name: 'Commenter', value: prComment.user?.login || 'Unknown', inline: true },
                { name: 'File', value: `\`${prComment.path?.split('/').pop() || 'Unknown'}\``, inline: true },
                { name: 'Line', value: `${prComment.line || 'N/A'}`, inline: true },
            ];
            if (prComment.body) {
                embed.fields.push({
                    name: 'Comment',
                    value: prComment.body.substring(0, 200) + (prComment.body.length > 200 ? '...' : '')
                });
            }
            break;
            
        case 'create':
            const refType = payload.ref_type;
            const refName = payload.ref;
            const createEmoji = refType === 'tag' ? '🏷️' : '🌿';
            embed.title = `${createEmoji} ${refType === 'tag' ? 'Tag' : 'Branch'} Created: \`${refName}\``;
            embed.url = `${repo.html_url}/tree/${refName}`;
            embed.fields = [
                { name: 'Type', value: refType, inline: true },
                { name: 'Name', value: `\`${refName}\``, inline: true },
                { name: 'Created by', value: payload.sender?.login || 'Unknown', inline: true },
            ];
            if (refType === 'branch' && payload.master_branch) {
                embed.fields.push({ 
                    name: 'Based on', 
                    value: `\`${payload.master_branch}\``, 
                    inline: true 
                });
            }
            break;
            
        case 'delete':
            const delType = payload.ref_type;
            const delName = payload.ref;
            const delEmoji = delType === 'tag' ? '🏷️' : '🌿';
            embed.title = `${delEmoji} ${delType === 'tag' ? 'Tag' : 'Branch'} Deleted: \`${delName}\``;
            embed.color = 0xF85149;
            embed.fields = [
                { name: 'Type', value: delType, inline: true },
                { name: 'Name', value: `\`${delName}\``, inline: true },
                { name: 'Deleted by', value: payload.sender?.login || 'Unknown', inline: true },
            ];
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
        // NEW COMMANDS
        {
            name: 'repo',
            description: 'Repository information and management',
            options: [
                {
                    name: 'info',
                    description: 'Show detailed repository information',
                    type: 1, // SUB_COMMAND
                    options: [
                        {
                            name: 'repo',
                            description: 'GitHub repository (owner/repo)',
                            type: 3, // STRING
                            required: true,
                        },
                    ],
                },
            ],
        },
        {
            name: 'pr',
            description: 'List open pull requests for a repository',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
            ],
        },
        {
            name: 'star',
            description: 'Star a GitHub repository',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
            ],
        },
        {
            name: 'watch',
            description: 'Watch or unwatch a repository',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'action',
                    description: 'Watch action (toggle/subscribe/unsubscribe)',
                    type: 3,
                    required: false,
                    choices: [
                        { name: 'Toggle', value: 'toggle' },
                        { name: 'Subscribe/Watch', value: 'subscribe' },
                        { name: 'Unsubscribe/Unwatch', value: 'unsubscribe' },
                    ],
                },
            ],
        },
        {
            name: 'webhook',
            description: 'Check webhook status for a repository',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
            ],
        },
        {
            name: 'merge',
            description: 'Merge a pull request',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'number',
                    description: 'Pull request number',
                    type: 4, // INTEGER
                    required: true,
                },
                {
                    name: 'method',
                    description: 'Merge method',
                    type: 3,
                    required: false,
                    choices: [
                        { name: 'Merge', value: 'merge' },
                        { name: 'Squash', value: 'squash' },
                        { name: 'Rebase', value: 'rebase' },
                    ],
                },
            ],
        },
        {
            name: 'search',
            description: 'Search GitHub',
            options: [
                {
                    name: 'query',
                    description: 'Search query',
                    type: 3,
                    required: true,
                },
                {
                    name: 'type',
                    description: 'Type of search',
                    type: 3,
                    required: false,
                    choices: [
                        { name: 'Repositories', value: 'repos' },
                        { name: 'Issues', value: 'issues' },
                        { name: 'Code', value: 'code' },
                        { name: 'Users', value: 'users' },
                        { name: 'Commits', value: 'commits' },
                    ],
                },
            ],
        },
        // PROJECTMERIDUS INTEGRATION COMMANDS
        {
            name: 'issue',
            description: 'GitHub issue management',
            options: [
                {
                    name: 'create',
                    description: 'Create a new issue',
                    type: 1, // SUB_COMMAND
                    options: [
                        {
                            name: 'repo',
                            description: 'GitHub repository (owner/repo)',
                            type: 3,
                            required: true,
                        },
                        {
                            name: 'title',
                            description: 'Issue title',
                            type: 3,
                            required: true,
                        },
                        {
                            name: 'body',
                            description: 'Issue body/description',
                            type: 3,
                            required: false,
                        },
                        {
                            name: 'labels',
                            description: 'Comma-separated labels',
                            type: 3,
                            required: false,
                        },
                    ],
                },
            ],
        },
        {
            name: 'release',
            description: 'List repository releases',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'limit',
                    description: 'Number of releases to show (max 10)',
                    type: 4,
                    required: false,
                },
            ],
        },
        {
            name: 'branch',
            description: 'List repository branches',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'limit',
                    description: 'Number of branches to show (max 20)',
                    type: 4,
                    required: false,
                },
            ],
        },
        {
            name: 'contributors',
            description: 'Show repository contributors',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'limit',
                    description: 'Number of contributors to show (max 20)',
                    type: 4,
                    required: false,
                },
            ],
        },
        {
            name: 'workflow',
            description: 'GitHub Actions workflow management',
            options: [
                {
                    name: 'repo',
                    description: 'GitHub repository (owner/repo)',
                    type: 3,
                    required: true,
                },
                {
                    name: 'action',
                    description: 'Action to perform',
                    type: 3,
                    required: false,
                    choices: [
                        { name: 'List Workflows', value: 'list' },
                        { name: 'Recent Runs', value: 'runs' },
                    ],
                },
            ],
        },
        // USER ACCOUNT LINKING COMMANDS
        {
            name: 'user',
            description: 'Manage your projectmeridus account link',
            options: [
                {
                    name: 'link',
                    description: 'Link your Discord account with projectmeridus',
                    type: 1, // SUB_COMMAND
                    options: [
                        {
                            name: 'token',
                            description: 'GitHub token (optional - usually linked via website)',
                            type: 3,
                            required: false,
                        },
                    ],
                },
                {
                    name: 'unlink',
                    description: 'Unlink your Discord account from projectmeridus',
                    type: 1, // SUB_COMMAND
                },
                {
                    name: 'status',
                    description: 'Check your account link status',
                    type: 1, // SUB_COMMAND
                },
            ],
        },
        // QOL FEATURES - New Commands
        {
            name: 'help',
            description: 'Show help information for commands',
            options: [
                {
                    name: 'command',
                    description: 'Get detailed help for a specific command',
                    type: 3,
                    required: false,
                    choices: [
                        { name: 'repos', value: 'repos' },
                        { name: 'issues', value: 'issues' },
                        { name: 'commits', value: 'commits' },
                        { name: 'pr', value: 'pr' },
                        { name: 'search', value: 'search' },
                        { name: 'settings', value: 'settings' },
                        { name: 'mystats', value: 'mystats' },
                    ],
                },
            ],
        },
        {
            name: 'mystats',
            description: 'Show your GitHub statistics',
        },
        {
            name: 'actions',
            description: 'Show GitHub Actions workflow runs',
            options: [
                {
                    name: 'repo',
                    description: 'Repository (owner/repo)',
                    type: 3,
                    required: true,
                },
            ],
        },
        {
            name: 'reviews',
            description: 'Show pull requests awaiting your review',
        },
        {
            name: 'settings',
            description: 'Manage your bot settings',
            options: [
                {
                    name: 'action',
                    description: 'Setting to change',
                    type: 3,
                    required: true,
                    choices: [
                        { name: 'View settings', value: 'view' },
                        { name: 'Toggle DM notifications', value: 'dm' },
                        { name: 'Set digest mode', value: 'digest' },
                        { name: 'Enable silent mode', value: 'silent_on' },
                        { name: 'Disable silent mode', value: 'silent_off' },
                        { name: 'Mute repository', value: 'mute' },
                        { name: 'Unmute repository', value: 'unmute' },
                        { name: 'Set GitHub username', value: 'github_user' },
                    ],
                },
                {
                    name: 'value',
                    description: 'Value for the setting',
                    type: 3,
                    required: false,
                },
            ],
        },
        {
            name: 'export',
            description: 'Export all subscriptions as JSON (Admin only)',
            default_member_permissions: '8', // Administrator
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
    console.log(`[Discord] Command: "${commandName}" (type: ${typeof commandName})`);
    console.log(`[Discord] Options data:`, options.data);

    try {
        const response = await handleSlashCommand(
            commandName,
            options.data || [],
            { headers: {} },
            null,
            interaction
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
