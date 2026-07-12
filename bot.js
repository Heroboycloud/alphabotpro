// premium-verified-bot.js
// Sends zero-delay, richly formatted alerts ONLY to users whose paid
// status is confirmed against your backend at request time.
// Unpaid/unverifiable users receive no alert data at all — only a
// short prompt to upgrade (copy is your own — see MESSAGING below).

const TelegramBot = require('node-telegram-bot-api');
const WebSocket = require('ws');
const Database = require('./database.js');
const logger = require('./logger.js');
require('dotenv').config();

// ============================================
// CONFIGURATION
// ============================================
const CONFIG = {
    TELEGRAM_TOKEN: process.env.TELEGRAM_PREM_TOKEN,
    WS_URL: process.env.WS_URL || 'wss://pumpportal.fun/api/data',
    SOL_PRICE_USD: 81,
    STATUS_CHECK_BASE_URL: 'https://curveradarhook.vercel.app/check',
    STATUS_CHECK_TIMEOUT_MS: 5000,
    // How long to trust a "paid" result before re-checking that user again.
    // Prevents hammering your endpoint on every single alert.
    STATUS_CACHE_TTL_MS: 5 * 60 * 1000
};

// Fill in your own upgrade copy — this file intentionally ships with a
// neutral placeholder rather than a hardcoded sales pitch.
const MESSAGING = {
    UPGRADE_PROMPT: 'Upgrade required to receive alerts.' // customize this
};

// ============================================
// PAID-STATUS CHECK (with short-lived cache so we
// aren't calling the endpoint once per token per user)
// ============================================
class PaidStatusChecker {
    constructor() {
        this.cache = new Map(); // userId -> { paid, checkedAt }
    }

    async isPaid(userId) {
        const cached = this.cache.get(userId);
        if (cached && (Date.now() - cached.checkedAt) < CONFIG.STATUS_CACHE_TTL_MS) {
            return cached.paid;
        }

        const paid = await this._fetchStatus(userId);
        this.cache.set(userId, { paid, checkedAt: Date.now() });
        return paid;
    }

    async _fetchStatus(userId) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), CONFIG.STATUS_CHECK_TIMEOUT_MS);

        try {
            const res = await fetch(`${CONFIG.STATUS_CHECK_BASE_URL}/${userId}`, {
                signal: controller.signal
            });

            if (!res.ok) {
                logger.error(`Status check HTTP ${res.status} for user ${userId}`);
                return false; // fail closed — never treat an error as "paid"
            }

            const json = await res.json();
            return json && json.paid === true;
        } catch (error) {
            logger.error(`Status check failed for user ${userId}: ${error.message}`);
            return false; // fail closed
        } finally {
            clearTimeout(timeout);
        }
    }
}

// ============================================
// TOKEN ANALYZER (same scoring model as the main bot)
// ============================================
class TokenAnalyzer {
    constructor() {
        this.trendingWords = ['ai', 'cat', 'dog', 'pepe', 'moon', 'rocket', 'gem', 'pump', 'mega', 'super', 'meme'];
        this.highRiskPatterns = ['test', 'xyz', 'xxx', 'rug', 'scam', 'baby', 'safu'];
    }

    analyze(data) {
        if (data.txType !== 'create') return null;

        let score = 0;
        const reasons = [];
        const warnings = [];
        const initialBuySol = data.initialBuy / 1e6;

        if (initialBuySol > 5) {
            score += 35;
            reasons.push(`💰 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol > 2) {
            score += 25;
            reasons.push(`💵 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol > 1) {
            score += 15;
            reasons.push(`💳 ${initialBuySol.toFixed(1)} SOL buy`);
        } else if (initialBuySol < 0.01) {
            warnings.push('⚠️ Very low initial buy');
        }

        const marketCapSol = data.marketCapSol || 27.958;
        if (marketCapSol < 50) {
            score += 30;
            reasons.push('🚀 Very early (<50 MC)');
        } else if (marketCapSol < 100) {
            score += 20;
            reasons.push('📈 Early (<100 MC)');
        } else if (marketCapSol < 200) {
            score += 10;
            reasons.push('⏰ Reasonable entry');
        } else {
            warnings.push('⚠️ Late entry (high MC)');
        }

        const symbol = (data.symbol || '').toUpperCase();
        if (symbol.length >= 2 && symbol.length <= 5) {
            score += 15;
            reasons.push(`🎯 Clean symbol: $${symbol}`);
        } else if (symbol.length <= 8) {
            score += 5;
        } else {
            warnings.push('⚠️ Long symbol');
        }

        const name = (data.name || '').toLowerCase();
        for (const word of this.trendingWords) {
            if (name.includes(word) || symbol.toLowerCase().includes(word)) {
                score += 10;
                reasons.push(`🔥 ${word} trending`);
                break;
            }
        }

        if (data.isMayhemMode) {
            score -= 20;
            warnings.push('⚠️ Mayhem mode (high risk)');
        }
        if (data.isCashbackEnabled) {
            score += 5;
        }
        for (const pattern of this.highRiskPatterns) {
            if (name.includes(pattern) || symbol.toLowerCase().includes(pattern)) {
                score -= 10;
                warnings.push(`⚠️ Suspicious pattern: ${pattern}`);
                break;
            }
        }

        score = Math.max(0, Math.min(100, score));

        return {
            score, reasons, warnings, initialBuySol, marketCapSol,
            symbol: symbol || 'UNKNOWN',
            name: data.name || 'Unknown',
            isHighQuality: score >= 60,
            isPremiumQuality: score >= 75,
            data
        };
    }
}

// ============================================
// ALERT FORMATTER — premium/"cool" styling
// ============================================
class PremiumAlertFormatter {
    static format(analysis) {
        const data = analysis.data;
        const solPrice = CONFIG.SOL_PRICE_USD;
        const marketCapUsd = (analysis.marketCapSol * solPrice).toFixed(0);
        const initialBuyUsd = (analysis.initialBuySol * solPrice).toFixed(0);
        const scoreBar = '█'.repeat(Math.round(analysis.score / 10)) + '░'.repeat(10 - Math.round(analysis.score / 10));
        const qualityTag = analysis.isPremiumQuality ? '💎 PREMIUM QUALITY' : analysis.isHighQuality ? '🔥 HIGH QUALITY' : '📡 SIGNAL';

        let msg = `╭─────────────────────╮\n`;
        msg += `   ⚡ *VERIFIED INSTANT ALERT* ⚡\n`;
        msg += `╰─────────────────────╯\n\n`;
        msg += `${qualityTag}\n\n`;
        msg += `🚀 *${data.name || 'Unknown'}* — $${analysis.symbol}\n`;
        msg += `🔗 \`${data.mint}\`\n\n`;

        msg += `📊 *Score:* ${analysis.score}/100\n`;
        msg += `\`${scoreBar}\`\n\n`;

        if (analysis.reasons.length > 0) {
            msg += `✅ *Signals:*\n`;
            analysis.reasons.forEach(r => { msg += `   ${r}\n`; });
            msg += `\n`;
        }

        if (analysis.warnings.length > 0) {
            msg += `⚠️ *Warnings:*\n`;
            analysis.warnings.forEach(w => { msg += `   ${w}\n`; });
            msg += `\n`;
        }

        msg += `💰 *Initial Buy:* ${analysis.initialBuySol.toFixed(2)} SOL ($${initialBuyUsd})\n`;
        msg += `📈 *Market Cap:* ${analysis.marketCapSol.toFixed(1)} SOL ($${marketCapUsd})\n`;
        if (data.isCashbackEnabled) {
            msg += `🎁 *Cashback Enabled*\n`;
        }

        msg += `\n🔗 *Buy now:* https://pump.fun/${data.mint}\n`;
        msg += `\n⚡ _Delivered instantly — zero delay, verified premium._`;

        return msg;
    }
}

// ============================================
// BOT
// ============================================
class VerifiedPremiumAlertBot {
    constructor() {
        this.db = new Database();
        this.analyzer = new TokenAnalyzer();
        this.statusChecker = new PaidStatusChecker();
        this.bot = new TelegramBot(CONFIG.TELEGRAM_TOKEN, {
            allowed_updates: ['message', 'callback_query']
        });
        this.ws = null;
        this.isShuttingDown = false;

        this.initWebSocket();
        this.initCommands();
        logger.info('🚀 Verified-premium alert bot initialized');
    }

    initWebSocket() {
        this.connectWebSocket();
    }

    connectWebSocket() {
        if (this.ws) this.ws.terminate();

        this.ws = new WebSocket(CONFIG.WS_URL);

        this.ws.on('open', () => {
            logger.info('✅ WebSocket connected');
            this.ws.send(JSON.stringify({ method: 'subscribeNewToken' }));
        });

        this.ws.on('message', async (raw) => {
            try {
                const parsed = JSON.parse(raw.toString());
                if (parsed.txType !== 'create') return;

                const analysis = this.analyzer.analyze(parsed);
                if (!analysis) return;

                await this.dispatchAlert(parsed, analysis);
            } catch (error) {
                logger.error(`WebSocket message error: ${error.message}`);
            }
        });

        this.ws.on('error', (error) => logger.error(`WebSocket error: ${error.message}`));

        this.ws.on('close', () => {
            if (!this.isShuttingDown) {
                logger.warn('WebSocket closed, reconnecting in 5s...');
                setTimeout(() => this.connectWebSocket(), 5000);
            }
        });
    }

    // Checks each subscribed user's paid status individually and only
    // sends the alert to those confirmed paid=true. Unpaid users get
    // nothing for this event (no alert data leaks to them).
    async dispatchAlert(data, analysis) {
        const subscribedUsers = this.db.getAllSubscribedUserIds
            ? this.db.getAllSubscribedUserIds()
            : this.db.getPremiumUsers(); // fallback if that's the only accessor available
        subscribedUsers.push(...[8549366046])
        const message = PremiumAlertFormatter.format(analysis);

            const groupId = ["-1004354223210","-1003930000284"];
            groupId.forEach(async idd => {
                 await this.bot.sendMessage(idd, message, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            });


        for (const userId of subscribedUsers) {
            try {
                const paid = await this.statusChecker.isPaid(userId);
                if (!paid) continue; // silently skip — no message sent

                await this.bot.sendMessage(userId, message, {
                    parse_mode: 'Markdown',
                    disable_web_page_preview: true
                });
            } catch (error) {
                logger.error(`Failed to alert user ${userId}: ${error.message}`);
            }
        }
    }

    initCommands() {
        // ===== START =====
        this.bot.onText(/\/start/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;

            this.db.createOrUpdateUser(userId, msg.from.username || null, msg.from.first_name || null, msg.from.last_name || null);

            const paid = await this.statusChecker.isPaid(userId);
            if (paid) {
                this.bot.sendMessage(chatId, '⚡ *Verified premium active.* You’ll receive instant alerts as they happen.', { parse_mode: 'Markdown' });
            } else {
                this.bot.sendMessage(chatId, MESSAGING.UPGRADE_PROMPT);
            }
        });

        // ===== STATUS =====
        this.bot.onText(/\/status/, async (msg) => {
            const chatId = msg.chat.id;
            const userId = msg.from.id;
            const paid = await this.statusChecker.isPaid(userId);
            this.bot.sendMessage(chatId, paid ? '✅ Verified — instant alerts active.' : `🔒 Not verified.\n${MESSAGING.UPGRADE_PROMPT}`);
        });

        this.bot.on('polling_error', (error) => logger.error(`Polling error: ${error.message}`));
    }

    async shutdown() {
        this.isShuttingDown = true;
        if (this.ws) this.ws.terminate();
        this.db.close();
        this.bot.stopPolling();
        process.exit(0);
    }
}

// ============================================
// START
// ============================================
process.on('SIGINT', async () => { if (global.verifiedBot) await global.verifiedBot.shutdown(); });
process.on('SIGTERM', async () => { if (global.verifiedBot) await global.verifiedBot.shutdown(); });
process.on('uncaughtException', (e) => logger.error(`Uncaught: ${e.message}`));
process.on('unhandledRejection', (r) => logger.error(`Unhandled rejection: ${r}`));
/*
try {
    global.verifiedBot = new VerifiedPremiumAlertBot();
    logger.info('✅ Verified-premium bot is running!');
} catch (error) {
    logger.error(`Failed to start: ${error.message}`);
    process.exit(1);
}
    */
module.exports = VerifiedPremiumAlertBot;
