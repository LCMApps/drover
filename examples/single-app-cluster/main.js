'use strict';

const { MasterFactory, ExitReasons } = require('../../index');
const _ = require('lodash');
const path = require('path');
const statusMap = _.invert(require('../../src/WorkerStatuses'));

const master = MasterFactory.create(
    {
        script: path.join(__dirname, 'app.js'),
        count: 4,
        env: {
            PORT: 2099,
            RESPONSE: 'single-app-cluster'
        }
    }
);

const quit = async (code, signal, force = false) => {
    try {
        if (force) {
            // in case of emergency stop we just hard quit all worker processes
            await master.hardShutdown();
        } else {
            // for default app exit we do it in more graceful way
            await master.gracefulShutdown();
        }
    } catch (err) {
        // your stop-failed handler logic here
        console.error(err);
    }

    setTimeout(() => process.exit(0), 0);
};

const run = async () => {
    try {
        await master.start();
        // right here we have a guarantee that all 4 app instances
        // already did their business logic (raised connects, started servers, etc)
    } catch (err) {
        // your start-failed handler logic here
        console.error(err);
        return;
    }

    // primitive health-check from master every 2s
    setInterval(() => {
        master.getWorkersStatuses().forEach((v, i) => {
            console.log(`[app-${i}]: ${statusMap[v]}`);
        });
        console.log('---');
    }, 2000);
};

// add listener for 'worker-exit' event to handle different exit reasons up to your main app logic
master.on('worker-exit', async (reason, workerId) => {
    if (reason instanceof ExitReasons.ExternalSignal || reason instanceof ExitReasons.AbnormalExit) {
        // restart worker if something abnormal happened or external process killed worker by signal
        await master.restartWorkerById(workerId);
    } else {
        // for different cases just hard quit all app
        const { code, signal } = reason.payload;
        // quit method will be described in next section
        await quit(code, signal, true);
    }
});

// handle main process SIGINT (default signal in Unix when "ctrl+c" terminal interruption happened)
process.on('SIGINT', quit);

run().catch(console.error);
