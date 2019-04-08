'use strict';

const Drover = require('./Drover');
const DroverEvents = require('./DroverEvents');
const {InvalidConfigurationError, TimeoutError} = require('./Error');

class SheepStatusManager {
    /**
     * @param {Object=} config
     */
    constructor(config) {
        this._pending = {};
        this._drover = undefined;
        config = config || {};

        if (typeof config.statusTimeout !== 'number' || config.statusTimeout <= 0) {
            throw new InvalidConfigurationError('"config.statusTimeout" must be positive number');
        }

        this._config = Object.assign({}, config);
    }

    /**
     * @param {Drover} drover
     * @return {SheepStatusManager}
     */
    bindDrover(drover) {
        if (this._drover) {
            throw new InvalidConfigurationError('Drover already bound to this manager');
        }

        if (!this._drover instanceof Drover) {
            throw new InvalidConfigurationError('Bind context must be valid Drover instance');
        }

        this._drover = drover;

        this._drover.on(DroverEvents.SHEEP_STATUS_CHANGE, (id, status) => {
            if (this._pending[id]) {
                clearTimeout(this._pending[id].timeout);
                this._pending[id].resolve(status);
            }
        });

        return this;
    }

    /**
     * @param {number} id
     * @param {number} status
     * @return {Promise}
     */
    assure(id, status) {
        if (!this._drover) {
            throw new InvalidConfigurationError('Drover context does not bound');
        }

        if (!this._pending[id]) {
            this._pending[id] = this._deferredStatus();
        }

        return this._pending[id];
    }

    /**
     * @return {Promise}
     */
    _deferredStatus() {
        let res, rej;

        let promise = new Promise((resolve, reject) => {
            res = resolve;
            rej = reject;
        });

        promise.resolve = res;
        promise.reject = rej;
        promise.timeout = setTimeout(
            () => promise.reject(new TimeoutError('Status timeout')),
            this._config.statusTimeout
        );

        return promise;
    }
}

module.exports = SheepStatusManager;
