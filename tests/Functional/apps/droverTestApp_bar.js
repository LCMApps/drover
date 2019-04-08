'use strict';

const express = require('express');
const fs = require('fs');
const Sheep = require('../../../src/Sheep');
const SheepEvents = require('../../../src/SheepEvents');

const PORT = process.env.PORT;
// read response from file emulate real source change between graceful reloads in tests
const RESPONSE = fs.readFileSync(`${__dirname}/source/response_bar.txt`, console.log).toString();

if (!PORT) {
    console.warn('Port env required');
    process.exit(1);
}

if (!RESPONSE) {
    console.warn('Response source in empty');
    process.exit(1);
}

const sheep = new Sheep();

const app = express().get('/', (req, res) => {
    res.send(RESPONSE);
});

sheep.on(SheepEvents.STOPPING, () => {
    server.close(sheep.stopped);
});

sheep.on(SheepEvents.SHUTTING_DOWN, () => {
    setTimeout(() => process.exit(0), 0);
    sheep.shuttedDown();
});

const server = app.listen(PORT, sheep.ready);
