'use strict';

const Master = require('./Master');
const numCPUs = require('os').cpus().length;
const cluster = require('cluster');

class MasterFactory {
    /**
     * @param {
     *      {script: string,
     *       count: number=,
     *       env: {}=,
     *       signals: {}=,
     *       schedulingPolicy: number=,
     *       restartTimeout: number=,
     *       statusTimeout: number=}
     * } options
     * @returns {Master}
     */
    static create(options) {
        options = options || {};
        const {
            script,
            count = numCPUs,
            env = {},
            signals = {
                reload:   'SIGHUP',
                shutdown: 'SIGTERM',
            },
            schedulingPolicy = cluster.SCHED_NONE,
            restartTimeout = 2000,
            statusTimeout = 2000,
        } = options;

        const config = {script, count, env, schedulingPolicy, restartTimeout, statusTimeout};

        return new Master({config, signals});
    }
}

module.exports = MasterFactory;
