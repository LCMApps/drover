'use strict';

const ExtendableError = require('./ExtendableError');

class AlreadyInitializedError extends ExtendableError {}
class TimeoutError extends ExtendableError {}
class InvalidClusterContextError extends ExtendableError {}
class InvalidConfigurationError extends ExtendableError {}
class InappropriateConditionError extends ExtendableError {}
class HerdCriteriaError extends ExtendableError {}
class SheepStateError extends ExtendableError {}
class InvalidArgumentError extends ExtendableError {}

module.exports = {
    AlreadyInitializedError,
    TimeoutError,
    InvalidClusterContextError,
    InvalidConfigurationError,
    InappropriateConditionError,
    HerdCriteriaError,
    SheepStateError,
    InvalidArgumentError,
};
