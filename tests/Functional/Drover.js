'use strict';

const findProcess = require('find-process');
const chai = require('chai').use(require('chai-http'));
const cluster = require('cluster');
const fs = require('fs');
const {assertThrowsAsync} = require('../support/helpers');
const getPort = require('get-port');
const {Drover, DroverFactory, DroverEvents} = require('../../index');

const {assert, request} = chai;

const appsPath = `${__dirname}/apps`;
const appsSourcePath = `${appsPath}/source`;

describe('Drover', () => {
    let fooPort;
    let drover;

    afterEach(async () => {
        // hard kill all cluster workers and delete current drover
        for (const id in cluster.workers) {
            cluster.workers[id].process.kill('SIGKILL');
        }
        drover = undefined;
        fooPort = undefined;

        // clean up source directory
        fs.readdirSync(appsSourcePath + '/', (err, files) => {
            if (err) throw err;

            for (const file of files) {
                if (file !== '.gitignore') {
                    fs.unlinkSync(appsSourcePath + '/' + file);
                }
            }
        });
    });

    it('not started on construct', async () => {
        fooPort = await getPort();
        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  1,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let sheepStatusChangeFired = false;
        drover.on(DroverEvents.SHEEP_STATUS_CHANGE, () => { sheepStatusChangeFired = true; });

        const processList = await findProcess('name', 'droverTestApp_');

        assert.isFalse(sheepStatusChangeFired);
        assert.isEmpty(processList);
        assert.equal(Drover.STATUS_SHUTTED_DOWN, drover.getStatus());
        assert.isEmpty(drover.getHealthState());
    });

    it('started foo:1 > gracefully stopped > gracefully shut down', async () => {
        let expectedInstanceCount = 1;

        fooPort = await getPort();

        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  expectedInstanceCount,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let fooResponse = 'foo';

        fs.writeFileSync(`${appsSourcePath}/response_foo.txt`, fooResponse);

        drover.on(DroverEvents.ERROR, () => { assert.fail('Error fired'); });

        // starting
        await drover.start();
        let processList = await findProcess('name', 'droverTestApp_foo');
        let res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // stopping
        await drover._gracefulStop();
        processList = await findProcess('name', 'droverTestApp_foo');

        await assertThrowsAsync(
            () => request(`http://localhost:${fooPort}`).get('/'),
            Error,
            /connect ECONNREFUSED/,
        );

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(expectedInstanceCount, drover.getHealthState().length);

        // shut down
        expectedInstanceCount = 0;
        await drover.gracefulShutdown();
        processList = await findProcess('name', 'droverTestApp_foo');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(Drover.STATUS_SHUTTED_DOWN, drover.getStatus());
        assert.equal(expectedInstanceCount, drover.getHealthState().length);
    });

    it('started foo:2 > scale foo:4', async () => {
        let expectedInstanceCount = 2;

        fooPort = await getPort();

        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  expectedInstanceCount,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let fooResponse = 'foo';

        fs.writeFileSync(`${appsSourcePath}/response_foo.txt`, fooResponse);

        drover.on(DroverEvents.ERROR, () => { assert.fail('Error fired'); });

        // starting
        await drover.start();
        let processList = await findProcess('name', 'droverTestApp_foo');
        let res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // scale to 4
        expectedInstanceCount = 4;
        await drover.scalePopulation(expectedInstanceCount);
        processList = await findProcess('name', 'droverTestApp_foo');
        res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());
    });

    it('started foo:4 > scale foo:2', async () => {
        let expectedInstanceCount = 4;

        fooPort = await getPort();

        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  expectedInstanceCount,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let fooResponse = 'foo';

        fs.writeFileSync(`${appsSourcePath}/response_foo.txt`, fooResponse);

        drover.on(DroverEvents.ERROR, () => { assert.fail('Error fired'); });

        // starting
        await drover.start();
        let processList = await findProcess('name', 'droverTestApp_foo');
        let res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // scale to 2
        expectedInstanceCount = 2;
        await drover.scalePopulation(expectedInstanceCount);
        processList = await findProcess('name', 'droverTestApp_foo');
        res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());
    });

    it('started foo:4 > scale foo:2 > scale foo:4', async () => {
        let expectedInstanceCount = 4;

        fooPort = await getPort();

        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  expectedInstanceCount,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let fooResponse = 'foo';

        fs.writeFileSync(`${appsSourcePath}/response_foo.txt`, fooResponse);

        drover.on(DroverEvents.ERROR, () => { assert.fail('Error fired'); });

        // starting
        await drover.start();
        let processList = await findProcess('name', 'droverTestApp_foo');
        let res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // scale to 2
        expectedInstanceCount = 2;
        await drover.scalePopulation(expectedInstanceCount);
        processList = await findProcess('name', 'droverTestApp_foo');
        res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // scale to 4
        expectedInstanceCount = 4;
        await drover.scalePopulation(expectedInstanceCount);
        processList = await findProcess('name', 'droverTestApp_foo');
        res = await request(`http://localhost:${fooPort}`).get('/');

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());
    });

    it('started foo:2 > graceful reload', async () => {
        let expectedInstanceCount = 2;

        fooPort = await getPort();

        const options = {
            script: `${appsPath}/droverTestApp_foo.js`,
            count:  expectedInstanceCount,
            env:    {PORT: fooPort},
        };
        drover = DroverFactory.create(options);

        let fooResponse = 'foo';

        fs.writeFileSync(`${appsSourcePath}/response_foo.txt`, fooResponse);

        drover.on(DroverEvents.ERROR, () => { assert.fail('Error fired'); });

        // starting
        await drover.start();
        let processList = await findProcess('name', 'droverTestApp_foo');
        let res = await request(`http://localhost:${fooPort}`).get('/');
        const startedPidMap = processList.map(p => p.pid);

        assert.equal(expectedInstanceCount, processList.length);
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());

        // graceful reload
        await drover.gracefulReload();
        processList = await findProcess('name', 'droverTestApp_foo');
        res = await request(`http://localhost:${fooPort}`).get('/');
        const reloadedPidMap = processList.map(p => p.pid);

        assert.isEmpty(reloadedPidMap.filter(pid => startedPidMap.includes(pid)));
        assert.equal(200, res.status);
        assert.equal(fooResponse, res.text);
        assert.equal(Drover.STATUS_STARTED, drover.getStatus());
        assert.isEmpty(drover.getHealthState());
    });
});
