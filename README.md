# Drover module - run, manage and scale nodejs solution that helps utilize multi-core systems

Drover is native nodejs solution that takes away pain when orchestrating composite application and providers all-in-one point for graceful cluster control

Key features:

* run and manage multiple app processes as simple app
* runtime scale
* graceful reload (helpful for zero-downtime releases)

# Installation

Using npm:

```shell
$ npm i --save drover
```

Using yarn:

```shell
$ yarn add drover
```

# Simple usage

`main.js`

```javascript
const { MasterFactory } = require('drover');

const master = MasterFactory.create(
    {
        script: 'path/to/app.js',
    }
);

process.on('SIGINT', async () => {
    await master.gracefulShutdown();
    process.exit(0);
});

master.start().catch(console.error);
```

`app.js`

```javascript
const express = require('express');
const { MessageBus } = require('drover');

const mb = new MessageBus();

mb.on('stop', () => {
    server.close(mb.sendStopped);
});

mb.on('quit', () => {
    mb.sendShuttedDown();
    setTimeout(() => process.exit(0), 50);
});

const app = express().get('/', (req, res) => {
    res.send('hello');
});

const server = app.listen(1999, mb.sendStarted);
```


# Basic concepts

## Glossary

* **Main context (facade)** - facade part of application, which is responsible for launching logic and managing the lifecycle of functional parts of the application
* **Functional context (business logic)** - functional parts of application that directly contain the business logic
* **Master** - entity of drover, which takes the role of creating and maintaining a given number of workers. This entity is always located only in `main context` of application.
* **Worker** - entity of drover, which assumes a role in the actual up-to-date presentation of state of `functional context` process on `main context` side.
* **MessageBus** - entity of drover, which connects the `functional context` of application with `main context` provides bidirectional commands via IPC channel.
Strongly associated with `Worker` and appear as it's representation on side of the `functional context`.

## Main idea

- in `main context` we should control worker processes of application. Here we can describe the logic of restarting falling workers, log them or even implement 
API that will allow us change workers state from the outside process context.
E.g. to bring the workers in maintenance mode and suspend the application without stopping the master process itself.

- in `main context`, we get a guarantee that all workers have successfully completed the start, according to the internal business logic of the functional parts of the application.
When you use default `cluster` module, the only signal for you about raising workers is to establish a IPC channel between `worker` and `master`.
This is not very convenient and not very informative. Indeed, it does not guarantee that the worker is started up functionally correct up to bootstrap steps.

- in `main context`, we get access to the direct signaling of `functional context`, including the ability to correctly stop
worker process or perform full controlled restart
  
## Principles

* **Logic segregation** - `main context` of the application `MUST NOT` contain business logic and vice versa -
`functional context` of the application `MUST NOT` contain logic of monitoring and controlling 
lifecycle of composite parts of the application itself.

### Exit reasons

To distinguish exit reasons you may import `ExitReasons` object.

```javascript
const { ExitReasons } = require('drover');
```

There are such available classes:

* `ExitReasons.ExternalSignal`

* `ExitReasons.NormalExit`

* `ExitReasons.AbnormalExit`

### `worker-exit` event

Underlying process may not start at all, it may fail after some time or it may be killed with signal.
Each instance has its own reason-specific payload field. There is a list of reasons:

* `ExitReasons.ExternalSignal` - worker process was killed by someone or by another process with the signal,
the signal name can be found in `payload.signal` field.

* `ExitReasons.NormalExit` - worker process has exited with `0` code. `payload.code` is provided

* `ExitReasons.AbnormalExit`- worker process has exited with non-zero code. `payload.code` is provided.

# Usage

**FYI:** You can find and run every case listed below in [examples](https://github.com/LCMApps/drover/tree/master/examples).

## 1. Run single app in cluster mode

In this case, the logic in the approach will be absolutely identical to the usual use of the cluster nodejs module.
However, in the case of a drover, we get a number of important advantages and convenience of working with a complex 
application using understandable entities and a transparent interface.

### `Main context` (e.g main.js)

1. Create instance of `Master`

```javascript
const master = MasterFactory.create(
    {
        script: 'path/to/app.js', // required
        count: 4,                 // optional
        env: {                    // optional
            PORT: 1934
        },
    }
);
```

2. Add listener on `worker-exit` event of `Master`

```javascript
master.on('worker-exit', async (reason, workerId) => {
    if (reason instanceof ExitReasons.ExternalSignal || reason instanceof ExitReasons.AbnormalExit) {
        // restart worker if something abnormal happened or external process killed worker by signal
        await master.restartWorkerById(workerId);
    } else {
        // for different cases just hard quit all app
        const { code, signal } = reason.payload;
        // quit method will be described in next section
        await quit(code, signal, true);
    }
});
```

3. Handle terminating of `main context` process

```javascript
const quit = async (code, signal, force = false) => {
    try {
        if (force) {
            // in case of emergency stop we just hard quit all worker processes
            await master.hardShutdown();
        } else {
            // for default app exit we do it in more graceful way
            await master.gracefulShutdown();
        }
    } catch (err) {
        // your stop-failed handler logic here
        console.error(err);
    }

    setTimeout(() => process.exit(0), 0);
};

// handle main process SIGINT (default signal in Unix when "ctrl+c" terminal interruption happened)
process.on('SIGINT', quit);
```

4. Start application. This part will fork `functional context` (`app.js`) and run 4 instances of it.

```javascript
const run = async () => {
    try {
        await master.start();
        // right here we have a guarantee that all 4 app instances
        // already did their business logic (raised connects, started servers, etc)
    } catch (err) {
        // your start-failed handler logic here
        console.error(err);
        return;
    }

    // primitive health-check from master every 2s
    setInterval(() => {
        master.getWorkersStatuses().forEach((v, i) => {
            console.log(`[app-${i}]: ${statusMap[v]}`);
        });
        console.log('---');
    }, 2000);
};

run().catch(console.error);
```

### `Functional context` (e.g. app.js)

1. Create instance of `MessageBus`:

```javascript
const mb = new MessageBus();
```

2. Setup listeners on `stop` and `quit` events:

```javascript
mb.on('stop', () => {
    server.close(mb.sendStopped);
});

mb.on('quit', () => {
    mb.sendShuttedDown();
    setTimeout(() => process.exit(0), 50);
});
```

3. Send start signal to master when all bootstrap part is done:

```javascript
const app = express().get('/', (req, res) => {
    res.send(RESPONSE);
});

const server = app.listen(PORT, mb.sendStarted);
```

For that example above we will expect next output in console repeated every 2s:

```shell
[app-0]: STARTED
[app-1]: STARTED
[app-2]: STARTED
[app-3]: STARTED
---
```

## 2. Run multiple apps in cluster mode

In this case, the logic will same as if you are using several cluster modules within one `main context` without loss of ease of management.

Most parts of context building are similar to previous example, but with little different points.

### `Main context` (e.g main.js)

Here we instantiate N different masters.

```javascript
const fooMaster = MasterFactory.create(
    {
        script: 'path/to/app-foo.js',
        count: 2,
        env: {
            PORT: 2100,
            RESPONSE: 'multi-app-cluster'
        }
    }
);

const barMaster = MasterFactory.create(
    {
        script: 'path/to/app-bar.js',
        count: 2,
        env: {
            PORT: 2101,
            RESPONSE: 'multi-app-cluster'
        }
    }
);

const bazMaster = MasterFactory.create(
    {
        script: 'path/to/app-baz.js',
        count: 4,
        env: {
            PORT: 2102,
            RESPONSE: 'multi-app-cluster'
        }
    }
);
```

After that we subscribe listeners on `worker-exit` event and start all masters.
You can start them parallel with `Promise.all`, or consistently one by one. It totally depends on your business logic.

## 3. Run single app instance

If you don't need cluster multi-instances of your app, you still can run you application with drover. Most parts of
context building are similar to first example with little difference in master's option `count` when you instantiate it.

### `Main context` (e.g main.js)

```javascript
const master = MasterFactory.create(
    {
        script: 'path/to/app.js',
        count: 1
    }
);
```

In this case you still got advantages of graceful reloads with zero-downtime of your app. When reload begins - one more instance of app
will be added right before previous one shut down.

# Difference with PM2

## License

`drover` covered with [**MIT**](/LICENSE.md) license, so it's free to use for any kind of your private or commercial projects without
 any restrictions and obligations to be open-sourced.

## Clear and flexible programmatic flow

`pm2` has programmatic flow, but it is still just API to `pm2` demon process and it brings some usage restrictions.
With `drover` you've got more options, so flexibility for your business logic raises a lot.

## More control

`pm2` uses "let if fail" concept, but `drover` gives you control instead. You've got not just exits as fact, but you can
manage different `ExitReasons` and handle each case according to your needs.

# Debug

`drover` module use `debug` module for this this purpose.

Just run your app with `DEBUG` env var like example below:

```javascript
DEBUG=drover:* node main.js
```

Sample output for `simple-app` start:

![Screenshot from 2019-07-16 12_32_21](https://user-images.githubusercontent.com/6859896/61284297-53eecc00-a7c7-11e9-85d5-e3680ba77501.jpg)

And changes with `SIGINT` signal to `main.js` process triggered by `Ctrl+C`:

![Screenshot from 2019-07-16 12_32_28](https://user-images.githubusercontent.com/6859896/61284562-e3947a80-a7c7-11e9-9588-6a2ef2efae0e.jpg)

As you see, you have transparent access to all events, state changes and errors described behaviour even via IPC communication.
