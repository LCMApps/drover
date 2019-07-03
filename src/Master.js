'use strict';

const _ = require('lodash');
const cluster = require('cluster');
const debug = require('debug')('drover:master');
const fs = require('fs');
const {EventEmitter} = require('events');
const Worker = require('./Worker');
const {
    InvalidArgumentError,
    InappropriateConditionError,
    InvalidConfigurationError,
    AlreadyInitializedError,
    InvalidClusterContextError,
} = require('./Error');

class Master extends EventEmitter {
    static get STATUS_SHUTTED_DOWN() {
        return 1;
    }

    static get STATUS_STARTING() {
        return 2;
    }

    static get STATUS_STARTED() {
        return 3;
    }

    static get STATUS_STOPPING() {
        return 4;
    }

    static get STATUS_STOPPED() {
        return 5;
    }

    /**
     * @param {{config: Object, signals: Object}}
     * @emits Master#workers-status-change proto, status
     * @throws InvalidConfigurationError
     * @throws InvalidClusterContextError
     */
    constructor({config, signals}) {
        super();

        if (!cluster.isMaster) {
            throw new InvalidClusterContextError('Master usage allowed only with master context');
        }

        this._assertConfig(config);
        this._assertSignals(signals);

        this._config = _.cloneDeep(config);

        const { count } = this._config;

        this._scale = count;
        this._workerCollection = this._createWorkerCollection(count);
        this._status = Master.STATUS_SHUTTED_DOWN;

        if (signals.reload) {
            process.on(signals.reload, this.gracefulReload.bind(this));
        }

        if (signals.shutdown) {
            process.on(signals.shutdown, this.gracefulShutdown.bind(this));
        }

        cluster.schedulingPolicy = this._config.schedulingPolicy;
    }

    getConfig() {
        return _.cloneDeep(this._config);
    }

    getStatus() {
        return this._status;
    }

    /**
     * Starts service and resolves promise with initial collection.
     *
     * Promise will be rejected with:
     *   `AlreadyInitializedError` if service is already started.
     *   `InvalidConfigurationError` if collection members have invalid configuration.
     *
     * Rejection of promise means that all half-state worker were sendStopped and no retries will be done.
     *
     * @return {Promise}
     * @emits Master#sendStarted initialized collection size
     * @emits Master#error `InvalidConfigurationError` err
     */
    async start() {
        if (![Master.STATUS_SHUTTED_DOWN, Master.STATUS_STOPPED].includes(this._status)) {
            throw new AlreadyInitializedError('Master has already started or is starting right now');
        }

        this._status = Master.STATUS_STARTING;

        await this._startGroup(this._workerCollection);

        this._status = Master.STATUS_STARTED;
    }

    /**
     * @return {number[]}
     */
    getWorkersStatuses() {
        return this._workerCollection.map(worker => worker.getCurrentStatus());
    }

    /**
     * Gracefully scales worker number to defined size
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for rescaling.
     *   `InvalidArgumentError` if invalid scale size provided.
     *
     * @param {Number} size
     * @returns {Promise}
     */
    async rescale(size) {
        return new Promise(async (resolve, reject) => {
            if (size <= 0) {
                return reject(new InvalidArgumentError('Scale size must be positive', {size}));
            }

            if (this._status !== Master.STATUS_STARTED) {
                return reject(
                    new InappropriateConditionError('Action allowed only for started masters', {status: this._status}),
                );
            }

            this._scale = size;

            try {
                const currentCount = this._workerCollection.length;
                const delta = size - currentCount;

                if (delta > 0) {
                    const newcomers = this._createWorkerCollection(delta);

                    await this._startGroup(newcomers);

                    this._workerCollection.push(...newcomers);
                } else if (delta < 0) {
                    const victims = this._workerCollection.splice(0, Math.abs(delta));

                    await this._killGroup(victims);
                }

                return resolve(delta);
            } catch (err) {
                return reject(err);
            }
        });
    }

    /**
     * Gracefully stops and shuts down every worker in collection. Collection will be empty.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for shutting down.
     *   `WorkerStatusError` if some worker in inappropriate state
     *
     * @emits Master#error `WorkerStatusError` err
     */
    async gracefulShutdown() {
        if (![Master.STATUS_STARTED, Master.STATUS_STOPPED].includes(this._status)) {
            throw new InappropriateConditionError('Action allowed only for stable masters', {status: this._status});
        }

        if (this._status !== Master.STATUS_STOPPED) {
            await this._gracefulStop();
        }

        await this._killGroup(this._workerCollection);

        this._workerCollection = [];
        this._status = Master.STATUS_SHUTTED_DOWN;
    }

    /**
     * Hard kill every worker in collection. Collection will be empty.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for shutting down.
     *   `WorkerStatusError` if some worker in inappropriate state
     *
     * @return {Promise}
     * @emits Master#error `WorkerStatusError` err
     */
    async hardShutdown() {
        await this._killGroup(this._workerCollection, true);

        this._status = Master.STATUS_SHUTTED_DOWN;
    }

    /**
     * Gracefully reloads service. Every worker in collection will be cloned and released but not started.
     * When newcomers are sendStarted - rolling update will begin.
     * When every newcomer is started and every old worker is sendStopped - old worker will shut down
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for stop.
     *   `WorkerStatusError` if some worker in inappropriate state
     *
     * @return {Promise}
     * @emits Master#error `WorkerStatusError` err
     */
    async gracefulReload() {
        if (this._status !== Master.STATUS_STARTED) {
            throw new InappropriateConditionError('Action allowed only for started masters', {status: this._status});
        }

        const oldWorkers = _.cloneDeep(this._workerCollection);

        this._workerCollection = this._createWorkerCollection(this._scale);

        await this._startGroup(this._workerCollection);

        await this._stopGroup(oldWorkers);

        await this._killGroup(oldWorkers);
    }

    /**
     * @param {number} workerId
     * @returns {Promise<void>}
     */
    async restartWorkerById(workerId) {
        debug('restartWorkerById: %d', workerId);

        const index = this._workerCollection.findIndex(worker => worker.getId() === workerId);

        if (index !== -1) {
            await this._workerCollection[index].quit(true);

            const worker = this._instantiateWorker();
            await worker.start();

            this._workerCollection.splice(index, 1, worker);
        }
    }

    /**
     * @param {Object} config
     * @private
     * @throws InvalidConfigurationError
     */
    _assertConfig(config) {
        if (!_.isPlainObject(config)) {
            throw new InvalidConfigurationError('"config" must be a plain object');
        }

        if (!_.has(config, 'schedulingPolicy') ||
          ![cluster.SCHED_NONE, cluster.SCHED_RR].includes(config.schedulingPolicy)) {
            throw new InvalidConfigurationError('Invalid cluster schedulingPolicy value');
        }

        if (!Number.isSafeInteger(config.restartTimeout) || config.restartTimeout <= 0) {
            throw new InvalidConfigurationError('"config.restartTimeout" must be a positive number');
        }

        if (!Number.isSafeInteger(config.statusTimeout) || config.statusTimeout <= 0) {
            throw new InvalidConfigurationError('"config.statusTimeout" must be a positive number');
        }

        if (!Number.isSafeInteger(config.count) || config.count <= 0) {
            throw new InvalidConfigurationError('"config.count" must be a positive number');
        }

        if (!_.isPlainObject(config.env)) {
            throw new InvalidConfigurationError('"config.env" must be a plain object');
        }

        if (!_.isString(config.script) || !fs.lstatSync(config.script).isFile()) {
            throw new InvalidConfigurationError('"config.script" must be a valid file path');
        }
    }

    /**
     * @param {Object} signals
     * @private
     * @throws InvalidConfigurationError
     */
    _assertSignals(signals) {
        // there are no assertions of specific values of posix signals for the simplicity
        if ((_.has(signals, 'reload') && !_.isString(signals.reload))
          || (_.has(signals, 'shutdown') && !_.isString(signals.shutdown))
        ) {
            throw new InvalidConfigurationError('signals must be a strings');
        }
    }

    /**
     * Gracefully stops worker in collection. Collection composition won't change.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for stop.
     *   `WorkerStatusError` if some worker in inappropriate state
     *
     * @return {Promise}
     * @emits Master#error `WorkerStatusError` err
     */
    async _gracefulStop() {
        if (this._status !== Master.STATUS_STARTED) {
            throw new InappropriateConditionError('Action allowed only for started masters', {status: this._status});
        }

        this._status = Master.STATUS_STOPPING;

        await this._stopGroup(this._workerCollection);

        this._status = Master.STATUS_STOPPED;
    }

    /**
     * @param {number} count
     * @returns {Worker[]}
     * @private
     */
    _createWorkerCollection(count) {
        debug('_createWorkerCollection: %d', count);

        let workerCollection = [];

        for (let i = 0; i < count; i++) {
            workerCollection.push(this._instantiateWorker());
        }

        return workerCollection;
    }

    /**
     * @returns {Worker}
     * @private
     */
    _instantiateWorker() {
        const { script, env } = this._config;

        const worker = new Worker({ script, env });

        worker.once('exit', (reason, workerId) => {
            this.emit('worker-exit', reason, workerId);
        });
        worker.once('stop-failed', (err, workerId) => {
            this._workerCollection = this._workerCollection.filter(worker => worker.getId() !== workerId);
        });

        return worker;
    }

    /**
     * @param {Worker[]} workerCollection
     * @return {Promise}
     * @private
     */
    async _startGroup(workerCollection) {
        debug('_startGroup: %O', workerCollection.map(worker => worker.toJSON()));

        for (let i = 0; i < workerCollection.length; i++) {
            await workerCollection[i].start();
        }
    }

    /**
     * @param {Worker[]} workerCollection
     * @return {Promise}
     * @private
     */
    async _stopGroup(workerCollection) {
        debug('_stopGroup: %O', workerCollection.map(worker => worker.toJSON()));

        for (let i = 0; i < workerCollection.length; i++) {
            await workerCollection[i].stop();
        }
    }

    /**
     * @param {Worker[]} workerCollection
     * @param {Boolean} isHard
     * @return {Promise}
     * @private
     */
    async _killGroup(workerCollection, isHard = false) {
        debug('_killGroup: %O', workerCollection.map(worker => worker.toJSON()));

        for (let i = 0; i < workerCollection.length; i++) {
            await workerCollection[i].quit(isHard);
        }
    }
}

module.exports = Master;
