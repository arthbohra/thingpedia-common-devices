// -*- mode: js; indent-tabs-mode: nil; js-basic-offset: 4 -*-
//
// Copyright 2018 Google LLC
//           2018-2020 The Board of Trustees of the Leland Stanford Junior University
//
// See LICENSE for details
"use strict";

process.on('unhandledRejection', (up) => { throw up; });
process.env.TEST_MODE = '1';

const uuid = require('uuid');
const assert = require('assert');
const util = require('util');
const fs = require('fs');
const path = require('path');
const Genie = require('genie-toolkit');

const Platform = require('../lib/platform');
const { initializeCredentials } = require('../lib/cred-utils');

function assertNonEmptyString(what) {
    assert(typeof what === 'string' && what, 'Expected a non-empty string, got ' + what);
}


async function existsSafe(path) {
    try {
        await util.promisify(fs.access)(path);
        return true;
    } catch (e) {
        if (e.code === 'ENOENT')
            return false;
        if (e.code === 'ENOTDIR')
            return false;
        throw e;
    }
}

async function sleep(timeout) {
    return new Promise((resolve, reject) => {
        setTimeout(resolve, timeout);
    });
}

// mock a subset of ExecEnvironment sufficient for testing
class MockExecEnvironment {
    constructor() {
        this.app = {
            uniqueId: 'uuid-' + uuid.v4()
        };
    }
}

async function collectAll(iterable) {
    const array = [];
    for await (const element of iterable)
        array.push(element);
    return array;
}

class TestRunner {
    constructor() {
        this._platform = new Platform();
        this._engine = new Genie.AssistantEngine(this._platform, {
            cloudSyncUrl: 'https://dev.almond.stanford.edu'
        });

        this.anyFailed = false;
    }

    async start() {
        await this._engine.open();

        await Promise.all([
             // initialize the credentials from the test directory
            initializeCredentials(this._engine),

            (async () => {
                // if cloud sync is set up, we'll download the credentials of the devices to
                // test from almond-dev
                // sleep for 30 seconds while that happens
                if (this._platform.getCloudId()) {
                    console.log('Waiting for cloud sync to complete...');
                    await sleep(30000);
                }
            })()
        ]);
    }
    stop() {
        return this._engine.close();
    }

    async _getOrCreateDeviceInstance(deviceKind, manifest, devClass) {
        const existing = this._engine.devices.getAllDevicesOfKind(deviceKind);
        if (existing.length > 0) {
            assert(existing.some((d) => d.constructor === devClass));
            return existing.find((d) => d.constructor === devClass);
        }

        if (!manifest) // FIXME
            return this._engine.createSimpleDevice(deviceKind);

        const config = manifest.config;
        if (config.module === 'org.thingpedia.config.none')
            return this._engine.createSimpleDevice(deviceKind);

        // otherwise do something else...
        return null;
    }

    async _testQuery(instance, functionName, input, hints, expected) {
        if (typeof input === 'function')
            input = input(instance);

        const env = new MockExecEnvironment();
        const result = await collectAll(await instance['get_' + functionName](input, hints, env));
        if (typeof expected === 'function') {
            expected(result, input, hints, instance);
            return;
        }

        if (!Array.isArray(expected))
            expected = [expected];

        assert.deepStrictEqual(result, expected);
    }

    async _runTest(instance, test) {
        if (typeof test === 'function') {
            await test(instance);
            return;
        }

        let testType, functionName, input, hints, expected;
        if (test.length >= 5)
            [testType, functionName, input, hints, expected] = test;
        else
            [testType, functionName, input, expected] = test;

        switch (testType) {
            case 'query':
                await this._testQuery(instance, functionName, input, hints, expected);
                break;
            case 'monitor':
                // do something
                break;
            case 'action':
                // do something
                break;
        }
    }

    async testOne(release, deviceKind) {
        // load the test class first
        let testsuite;
        try {
            testsuite = require('./' + release + '/' + deviceKind);
        } catch (e) {
            console.log('No tests found for ' + release + '/' + deviceKind);
            // exit with no error and without loading the device
            // class (which would pollute code coverage statistics)
            return;
        }

        // now load the device through the TpClient loader code
        // (which will initialize the device class with stuff like
        // the OAuth helpers and the polling implementation of subscribe_*)

        const prefs = this._platform.getSharedPreferences();
        prefs.set('developer-dir', path.resolve(release));
        // FIXME don't access private properties
        const devClass = await this._engine.devices._factory.getDeviceClass(deviceKind);
        const manifest = devClass.manifest;

        // require the device once fully (to get complete code coverage)
        if (manifest && manifest.loader.module === 'org.thingpedia.v2')
            require('../../' + release + '/' + deviceKind);

        console.log('# Starting tests for ' + release + '/' + deviceKind);
        try {
            if (typeof testsuite === 'function') {
                // if the testsuite is a function, we're done here
                await testsuite(devClass);
                return;
            }

            let instance = null;
            if (!Array.isArray(testsuite)) {
                const meta = testsuite;
                testsuite = meta.tests;
                if (meta.setUp)
                    instance = await meta.setUp(devClass);
            }
            if (instance === null)
                instance = await this._getOrCreateDeviceInstance(deviceKind, manifest, devClass);
            if (instance === null) {
                console.log('FAILED: skipped tests for ' + release + '/' + deviceKind + ': missing credentials');
                return;
            }

            assertNonEmptyString(instance.name);
            assertNonEmptyString(instance.description);
            assertNonEmptyString(instance.uniqueId);

            for (let i = 0; i < testsuite.length; i++) {
                console.log(`## Test ${i + 1}/${testsuite.length}`);
                const test = testsuite[i];
                try {
                    await this._runTest(instance, test);
                } catch (e) {
                    console.log('## FAILED: ' + e.message);
                    console.log(e.stack);
                    this.anyFailed = true;
                }
            }
        } finally {
            console.log('# Completed tests for ' + release + '/' + deviceKind);
        }
    }

    async toTest(argv) {
        let devices = new Set();

        for (let arg of argv.slice(2)) {
            if (arg.indexOf('/') >= 0) {
                devices.add(arg);
            } else {
                for (let kind of await util.promisify(fs.readdir)(path.resolve(path.dirname(module.filename), '../..', arg)))
                    devices.add(arg + '/' + kind);
            }
        }

        return devices;
    }
}

async function main() {
    const runner = new TestRunner();
    await runner.start();

    // takes either (1) device names to test, or (2) release channel to test
    for (let device of await runner.toTest(process.argv)) {
        let [release, kind] = device.split('/');
        if (!await existsSafe(release + '/' + kind + '/manifest.tt')) //'
            continue;

        await runner.testOne(release, kind);
    }

    await runner.stop();
    if (runner.anyFailed)
        process.exit(1);
}
main();
