const fs = require('fs');
const path = require("path");
const clc = require("cli-color");

// ============================================
// LOGGER
// ============================================

const LOG_PATH = path.join(__dirname, 'logs', 'bot.log');

class Logger {
    constructor() {
        // Ensure logs directory exists
        const logDir = path.dirname(LOG_PATH);
        if (!fs.existsSync(logDir)) {
            fs.mkdirSync(logDir, { recursive: true });
        }
    }

    log(message, level = 'INFO') {
        const timestamp = new Date().toISOString();
        const logEntry = `[${timestamp}] [${level}] ${message}\n`;
        
        // Write to file
        try {
            fs.appendFileSync(LOG_PATH, logEntry);
        } catch (error) {
            console.error(clc.red(`Failed to write to log file: ${error.message}`));
            process.exit(12);
        }

        // Colorize console output
        const coloredMessage = this.colorize(message, level);
        const timestampColored = clc.cyan(`[${timestamp}]`);
        const levelColored = this.colorizeLevel(level);
        console.log(`${timestampColored} ${levelColored} ${coloredMessage}`);
    }

    colorize(message, level) {
        switch (level) {
            case 'INFO':
                return clc.blue(message);
            case 'SUCCESS':
                return clc.green(message);
            case 'WARN':
                return clc.yellow(message);
            case 'ERROR':
                return clc.red(message);
            case 'DEBUG':
                return clc.cyan(message);
            default:
                return message;
        }
    }

    colorizeLevel(level) {
        switch (level) {
            case 'INFO':
                return clc.blue(`[${level}]`);
            case 'SUCCESS':
                return clc.green(`[${level}]`);
            case 'WARN':
                return clc.yellow(`[${level}]`);
            case 'ERROR':
                return clc.red(`[${level}]`);
            case 'DEBUG':
                return clc.cyan(`[${level}]`);
            default:
                return `[${level}]`;
        }
    }

    info(message) { this.log(message, 'INFO'); }
    error(message) { this.log(message, 'ERROR'); }
    warn(message) { this.log(message, 'WARN'); }
    success(message) { this.log(message, 'SUCCESS'); }
    debug(message) { this.log(message, 'DEBUG'); }
}

// Create and export singleton instance
const logger = new Logger();
logger.info("Logger initialized");

module.exports = logger;