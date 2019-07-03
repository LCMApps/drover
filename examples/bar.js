'use strict';

const express = require('express');
const {MessageBus} = require('../index');

const { PORT, RESPONSE } = process.env;

if (!PORT) {
    console.warn('Port env required');
    process.exit(1);
}

if (!RESPONSE) {
    console.warn('Response source in empty');
    process.exit(1);
}

const messageBus = new MessageBus();

const app = express().get('/', (req, res) => {
    res.send('bar:' + RESPONSE);
});

messageBus.on('stop', () => {
    server.close(messageBus.sendStopped);
});

messageBus.on('quit', () => {
    messageBus.sendShuttedDown();
    setTimeout(() => process.exit(0), 50);
});

const server = app.listen(PORT, messageBus.sendStarted);
