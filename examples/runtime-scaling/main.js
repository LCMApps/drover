'use strict';

const { MasterFactory, ExitReasons } = require('../../index');
const _ = require('lodash');
const path = require('path');
const statusMap = _.invert(require('../../src/WorkerStatuses'));

const fooMaster = MasterFactory.create(
    {
        script: path.join(__dirname, 'app-foo.js'),
        count: 4,
        env: {
            PORT: 2104,
            RESPONSE: 'multi-app-cluster'
        }
    }
);

const barMaster = MasterFactory.create(
    {
        script: path.join(__dirname, 'app-bar.js'),
        count: 2,
        env: {
            PORT: 2105,
            RESPONSE: 'multi-app-cluster'
        }
    }
);

// add listener for 'worker-exit' event to handle different exit reasons up to your main app logic
fooMaster.on('worker-exit', async (reason, workerId) => {
    switch (reason.constructor) {
        case ExitReasons.ExternalSignal:
        case ExitReasons.AbnormalExit:
            // restart worker if something abnormal happened or external process killed worker by signal
            await fooMaster.restartWorkerById(workerId);
            break;
        default:
            // for different cases just hard quit all app
            const { code, signal } = reason.payload;
            await quit(code, signal, true);
            break;
    }
});

barMaster.on('worker-exit', async (reason, workerId) => {
    switch (reason.constructor) {
        case ExitReasons.ExternalSignal:
        case ExitReasons.AbnormalExit:
            // restart worker if something abnormal happened or external process killed worker by signal
            await barMaster.restartWorkerById(workerId);
            break;
        default:
            // for different cases just hard quit all app
            const { code, signal } = reason.payload;
            await quit(code, signal, true);
            break;
    }
});

const run = async () => {
    try {
        await Promise.all([fooMaster.start(), barMaster.start()]);
        // right here we have a guarantee that all 4 app instances
        // already did their business logic (raised connects, started servers, etc)
    } catch (err) {
        // your start-failed handler logic here
        console.error(err);
        return;
    }

    // after 5s just swap apps scale - foo goes 2, bar goes 4
    setTimeout(async () => {
        await Promise.all([fooMaster.rescale(2), barMaster.rescale(4)]);
    }, 5000);

    // primitive health-check from master every 2s
    setInterval(() => {
        fooMaster.getWorkersStatuses().forEach((v, i) => {
            console.log(`[foo-${i}]: ${statusMap[v]}`);
        });
        barMaster.getWorkersStatuses().forEach((v, i) => {
            console.log(`[bar-${i}]: ${statusMap[v]}`);
        });
        console.log('---');
    }, 2000);
};

const quit = async (code, signal, force = false) => {
    try {
        if (force) {
            // in case of emergency stop we just hard quit all worker processes
            await Promise.all([fooMaster.hardShutdown(), barMaster.hardShutdown()]);
        } else {
            // for default app exit we do it in more graceful way
            await Promise.all(
                [fooMaster.gracefulShutdown(), barMaster.gracefulShutdown()]
            );
        }
    } catch (err) {
        // your stop-failed handler logic here
        console.error(err);
    }

    setTimeout(() => process.exit(0), 0);
};

// handle main process SIGINT (default signal in Unix when "ctrl+c" terminal interruption happened)
process.on('SIGINT', quit);

run().catch(console.error);
