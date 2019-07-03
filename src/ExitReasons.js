'use strict';

class Reason {
    constructor(payload) {
        this.payload = payload;
    }
}

class ExternalSignal extends Reason {}
class NormalExit extends Reason {}
class AbnormalExit extends Reason {}

module.exports = {
    ExternalSignal,
    NormalExit,
    AbnormalExit,
};
