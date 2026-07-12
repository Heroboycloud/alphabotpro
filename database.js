
// ============================================
// FILE-BASED DATABASE
// ============================================

const path = require('path');
const fs = require('fs');

const CONFIG={
 DATA_PATH: path.join(__dirname, 'data'),
 LOG_PATH:  path.join(__dirname, 'logs', 'bot.log')
}


class Database {
    constructor() {
        this.ensureDirectories();
        this.loadData();
        this.lastSave = Date.now();
        this.saveInterval = setInterval(() => this.save(), 60000); // Auto-save every minute
    }

    ensureDirectories() {
        // Create data directory
        if (!fs.existsSync(CONFIG.DATA_PATH)) {
            fs.mkdirSync(CONFIG.DATA_PATH, { recursive: true });
        }
        
        // Create logs directory
        const logDir = path.dirname(CONFIG.LOG_PATH);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    getDataFile(type) {
        return path.join(CONFIG.DATA_PATH, `${type}.json`);
    }

    loadData() {
        // Users
        this.users = this.loadJSON('users', {});
        
        // Groups
        this.groups = this.loadJSON('groups', {});
        
        // Tokens
        this.tokens = this.loadJSON('tokens', {});
        
        // Alerts
        this.alerts = this.loadJSON('alerts', []);
        
        // Payments
        this.payments = this.loadJSON('payments', []);
        
        // Settings
        this.settings = this.loadJSON('settings', {
            totalAlertsSent: 0,
            lastTokenCleanup: Date.now()
        });
    }

    loadJSON(filename, defaultData) {
        const filePath = this.getDataFile(filename);
        try {
            if (fs.existsSync(filePath)) {
                const data = fs.readFileSync(filePath, 'utf8');
                return JSON.parse(data);
            }
        } catch (error) {
            console.error(`Failed to load ${filename}:`, error.message);
        }
        return typeof defaultData === 'object' ? JSON.parse(JSON.stringify(defaultData)) : defaultData;
    }

    save() {
        try {
            // Only save if data has changed (track with timestamp)
            const now = Date.now();
            if (now - this.lastSave < 1000) return; // Save at most once per second
            
            this.saveJSON('users', this.users);
            this.saveJSON('groups', this.groups);
            this.saveJSON('tokens', this.tokens);
            this.saveJSON('alerts', this.alerts);
            this.saveJSON('payments', this.payments);
            this.saveJSON('settings', this.settings);
            
            this.lastSave = now;
        } catch (error) {
            console.error('Failed to save data:', error.message);
        }
    }

    saveJSON(filename, data) {
        const filePath = this.getDataFile(filename);
        try {
            fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
        } catch (error) {
            console.error(`Failed to save ${filename}:`, error.message);
        }
    }

    // ===== USER METHODS =====
    getUser(userId) {
        return this.users[userId] || null;
    }

    createOrUpdateUser(userId, username, firstName, lastName) {
        const now = Date.now();
        if (!this.users[userId]) {
            this.users[userId] = {
                userId,
                username: username || null,
                firstName: firstName || null,
                lastName: lastName || null,
                isPremium: false,
                premiumExpiry: null,
                joinedAt: now,
                lastActive: now,
                trialUsed: false,
                notificationSettings: {}
            };
        } else {
            this.users[userId].username = username || this.users[userId].username;
            this.users[userId].firstName = firstName || this.users[userId].firstName;
            this.users[userId].lastName = lastName || this.users[userId].lastName;
            this.users[userId].lastActive = now;
        }
        this.save();
        return this.users[userId];
    }

    updateUserActivity(userId) {
        if (this.users[userId]) {
            this.users[userId].lastActive = Date.now();
            this.save();
        }
    }

    isPremium(userId) {
        const user = this.users[userId];
        if (!user || !user.isPremium) return false;
        return user.premiumExpiry > Date.now();
    }

    setPremium(userId, days) {
        if (!this.users[userId]) {
            this.createOrUpdateUser(userId, null, null, null);
        }
        
        const expiry = Date.now() + (days * 24 * 60 * 60 * 1000);
        this.users[userId].isPremium = true;
        this.users[userId].premiumExpiry = expiry;
        this.save();
        return true;
    }

    setTrialUsed(userId) {
        if (this.users[userId]) {
            this.users[userId].trialUsed = true;
            this.save();
            return true;
        }
        return false;
    }

    getPremiumUsers() {
        const now = Date.now();
        const premiumUsers = [];
        for (const [userId, user] of Object.entries(this.users)) {
            if (user.isPremium && user.premiumExpiry > now) {
                premiumUsers.push(parseInt(userId));
            }
        }
        return premiumUsers;
    }

    // ===== GROUP METHODS =====
    addGroup(groupId, groupName) {
        this.groups[groupId] = {
            groupId,
            groupName: groupName || 'Unknown Group',
            isActive: true,
            joinedAt: Date.now(),
            settings: {}
        };
        this.save();
        return this.groups[groupId];
    }

    getActiveGroups() {
        const activeGroups = [];
        for (const [groupId, group] of Object.entries(this.groups)) {
            if (group.isActive) {
                activeGroups.push(parseInt(groupId));
            }
        }
        return activeGroups;
    }

    updateGroupSettings(groupId, settings) {
        if (this.groups[groupId]) {
            this.groups[groupId].settings = { ...this.groups[groupId].settings, ...settings };
            this.save();
            return true;
        }
        return false;
    }

    // ===== TOKEN METHODS =====
    saveToken(data) {
        const mint = data.mint;
        this.tokens[mint] = {
            mint: data.mint,
            symbol: data.symbol || 'UNKNOWN',
            name: data.name || 'Unknown',
            initialBuySol: data.initialBuySol,
            marketCapSol: data.marketCapSol,
            score: data.score,
            detectedAt: data.detectedAt || Date.now(),
            isAlerted: false,
            reasons: data.reasons || [],
            warnings: data.warnings || []
        };
        
        // Limit stored tokens
        const tokenKeys = Object.keys(this.tokens);
        if (tokenKeys.length > CONFIG.MAX_STORED_TOKENS) {
            const sorted = tokenKeys.sort((a, b) => this.tokens[a].detectedAt - this.tokens[b].detectedAt);
            const toRemove = sorted.slice(0, tokenKeys.length - CONFIG.MAX_STORED_TOKENS);
            toRemove.forEach(key => delete this.tokens[key]);
        }
        
        this.save();
        return this.tokens[mint];
    }

    isTokenAlerted(mint) {
        return this.tokens[mint] && this.tokens[mint].isAlerted === true;
    }

    markTokenAlerted(mint) {
        if (this.tokens[mint]) {
            this.tokens[mint].isAlerted = true;
            this.save();
            return true;
        }
        return false;
    }

    getRecentTokens(limit = 10) {
        const sorted = Object.values(this.tokens)
            .sort((a, b) => b.detectedAt - a.detectedAt)
            .slice(0, limit);
        return sorted;
    }

    // ===== ALERT METHODS =====
    saveAlert(mint, symbol, message, sentTo) {
        const alert = {
            id: this.alerts.length + 1,
            mint,
            symbol: symbol || 'UNKNOWN',
            message,
            sentTo,
            sentAt: Date.now()
        };
        this.alerts.push(alert);
        
        // Limit stored alerts
        if (this.alerts.length > CONFIG.MAX_STORED_ALERTS) {
            this.alerts = this.alerts.slice(-CONFIG.MAX_STORED_ALERTS);
        }
        
        this.settings.totalAlertsSent = (this.settings.totalAlertsSent || 0) + 1;
        this.save();
        return alert;
    }

    getRecentAlerts(limit = 10) {
        return this.alerts.slice(-limit).reverse();
    }

    // ===== STATS =====
    getStats() {
        const now = Date.now();
        const premiumCount = Object.values(this.users).filter(u => u.isPremium && u.premiumExpiry > now).length;
        const tokens24h = Object.values(this.tokens).filter(t => t.detectedAt > now - 24 * 60 * 60 * 1000).length;
        
        return {
            totalUsers: Object.keys(this.users).length,
            premiumUsers: premiumCount,
            tokens24h: tokens24h,
            totalAlerts: this.settings.totalAlertsSent || 0,
            storedTokens: Object.keys(this.tokens).length,
            storedAlerts: this.alerts.length
        };
    }

    // ===== PAYMENT METHODS =====
    addPayment(userId, amount, txSignature, days) {
        const payment = {
            id: this.payments.length + 1,
            userId,
            amount,
            txSignature,
            days,
            status: 'pending',
            createdAt: Date.now()
        };
        this.payments.push(payment);
        this.save();
        return payment;
    }

    verifyPayment(txSignature) {
        const payment = this.payments.find(p => p.txSignature === txSignature);
        if (payment) {
            payment.status = 'confirmed';
            this.save();
            return payment;
        }
        return null;
    }

    // ===== CLEANUP =====
    cleanup() {
        const now = Date.now();
        const oneDayAgo = now - 24 * 60 * 60 * 1000;
        
        // Remove old tokens
        const oldTokens = Object.keys(this.tokens).filter(key => this.tokens[key].detectedAt < oneDayAgo);
        if (oldTokens.length > 0) {
            oldTokens.forEach(key => delete this.tokens[key]);
            this.save();
        }
    }

    // ===== CLOSE =====
    close() {
        clearInterval(this.saveInterval);
        this.save();
    }
}

module.exports= Database;