'use strict';

const cluster        = require('cluster');
const {EventEmitter} = require('events');
const SheepEvents    = require('./SheepEvents');
const Commands       = require('./Commands');

class Sheep extends EventEmitter {
    static get STATUS_WAITING() {
        return 1;
    }

    static get STATUS_READY() {
        return 2;
    }

    static get STATUS_STARTING() {
        return 3;
    }

    static get STATUS_STARTED() {
        return 4;
    }

    static get STATUS_TERMINATING() {
        return 5;
    }

    static get STATUS_STOPPING() {
        return 6;
    }

    static get STATUS_STOPPED() {
        return 7;
    }

    static get STATUS_SHUTTING_DOWN() {
        return 8;
    }

    static get STATUS_SHUT_DOWN() {
        return 9;
    }

    constructor() {
        super();

        if (cluster.isWorker) {
            this._status = Sheep.STATUS_WAITING;

            process.on('message', (msg) => {
                switch (msg) {
                    case Commands.SHUTDOWN:
                        this._changeStatus(Sheep.STATUS_SHUTTING_DOWN);
                        this.emit(SheepEvents.SHUTTING_DOWN, this.shutDown.bind(this));
                        break;
                    case Commands.START:
                        this._changeStatus(Sheep.STATUS_STARTING);
                        this.emit(SheepEvents.STARTING, this.started.bind(this));
                        break;
                    case Commands.STOP:
                        this._changeStatus(Sheep.STATUS_STOPPING);
                        this.emit(SheepEvents.STOPPING, this.stopped.bind(this));
                        break;
                    default:
                        break;
                }
            });

            this.on(SheepEvents.STATUS_CHANGE, status => {
                Sheep._messageToDrover({status});
            });

            process.on('SIGTERM', this.terminating.bind(this));
            process.on('SIGINT', function () {});
        }
    }

    ready() {
        this._changeStatus(Sheep.STATUS_READY);
    }

    terminating() {
        this._changeStatus(Sheep.STATUS_TERMINATING);
    }

    started() {
        this._changeStatus(Sheep.STATUS_STARTED);
    }

    stopped() {
        this._changeStatus(Sheep.STATUS_STOPPED);
    }

    shutDown() {
        this._changeStatus(Sheep.STATUS_SHUT_DOWN);
    }

    /**
     * @param {Number} status
     * @private
     */
    _changeStatus(status) {
        if (this._status !== status) {
            this._status = status;
            this.emit(SheepEvents.STATUS_CHANGE, status);
        }
    }

    /**
     * @param {{}} msg
     * @private
     */
    static _messageToDrover(msg) {
        if (cluster.isWorker) {
            process.send(msg);
        }
    }
}

module.exports = Sheep;
