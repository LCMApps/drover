'use strict';

const _                           = require('lodash');
const cluster                     = require('cluster');
const numCPUs                     = require('os').cpus().length;
const {EventEmitter}              = require('events');
const DroverEvents                = require('./DroverEvents');
const Commands                    = require('./Commands');
const Sheep                       = require('./Sheep');
const SheepStateError             = require('./Error').SheepStateError;
const InvalidArgumentError        = require('./Error').InvalidArgumentError;
const HerdCriteriaError           = require('./Error').HerdCriteriaError;
const InappropriateConditionError = require('./Error').InappropriateConditionError;
const InvalidConfigurationError   = require('./Error').InvalidConfigurationError;
const AlreadyInitializedError     = require('./Error').AlreadyInitializedError;
const InvalidClusterContextError  = require('./Error').InvalidClusterContextError;
const TimeoutError                = require('./Error').TimeoutError;

/**
 * Retry something by interval till time is out
 *
 * @param {Function} fn
 * @param {Number} intervalTime
 * @param {Number} timeoutTime
 * @param {Function=} timeoutCb
 * @return {Promise}
 * @private
 * @package drover
 */
const _wait = (fn, intervalTime, timeoutTime, timeoutCb) => {
    return new Promise((resolve, reject) => {
        let interval;
        let timeout;
        timeoutCb = timeoutCb || function () {};

        timeout = setTimeout(() => {
            if (interval) {
                clearInterval(interval);
            }
            timeoutCb();

            return reject(new TimeoutError('Interrupted after timeout', {intervalTime, timeoutTime}));
        }, timeoutTime);

        interval = setInterval(() => {
            if (fn()) {
                clearTimeout(timeout);
                clearInterval(interval);

                return resolve();
            }
        }, intervalTime);
    });
};

const DEFAULT_PING_TIMEOUT  = 2000;
const DEFAULT_PING_INTERVAL = 200;

class Drover extends EventEmitter {
    static get STATUS_SHUT_DOWN() {
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
     * @param {Object=} config
     * @emits Drover#sheep-status-change proto, status
     */
    constructor(config) {
        super();
        config = _.cloneDeep(config || {});

        if (!cluster.isMaster) {
            throw new InvalidClusterContextError('Drover usage allowed only with master context');
        }

        this._config = Object.assign(
            {
                schedulingPolicy: cluster.SCHED_NONE,
                pingTimeout:      DEFAULT_PING_TIMEOUT,
                pingInterval:     DEFAULT_PING_INTERVAL,
            },
            config,
        );

        this._herd   = undefined;
        this._status = Drover.STATUS_SHUT_DOWN;

        cluster.schedulingPolicy = this._config.schedulingPolicy;
        process.on('SIGHUP', this.gracefulReload.bind(this));

        this.on(DroverEvents.SHEEP_MESSAGE, (sheep, msg) => {
            if (msg.status) {
                const proto = this._findProtoSheepById(sheep.id);

                if (proto && proto.status !== msg.status) {
                    proto.status = msg.status;
                    this.emit(DroverEvents.SHEEP_STATUS_CHANGE, proto, msg.status);
                }
            }
        });
        this.on(DroverEvents.SHEEP_STATUS_CHANGE, async (proto, status) => {
            switch (status) {
                case Sheep.STATUS_TERMINATING:
                    await this._kill(proto);

                    if (this._status === Drover.STATUS_STARTED) {
                        await this._release(proto);
                        await this._start(proto);
                    }
                    break;
                default:
                    break;
            }
        });
    }

    getConfig() {
        return this._config;
    }

    /**
     * Starts service and resolves promise with initial herd population number.
     *
     * Promise will be rejected with:
     *   `AlreadyInitializedError` if service is already started.
     *   `InvalidConfigurationError` if herd members have invalid configuration.
     *   `TimeoutError` if one or more sheep status can not be assured in `config.pingTimeout` (default 2000ms).
     *
     * Rejection of promise means that all half-state sheep were stopped and no retries will be done.
     *
     * @param {Array} herd
     * @return {Promise}
     * @emits Drover#ready initialized herd size
     * @emits Drover#error `TimeoutError` | `InvalidConfigurationError` err
     */
    start(herd) {
        return new Promise(async (resolve, reject) => {
            if (this._status !== Drover.STATUS_SHUT_DOWN || this._herd) {
                return reject(new AlreadyInitializedError('Drover has already started or is starting right now'));
            }

            this._herd   = [];
            this._status = Drover.STATUS_STARTING;

            try {
                const protoCollection = await this._bootstrapHerd(herd);

                await this._releaseGroup(protoCollection);

                await this._startGroup(protoCollection);

                this._status = Drover.STATUS_STARTED;

                setImmediate(() => this.emit(DroverEvents.READY, protoCollection.length));

                return resolve(protoCollection.length);
            } catch (err) {
                setImmediate(() => this.emit(DroverEvents.ERROR, err));

                return reject(err);
            }
        });
    }

    /**
     * Get unhealthy sheep ids in herd
     *
     * @param {Array=} healthyStatuses
     * @return {Promise}
     */
    checkHerd(healthyStatuses) {
        healthyStatuses = healthyStatuses || [Drover.STATUS_STARTED];

        return Promise.resolve(
            this._herd
                .filter(sheep => healthyStatuses.indexOf(sheep.status) !== -1)
                .map(sheep => sheep.id),
        );
    }

    /**
     * Gracefully scales breed number to defined size
     *
     * Promise will be rejected with:
     *   `InappropriateConditionError` if service is not in stable state for rescaling.
     *   `HerdCriteriaError` if no any breed instance represented in herd.
     *   `InvalidArgumentError` if invalid scale size provided.
     *
     * @param {String} breed
     * @param {Number} size
     * @returns {Promise}
     * @emits Drover#error `HerdCriteriaError` err
     */
    scaleBreedPopulation(breed, size) {
        return new Promise(async (resolve, reject) => {
            if (size <= 0) {
                return reject(new InvalidArgumentError('Scale size must be positive', {size}));
            }

            if (this._status !== Drover.STATUS_STARTED) {
                return reject(
                    new InappropriateConditionError('Action allowed only for started drovers', {status: this._status}),
                );
            }

            try {
                const breedPopulation      = this._herd.filter(proto => proto.breed === breed);
                const breedPopulationCount = breedPopulation.length;
                const delta                = size - breedPopulationCount;

                if (breedPopulationCount === 0) {
                    return reject(new HerdCriteriaError('Breed does not exist', {breed}));
                }

                if (delta > 0) {
                    let newcomers = [];
                    const elder   = breedPopulation[0];

                    for (let shortage = delta; shortage > 0; shortage--) {
                        newcomers.push(Drover._cloneFromProto(elder));
                    }

                    await this._releaseGroup(newcomers);
                    await this._startGroup(newcomers);
                } else if (delta < 0) {
                    const victims = breedPopulation.slice(0, Math.abs(delta));

                    await this._killGroup(victims);
                }

                return resolve(delta);
            } catch (err) {
                setImmediate(() => this.emit(DroverEvents.ERROR, err));

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
     * @return {Promise}
     * @emits Drover#error `SheepStateError` err
     */
    gracefulShutdown() {
        return new Promise(async (resolve, reject) => {
            if ([Drover.STATUS_STARTED, Drover.STATUS_STOPPED].indexOf(this._status) === -1) {
                return reject(
                    new InappropriateConditionError('Action allowed only for stable drovers', {status: this._status}),
                );
            }

            try {
                if (this._status !== Drover.STATUS_STOPPED) {
                    await this.gracefulStop();
                }

                this._status = Drover.STATUS_SHUTTING_DOWN;

                await this._killGroup(this._herd);

                this._status = Drover.STATUS_SHUT_DOWN;

                return resolve();
            } catch (err) {
                setImmediate(() => this.emit(DroverEvents.ERROR, err));

                return reject(err);
            }
        });
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
    gracefulStop() {
        return new Promise(async (resolve, reject) => {
            if (this._status !== Drover.STATUS_STARTED) {
                return reject(
                    new InappropriateConditionError('Action allowed only for started drovers', {status: this._status}),
                );
            }

            try {
                this._status = Drover.STATUS_STOPPING;

                await this._stopGroup(this._herd);

                this._status = Drover.STATUS_STOPPED;

                return resolve();
            } catch (err) {
                setImmediate(() => this.emit(DroverEvents.ERROR, err));

                return reject(err);
            }
        });
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
    gracefulReload() {
        return new Promise(async (resolve, reject) => {
            if (this._status !== Drover.STATUS_STARTED) {
                return reject(
                    new InappropriateConditionError('Action allowed only for started drovers', {status: this._status}),
                );
            }

            try {
                const oldHerd    = _.clone(this._herd);
                const clonedHerd = oldHerd.map(Drover._cloneFromProto);

                await this._releaseGroup(clonedHerd);

                await Promise.all(
                    [
                        await this._startGroup(clonedHerd),
                        await this._stopGroup(oldHerd),
                    ],
                );

                await this._killGroup(oldHerd);

                return resolve();
            } catch (err) {
                setImmediate(() => this.emit(DroverEvents.ERROR, err));

                return reject(err);
            }
        });
    }

    /**
     * @param {Object} protoSheep
     * @returns {Object} sheep
     * @private
     */
    static _cloneFromProto(protoSheep) {
        let dolly    = _.cloneDeep(protoSheep);
        dolly.status = Sheep.STATUS_WAITING;

        delete dolly.id;

        return dolly;
    }

    /**
     * @param {Object} proto
     * @param {*} msg
     * @param {Function=} cb
     * @private
     */
    static _sendMessage(proto, msg, cb) {
        cb = cb || function () {};

        const sheep = proto.instance;

        if (!sheep) {
            throw new SheepStateError('Sheep does not released yet', {id: proto.id});
        }

        sheep.send(msg, null, cb(sheep));
    }

    /**
     * @param {Array} herd
     * @returns {Promise}
     * @private
     */
    _bootstrapHerd(herd) {
        return new Promise((resolve, reject) => {
            let protoCollection = [];

            herd.forEach((sheepData) => {
                let count = sheepData.count || numCPUs;

                if (count < 0) {
                    return reject(new InvalidConfigurationError('Invalid sheep count', {count}));
                }

                for (let i = 0; i < sheepData.count; i++) {
                    protoCollection.push(
                        {
                            breed:  sheepData.breed,
                            script: sheepData.script,
                            env:    sheepData.env || null,
                            status: Sheep.STATUS_WAITING,
                        },
                    );
                }
            });

            return resolve(protoCollection);
        });
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _releaseGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._release.bind(this)),
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

            const sheep = cluster.fork(proto.env);

            sheep.on('error', (error) => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_ERROR, error));

                return reject(error);
            }).on('online', async () => {
                proto.id       = sheep.id;
                proto.instance = sheep;
                proto.status   = Sheep.STATUS_STARTING;

                this._herd.push(proto);

                await this._assureStatus(Sheep.STATUS_READY, proto);

                setImmediate(() => this.emit(DroverEvents.SHEEP_ONLINE, proto));

                return resolve(proto);
            }).on('disconnect', () => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_DISCONNECT, proto));
            }).on('exit', (code, signal) => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_EXIT, proto, code, signal));
            }).on('listening', (address) => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_LISTENING, proto, address));
            }).on('message', (message, handle) => {
                setImmediate(() => this.emit(DroverEvents.SHEEP_MESSAGE, proto, message, handle));
            });
        });
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _startGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._start.bind(this)),
        );
    }

    /**
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    _start(proto) {
        Drover._sendMessage(proto, Commands.START);

        return this._assureStatus(Sheep.STATUS_STARTED, proto);
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _stopGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._stop.bind(this)),
        );
    }

    /**
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    _stop(proto) {
        return new Promise(async (resolve, reject) => {
            if (!proto.id) {
                return reject(new HerdCriteriaError('Sheep stop failed. Missing id'));
            }

            try {
                Drover._sendMessage(proto, Commands.STOP);

                await this._assureStatus(Sheep.STATUS_STOPPED, proto);

                return resolve();
            } catch (err) {
                return reject(err);
            }
        });
    }

    /**
     * @param {Array} protoCollection
     * @return {Promise}
     * @private
     */
    _killGroup(protoCollection) {
        return Promise.all(
            protoCollection.map(this._kill.bind(this)),
        );
    }

    /**
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    _kill(proto) {
        return new Promise(async (resolve, reject) => {
            if (typeof proto.id === 'undefined') {
                return reject(new SheepStateError('Sheep kill failed. Missing id'));
            }

            try {
                Drover._sendMessage(proto, Commands.SHUTDOWN);

                await this._assureStatus(Sheep.STATUS_SHUT_DOWN, proto);

                const protoIndex = this._herd.findIndex(protoSheep => protoSheep.id === proto.id);

                if (protoIndex >= 0) {
                    this._herd.splice(protoIndex, 1);
                }

                return resolve();
            } catch (err) {
                return reject(err);
            }
        });
    }

    /**
     * @param {Number} status
     * @param {Object} proto
     * @return {Promise}
     * @private
     */
    _assureStatus(status, proto) {
        return _wait(
            () => proto.status === status,
            this._config.pingInterval,
            this._config.pingTimeout,
        );
    }

    /**
     * @param {Number} id
     * @return {{}|undefined}
     * @private
     */
    _findProtoSheepById(id) {
        return this._herd.find(proto => proto.id === id);
    }
}

module.exports = Drover;
