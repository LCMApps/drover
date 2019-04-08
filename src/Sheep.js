'use strict';

const cluster = require('cluster');
const {EventEmitter} = require('events');
const SheepEvents = require('./SheepEvents');
const Commands = require('./Commands');
const {InvalidClusterContextError} = require('./Error');

class Sheep extends EventEmitter {
    static get STATUS_WAITING() {
        return 1;
    }

    static get STATUS_READY() {
        return 2;
    }

    static get STATUS_STOPPING() {
        return 3;
    }

    static get STATUS_STOPPED() {
        return 4;
    }

    static get STATUS_SHUTTING_DOWN() {
        return 5;
    }

    static get STATUS_SHUTTED_DOWN() {
        return 6;
    }

    constructor() {
        super();

        if (cluster.isWorker) {
            this._status = Sheep.STATUS_WAITING;

            process.on('message', (msg) => {
                switch (msg) {
                    case Commands.STOP:
                        this._changeStatus(Sheep.STATUS_STOPPING);
                        this.emit(SheepEvents.STOPPING);
                        break;
                    case Commands.SHUTDOWN:
                        this._changeStatus(Sheep.STATUS_SHUTTING_DOWN);
                        this.emit(SheepEvents.SHUTTING_DOWN);
                        break;
                    default:
                        break;
                }
            });

            this.ready = this.ready.bind(this);
            this.stopped = this.stopped.bind(this);
            this.shuttedDown = this.shuttedDown.bind(this);

            process
                .removeAllListeners('SIGTERM')
                .on('SIGTERM', function () {});

            process
                .removeAllListeners('SIGINT')
                .on('SIGINT', function () {});
        } else {
            throw new InvalidClusterContextError('Sheep usage allowed only with worker context');
        }
    }

    ready() {
        this._changeStatus(Sheep.STATUS_READY);
    }

    stopped() {
        this._changeStatus(Sheep.STATUS_STOPPED);
    }

    shuttedDown() {
        this._changeStatus(Sheep.STATUS_SHUTTED_DOWN);
    }

    /**
     * @param {*} message
     */
    say(message) {
        process.send(message);
    }

    /**
     * @param {Number} status
     * @private
     */
    _changeStatus(status) {
        if (this._status !== status) {
            this._status = status;
            this.say({status});

            setImmediate(() => this.emit(SheepEvents.STATUS_CHANGE, status));
        }
    }
}

module.exports = Sheep;
