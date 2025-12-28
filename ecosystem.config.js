// ecosystem.config.js - PM2 PROCESS MANAGER CONFIGURATION
module.exports = {
    apps: [{
        name: 'proxym-tracking',
        script: './server.js',

        // ✅ Clustering for multi-core CPUs
        instances: process.env.NODE_ENV === 'production' ? 'max' : 1,
        exec_mode: 'cluster',

        // ✅ Environment variables
        env_production: {
            NODE_ENV: 'production',
            PORT: 5000
        },
        env_development: {
            NODE_ENV: 'development',
            PORT: 5000
        },

        // ✅ Auto-restart on crashes
        autorestart: true,
        watch: false,
        max_memory_restart: '1G',

        // ✅ Logging
        error_file: './logs/err.log',
        out_file: './logs/out.log',
        log_file: './logs/combined.log',
        time: true,

        // ✅ Graceful shutdown
        kill_timeout: 5000,
        wait_ready: true,
        listen_timeout: 10000
    }]
};