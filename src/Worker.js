const _ = require('lodash');
const cluster = require('cluster');
const debug = require('debug')('drover:worker');
const {
    InvalidClusterContextError,
    InvalidArgumentError,
    UnexpectedWorkerState,
    WorkerStatusError,
} = require('./Error');
const {EventEmitter} = require('events');
const WorkerStatuses = require('./WorkerStatuses');
const Commands = require('./Commands');
const ExitReasons = require('./ExitReasons');

class Worker extends EventEmitter {
    constructor(config) {
        super();

        if (!cluster.isMaster) {
            throw new InvalidClusterContextError('Master usage allowed only with master cluster context');
        }

        this._config = _.cloneDeep(config);

        this._worker = undefined;
        this._status = WorkerStatuses.INITIALIZED;

        this._assureStatusSequence = this._assureStatusSequence.bind(this);

        this._errorHandler = this._errorHandler.bind(this);
        this._onlineHandler = this._onlineHandler.bind(this);
        this._exitHandler = this._exitHandler.bind(this);
        this._messageHandler = this._messageHandler.bind(this);
    }

    /**
     * @returns {Promise}
     */
    async start() {
        return new Promise((resolve, reject) => {
            const {script, env} = this._config;

            if (this.getCurrentStatus() !== WorkerStatuses.INITIALIZED) {
                return reject(new UnexpectedWorkerState('Worker could start only from INITIALIZED status.'));
            }

            try {
                cluster.setupMaster({exec: script});
                this._worker = cluster.fork(env);

                this._worker.on('error', this._errorHandler);
                this._worker.once('online', this._onlineHandler);
                this._worker.once('exit', this._exitHandler);
                this._worker.on('message', this._messageHandler);

                this.once('start-failed', reject);

                this._assureStatusSequence([WorkerStatuses.STARTING, WorkerStatuses.STARTED])
                    .then(resolve)
                    .catch(reject);
            } catch (err) {
                this._errorHandler(err);
                this.removeListener('start-failed', reject);

                if (typeof this._worker !== 'undefined') {
                    this._worker.removeAllListeners();
                }

                return reject(err);
            }
        });
    }

    async stop() {
        if (typeof this._worker !== 'undefined') {
            await this._sendMessage(Commands.STOP);

            return this._assureStatusSequence([WorkerStatuses.STOPPING, WorkerStatuses.STOPPED]);
        }

        return Promise.resolve();
    }

    /**
     * @param force
     * @returns {Promise}
     */
    async quit(force = false) {
        if (force) {
            this._worker.process.kill('SIGKILL');
            return Promise.resolve();
        }

        await this._sendMessage(Commands.QUIT);

        return this._assureStatusSequence([WorkerStatuses.SHUTTING_DOWN, WorkerStatuses.SHUTTED_DOWN]);
    }

    /**
     * @returns {number|undefined}
     */
    getId() {
        return this._worker && this._worker.id;
    }

    /**
     * @returns {number}
     */
    getCurrentStatus() {
        return this._status;
    }

    /**
     * @param {number[]} expectedStatusSequence
     * @returns {Promise<any>}
     * @private
     */
    async _assureStatusSequence(expectedStatusSequence) {
        return new Promise((resolve, reject) => {
            try {
                const statusChangedHandler = actualStatus => {
                    const expectedStatus = expectedStatusSequence.shift();
                    debug('_assureStatusSequence: %o', {actualStatus, expectedStatus});

                    if (actualStatus !== expectedStatus) {
                        return reject(
                            new WorkerStatusError('Unexpected worker status', { expectedStatus, actualStatus })
                        );
                    }

                    if (expectedStatusSequence.length === 0) {
                        this.removeListener('status-changed', statusChangedHandler);
                        return resolve();
                    }
                };

                this.on('status-changed', statusChangedHandler);
            } catch (err) {
                this.emit('error', err, this.getId());

                return reject(err);
            }
        });
    }

    /**
     * @param {{}} err
     * @private
     */
    _errorHandler(err) {
        debug('_errorHandler: %o', err);

        if (this.getCurrentStatus() === WorkerStatuses.STARTING) {
            this.emit('start-failed', err, this.getId());
        } else if (this.getCurrentStatus() === WorkerStatuses.STOPPING) {
            this.emit('stop-failed', err, this.getId());
        } else {
            this._changeStatus(WorkerStatuses.FAILED);
            this.emit('error', err, this.getId());
        }
    }

    _onlineHandler() {
        debug('_onlineHandler');

        if (this.getCurrentStatus() !== WorkerStatuses.INITIALIZED) {
            this.emit(
                'start-failed',
                new UnexpectedWorkerState('IPC could be online only on initialized state'),
                this.getId()
            );
            return;
        }

        this._changeStatus(WorkerStatuses.STARTING);
    }

    /**
     * @param {number} code
     * @param {string} signal
     * @private
     */
    _exitHandler(code, signal) {
        debug('_exitHandler: %o', { code, signal });

        switch (this._status) {
            case WorkerStatuses.STOPPING:
            case WorkerStatuses.SHUTTING_DOWN:
                this._changeStatus(this._status);

                if (code === 0) {
                    this.emit('exit', new ExitReasons.NormalExit({ code }), this.getId());
                }

                break;
            default:
                this._changeStatus(WorkerStatuses.FAILED);

                if (signal) {
                    this.emit('exit', new ExitReasons.ExternalSignal({ signal }), this.getId());
                } else {
                    this.emit('exit', new ExitReasons.AbnormalExit({ code }), this.getId());
                }

                break;
        }
    }

    /**
     * @param {Object} message
     * @private
     */
    _messageHandler(message) {
        debug('_messageHandler: %o', message);

        if (_.isPlainObject(message) && _.isString(message.event)) {
            const {event} = message;

            switch (event) {
                case 'status-changed':
                    try {
                        this._changeStatus(message.payload);
                    } catch (err) {
                        debug('_messageHandler#status-changed:error %O', err);
                    }
                    break;
                default:
                    debug('Unknown event: %s', event);
                    break;
            }
        }
    }

    /**
     * @param {*} message
     * @returns {Promise}
     * @private
     */
    async _sendMessage(message) {
        debug('_sendMessage: %o', message);

        return new Promise((resolve, reject) => {
            this._worker.send(message, null, err => {
                if (err) {
                    return reject(err);
                }

                return resolve();
            });
        });
    }

    /**
     * @param {number} status
     * @private
     */
    _changeStatus(status) {
        debug('_changeStatus: %d', status);

        if (!_.values(WorkerStatuses).includes(status)) {
            throw new InvalidArgumentError(`Invalid status '${status}' given`);
        }

        if (this._status !== status) {
            this._status = status;

            this.emit('status-changed', status);
        }
    }

    toJSON() {
        return {
            id: this.getId(),
            script: this._config.script,
            env: this._config.env
        };
    }
}

module.exports = Worker;
