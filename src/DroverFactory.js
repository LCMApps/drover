'use strict';

const Drover = require('./Drover');
const SheepStatusManager = require('./SheepStatusManager');
const numCPUs = require('os').cpus().length;
const cluster = require('cluster');

class DroverFactory {
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
     * @returns {Drover}
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

        const herd = {script, count, env};
        const config = {schedulingPolicy, restartTimeout};
        const statusManagerConfig = {statusTimeout};

        return new Drover({herd, signals, config, statusManager: new SheepStatusManager(statusManagerConfig)});
    }
}

module.exports = DroverFactory;
