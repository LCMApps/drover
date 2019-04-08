'use strict';

const assert = require('chai').assert;

module.exports.assertThrowsAsync = async (fn, ...throwsAssertionParams) => {
    let f = () => {
    };

    try {
        await fn();
    } catch (e) {
        f = () => {
            throw e;
        };
    } finally {
        assert.throws(f, ...throwsAssertionParams);
    }
};
