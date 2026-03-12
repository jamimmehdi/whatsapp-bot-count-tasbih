module.exports = {
    apps: [{
        name: 'tasbih-bot',
        script: 'index.js',
        restart_delay: 5000,   // wait 5s before restarting on crash
        max_restarts: 10,
        env: {
            NODE_ENV: 'production',
            PORT: 3000,
            PUPPETEER_EXECUTABLE_PATH: '/usr/bin/chromium-browser',
            DATA_DIR: '/home/ubuntu/tasbih-data',
        }
    }]
};
