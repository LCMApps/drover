'use strict';

const express = require('express');
const { MessageBus } = require('../../index');
const { PORT, RESPONSE } = process.env;

if (!PORT) {
    console.warn('For this example PORT env var required');
    process.exit(1);
}

if (!RESPONSE) {
    console.warn('For this example RESPONSE env var required');
    process.exit(1);
}

const messageBus = new MessageBus();

messageBus.on('stop', () => {
    server.close(messageBus.sendStopped);
});

messageBus.on('quit', () => {
    messageBus.sendShuttedDown();
    setTimeout(() => process.exit(0), 50);
});

const app = express().get('/', (req, res) => {
    res.send(RESPONSE);
});

const server = app.listen(PORT, messageBus.sendStarted);
