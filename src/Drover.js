'use strict';

const _ = require('lodash');
const cluster = require('cluster');
const fs = require('fs');
const {EventEmitter} = require('events');
const DroverEvents = require('./DroverEvents');
const Commands = require('./Commands');
const Sheep = require('./Sheep');
const {
    SheepStateError,
    InvalidArgumentError,
    HerdCriteriaError,
    InappropriateConditionError,
    InvalidConfigurationError,
    AlreadyInitializedError,
    InvalidClusterContextError,
} = require('./Error');

class Drover extends EventEmitter {
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
     * @param {{herd: Object, signals: Object, config: Object=, statusManager: SheepStatusManager}}
     * @emits Drover#sheep-status-change proto, status
     * @throws InvalidConfigurationError
     * @throws InvalidClusterContextError
     */
    constructor({herd, signals, config, statusManager}) {
        super();

        if (!cluster.isMaster) {
            throw new InvalidClusterContextError('Drover usage allowed only with master context');
        }

        this._assertConfig(config);
        this._assertHerd(herd);
        this._assertSignals(signals);

        this._config = _.cloneDeep(config);

        this._herd = [];
        this._scale = 0;
        this._protoCollection = this._createProtoCollection(herd);
        this._status = Drover.STATUS_SHUTTED_DOWN;
        this._sheepStatusManager = statusManager.bindDrover(this);

        this._release = this._release.bind(this);
        this._stop = this._stop.bind(this);

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
     * Starts service and resolves promise with initial herd.
     *
     * Promise will be rejected with:
     *   `AlreadyInitializedError` if service is already started.
     *   `InvalidConfigurationError` if herd members have invalid configuration.
     *
     * Rejection of promise means that all half-state sheep were stopped and no retries will be done.
     *
     * @return {Promise}
     * @emits Drover#ready initialized herd size
     * @emits Drover#error `InvalidConfigurationError` err
     */
    async start() {
        if (![Drover.STATUS_SHUTTED_DOWN, Drover.STATUS_STOPPED].includes(this._status)) {
            throw new AlreadyInitializedError('Drover has already started or is starting right now');
        }

        this._status = Drover.STATUS_STARTING;

        const protoCollection = this._herd.length > 0
            ? this._herd
            : this._protoCollection;

        await this._releaseGroup(protoCollection);

        this._scale = protoCollection.length;

        this._status = Drover.STATUS_STARTED;
    }

    /**
     * Get unhealthy sheep ids in herd
     *
     * @return {Array}
     */
    getHealthState() {
        return this._herd
                   .filter(sheep => sheep.status !== Sheep.STATUS_READY)
                   .map(sheep => sheep.id);
    }

    /**
     * Gracefully scales herd number to defined size
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for rescaling.
     *   `HerdCriteriaError` if current herd is empty.
     *   `InvalidArgumentError` if invalid scale size provided.
     *
     * @param {Number} size
     * @returns {Promise}
     * @emits Drover#error `HerdCriteriaError` err
     */
    scalePopulation(size) {
        return new Promise(async (resolve, reject) => {
            if (size <= 0) {
                return reject(new InvalidArgumentError('Scale size must be positive', {size}));
            }

            if (this._status !== Drover.STATUS_STARTED) {
                return reject(
                    new InappropriateConditionError('Action allowed only for started drovers', {status: this._status}),
                );
            }

            this._scale = size;

            try {
                const population = _.clone(this._herd);
                const populationCount = population.length;
                const delta = size - populationCount;

                if (populationCount === 0) {
                    return reject(new HerdCriteriaError('There is no alive sheeps'));
                }

                if (delta > 0) {
                    let newcomers = [];
                    const elder = population[0];

                    for (let shortage = delta; shortage > 0; shortage--) {
                        newcomers.push(this._cloneFromProto(elder));
                    }

                    await this._releaseGroup(newcomers);
                } else if (delta < 0) {
                    let victims = [];

                    for (let i = 0; i < Math.abs(delta); i++) {
                        victims.push(population[i]);
                    }

                    await this._killGroup(victims);
                }

                return resolve(delta);
            } catch (err) {
                return reject(err);
            }
        });
    }

    /**
     * Gracefully stops and shuts down every sheep in herd. Herd will be empty.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for shutting down.
     *   `SheepStateError` if some sheep in inappropriate state
     *
     * @emits Drover#error `SheepStateError` err
     */
    async gracefulShutdown() {
        if (![Drover.STATUS_STARTED, Drover.STATUS_STOPPED].includes(this._status)) {
            throw new InappropriateConditionError('Action allowed only for stable drovers', {status: this._status});
        }

        if (this._status !== Drover.STATUS_STOPPED) {
            await this._gracefulStop();
        }

        this._status = Drover.STATUS_SHUTTING_DOWN;

        await this._killGroup(this._herd);

        this._status = Drover.STATUS_SHUTTED_DOWN;
    }

    /**
     * Hard kill every sheep in herd. Herd will be empty.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for shutting down.
     *   `SheepStateError` if some sheep in inappropriate state
     *
     * @return {Promise}
     * @emits Drover#error `SheepStateError` err
     */
    async hardShutdown() {
        this._status = Drover.STATUS_SHUTTING_DOWN;

        await this._killGroup(this._herd, true);

        this._status = Drover.STATUS_SHUTTED_DOWN;
    }

    /**
     * Gracefully reloads service. Every sheep in herd will be cloned and released but not started.
     * When newcomers are ready - rolling update will begin.
     * When every newcomer is started and every old sheep is stopped - old sheep will shut down
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for stop.
     *   `SheepStateError` if some sheep in inappropriate state
     *
     * @return {Promise}
     * @emits Drover#error `SheepStateError` err
     */
    async gracefulReload() {
        if (this._status !== Drover.STATUS_STARTED) {
            throw new InappropriateConditionError('Action allowed only for started drovers', {status: this._status});
        }

        const oldHerd = _.clone(this._herd);
        const clonedHerd = oldHerd.map(this._cloneFromProto);

        await this._releaseGroup(clonedHerd);

        await this._stopGroup(oldHerd);

        await this._killGroup(oldHerd);
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
    }

    /**
     * @param {Object} herd
     * @private
     * @throws InvalidConfigurationError
     */
    _assertHerd(herd) {
        if (!Number.isSafeInteger(herd.count) || herd.count <= 0) {
            throw new InvalidConfigurationError('"herd.count" must be a positive number');
        }

        if (!_.isPlainObject(herd.env)) {
            throw new InvalidConfigurationError('"herd.env" must be a plain object');
        }

        if (!_.isString(herd.script) || !fs.lstatSync(herd.script).isFile()) {
            throw new InvalidConfigurationError('"herd.script" must be a valid file path');
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
     * Gracefully stops sheep in herd. Herd composition won't change.
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for stop.
     *   `SheepStateError` if some sheep in inappropriate state
     *
     * @return {Promise}
     * @emits Drover#error `SheepStateError` err
     */
    async _gracefulStop() {
        if (this._status !== Drover.STATUS_STARTED) {
            throw new InappropriateConditionError('Action allowed only for started drovers', {status: this._status});
        }

        this._status = Drover.STATUS_STOPPING;

        await this._stopGroup(this._herd);

        this._status = Drover.STATUS_STOPPED;
    }

    /**
     * @param {{script: string, count: number, env: Object=}}
     * @returns {Array}
     * @private
     */
    _createProtoCollection({script, count, env}) {
        let protoCollection = [];

        for (let i = 0; i < count; i++) {
            protoCollection.push(
                {
                    script,
                    env: _.clone(env),
                    status: Sheep.STATUS_WAITING,
                },
            );
        }

        return protoCollection;
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _releaseGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._release),
        );
    }

    /**
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    _release(proto) {
        return new Promise((resolve, reject) => {
            cluster.setupMaster({exec: proto.script});

            // cluster.fork may throw an exception
            const sheep = cluster.fork(proto.env);

            sheep.on('error', (error) => {
                return reject(error);
            }).on('online', async () => {
                proto.id = sheep.id;
                proto.instance = sheep;

                this._herd.splice(proto.id, 0, proto);

                await this._sheepStatusManager.assure(proto.id, Sheep.STATUS_READY);

                return resolve(proto);
            }).on('exit', async () => {
                if (this._status === Drover.STATUS_STARTED) {
                    try {
                        const proto = this._herd.find(p => p.id === sheep.id);
                        let cloned;

                        if (proto) {
                            cloned = this._cloneFromProto(proto);
                            await this._kill(proto);
                        }

                        setTimeout(
                            () => {
                                if (cloned && this._herd.length < this._scale) {
                                    this._release(cloned).catch(err => {
                                        console.log(err);
                                        this.emit(DroverEvents.ERROR, err)
                                    });
                                }
                            },
                            this._config.restartTimeout
                        );
                    } catch (err) {
                        console.log(err);
                        setImmediate(() => this.emit(DroverEvents.ERROR, err));
                    }
                }
            }).on('message', (message, handle) => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_MESSAGE, proto.id, message, handle));

                const {status} = message;

                if (status && proto && proto.status !== status) {
                    proto.status = status;

                    setImmediate(() => this.emit(DroverEvents.SHEEP_STATUS_CHANGE, proto.id, status));
                }
            });
        });
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _stopGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._stop),
        );
    }

    /**
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    async _stop(proto) {
        if (!proto.id) {
            throw new HerdCriteriaError('Sheep stop failed. Missing id');
        }

        this._sendMessage(proto, Commands.STOP);

        await this._sheepStatusManager.assure(proto.id, Sheep.STATUS_STOPPED);
    }

    /**
     * @param {Array} protoCollection
     * @param {Boolean} isHard
     * @return {Promise}
     * @private
     */
    _killGroup(protoCollection, isHard = false) {
        return Promise.all(
            protoCollection.map(proto => this._kill(proto, isHard)),
        );
    }

    /**
     * @param {Object} proto
     * @param {Boolean} isHard
     * @return {Promise}
     * @private
     */
    async _kill(proto, isHard = false) {
        if (typeof proto.id === 'undefined') {
            throw new SheepStateError('Sheep kill failed. Missing id');
        }

        if (isHard && typeof proto.instance !== 'undefined') {
            proto.instance.process.kill('SIGKILL');
        } else {
            this._sendMessage(proto, Commands.SHUTDOWN);

            await this._sheepStatusManager.assure(proto.id, Sheep.STATUS_SHUTTED_DOWN);
        }

        const protoIndex = this._herd.findIndex(protoSheep => protoSheep.id === proto.id);

        if (protoIndex >= 0) {
            this._herd.splice(protoIndex, 1);
        }
    }

    /**
     * @param {Object} protoSheep
     * @returns {Object} sheep
     * @private
     */
    _cloneFromProto(protoSheep) {
        let dolly = _.clone(protoSheep);
        dolly.status = Sheep.STATUS_WAITING;

        delete dolly.id;
        delete dolly.instance;

        return dolly;
    }

    /**
     * @param {Object} proto
     * @param {*} msg
     * @param {Function=} cb
     * @private
     */
    _sendMessage(proto, msg, cb) {
        cb = cb || function () {};

        const sheep = proto.instance;

        if (!sheep) {
            throw new SheepStateError('Sheep does not released yet', {id: proto.id});
        }

        sheep.send(msg, null, cb(sheep));
    }
}

module.exports = Drover;
