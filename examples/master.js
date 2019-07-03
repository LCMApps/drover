'use strict';

const {MasterFactory, ExitReasons} = require('../index');

const fooMaster = MasterFactory.create(
    {
        script: 'foo.js',
        count: 4,
        env: {
            PORT: 2099,
            RESPONSE: 'foo'
        }
    }
);

fooMaster.on('worker-exit', async (reason, workerId) => {
    switch (reason.constructor) {
        case ExitReasons.ExternalSignal:
        case ExitReasons.AbnormalExit:
            await fooMaster.restartWorkerById(workerId);
            break;
        default:
            const { code, signal } = reason.payload;
            await quit(code, signal, true);
            break;
    }
});

const barMaster = MasterFactory.create(
    {
        script: 'bar.js',
        count: 2,
        env: {
            PORT: 2098,
            RESPONSE: 'bar'
        }
    }
);

barMaster.on('worker-exit', async (reason, workerId) => {
    switch (reason.constructor) {
        case ExitReasons.ExternalSignal:
        case ExitReasons.AbnormalExit:
            await fooMaster.restartWorkerById(workerId);
            break;
        default:
            const { code, signal } = reason.payload;
            await quit(code, signal, true);
            break;
    }
});

const run = async () => {
    try {
        await Promise.all([fooMaster.start(), barMaster.start()]);
    } catch (err) {
        // log or smthing
        console.error(err);
        return;
    }

    setInterval(() => {
        console.log('Foo: ' + fooMaster.getWorkersStatuses());
        console.log('Bar: ' + barMaster.getWorkersStatuses());
    }, 1000);

    setTimeout(
        async () => await Promise.all([fooMaster.rescale(2), barMaster.rescale(4)]),
        5000
    );

    setTimeout(
        async () => await Promise.all([fooMaster.gracefulReload(), barMaster.gracefulReload()]),
        10000
    );
};

const quit = async (code, signal, force = false) => {
    try {
        if (force) {
            await Promise.all([fooMaster.hardShutdown(), barMaster.hardShutdown()]);
        } else {
            await Promise.all([fooMaster.gracefulShutdown(), barMaster.gracefulShutdown()]);
        }
    } catch (err) {
        // log or smthing
        console.error(err);
    }

    setTimeout(() => process.exit(0), 0);
};

process.on('SIGINT', quit);

run().catch(console.error);
