const { spawn } = require('child_process');
const path = require('path');

console.log('🚀 [24/7 Watchdog] Initializing auto-restart daemon for Global Store Bot...');
let restartCount = 0;

function startBotProcess() {
  console.log(`⚡ [24/7 Watchdog] Starting bot process (Attempt #${++restartCount}) at ${new Date().toISOString()}`);
  
  const child = spawn('node', ['index.js'], {
    cwd: __dirname,
    stdio: 'inherit',
    env: process.env
  });

  child.on('exit', (code, signal) => {
    console.warn(`⚠️ [24/7 Watchdog] Process exited with code ${code} and signal ${signal}. Restarting in 2 seconds...`);
    setTimeout(startBotProcess, 2000);
  });

  child.on('error', (err) => {
    console.error('❌ [24/7 Watchdog] Failed to start process:', err.message);
    setTimeout(startBotProcess, 3000);
  });
}

startBotProcess();
