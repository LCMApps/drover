'use strict';

const cluster = require('cluster');
const debug = require('debug')('drover:messageBus');
const _ = require('lodash');
const {EventEmitter} = require('events');
const WorkerStatuses = require('./WorkerStatuses');
const Commands = require('./Commands');
const {InvalidClusterContextError, InvalidArgumentError} = require('./Error');

class MessageBus extends EventEmitter {
    constructor() {
        super();

        if (cluster.isWorker) {
            this._status = WorkerStatuses.INITIALIZED;

            process.on('message', async (msg) => {
                debug(`on.message: ${msg}`);
                switch (msg) {
                    case Commands.STOP:
                        await this._changeStatus(WorkerStatuses.STOPPING);
                        setImmediate(() => this.emit(Commands.STOP));
                        break;
                    case Commands.QUIT:
                        await this._changeStatus(WorkerStatuses.SHUTTING_DOWN);
                        setImmediate(() => this.emit(Commands.QUIT));
                        break;
                    default:
                        break;
                }
            });

            this.sendStarted = this.sendStarted.bind(this);
            this.sendStopped = this.sendStopped.bind(this);
            this.sendShuttedDown = this.sendShuttedDown.bind(this);

            process
                .removeAllListeners('SIGTERM')
                .on('SIGTERM', function () {});

            process
                .removeAllListeners('SIGINT')
                .on('SIGINT', function () {});
        } else {
            throw new InvalidClusterContextError('MessageBus usage allowed only with worker context');
        }
    }

    sendStarted() {
        return this._changeStatus(WorkerStatuses.STARTED);
    }

    sendStopped() {
        return this._changeStatus(WorkerStatuses.STOPPED);
    }

    sendShuttedDown() {
        return this._changeStatus(WorkerStatuses.SHUTTED_DOWN);
    }

    /**
     * @param {*} message
     * @returns {Promise}
     */
    sendMessage(message) {
        debug('sendMessage: %o', message);

        return new Promise(resolve => {
            process.send(message, null, resolve);
        });
    }

    /**
     * @param {string} event
     * @param {*} payload
     * @returns {Promise}
     */
    _ipcEventEmit(event, payload) {
        debug('_ipcEventEmit: %o', {event, payload});

        if (!_.isString(event)) {
            throw new InvalidArgumentError('"event" must be string');
        }

        return this.sendMessage({event, payload});
    }

    /**
     * @param {Number} status
     * @private
     */
    async _changeStatus(status) {
        debug('_changeStatus: %d', status);

        if (this._status !== status) {
            await this._ipcEventEmit('status-changed', status);

            this._status = status;
        }
    }
}

module.exports = MessageBus;
