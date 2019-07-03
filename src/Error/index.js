'use strict';

const ExtendableError = require('./ExtendableError');

class AlreadyInitializedError extends ExtendableError {}
class InvalidClusterContextError extends ExtendableError {}
class InvalidConfigurationError extends ExtendableError {}
class InvalidArgumentError extends ExtendableError {}
class InappropriateConditionError extends ExtendableError {}
class WorkerStatusError extends ExtendableError {}
class UnexpectedWorkerState extends ExtendableError {}

module.exports = {
    AlreadyInitializedError,
    InvalidClusterContextError,
    InvalidConfigurationError,
    InappropriateConditionError,
    UnexpectedWorkerState,
    WorkerStatusError,
    InvalidArgumentError,
};
