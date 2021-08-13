'use strict';

var utils = require('./utils');
var debug = require('./debug');
var RedisClient = require('../').RedisClient;
var Command = require('./command');
var noop = function () {};

/**********************************************
All documented and exposed API belongs in here
**********************************************/

// Redirect calls to the appropriate function and use to send arbitrary / not supported commands
RedisClient.prototype.send_command = RedisClient.prototype.sendCommand = function (command, args, callback) {
    // Throw to fail early instead of relying in order in this case
    if (typeof command !== 'string') {
        throw new TypeError('Wrong input type "' + (command !== null && command !== undefined ? command.constructor.name : command) + '" for command name');
    }
    command = command.toLowerCase();
    if (!Array.isArray(args)) {
        if (args === undefined || args === null) {
            args = [];
        } else if (typeof args === 'function' && callback === undefined) {
            callback = args;
            args = [];
        } else {
            throw new TypeError('Wrong input type "' + args.constructor.name + '" for args');
        }
    }
    if (typeof callback !== 'function' && callback !== undefined) {
        throw new TypeError('Wrong input type "' + (callback !== null ? callback.constructor.name : 'null') + '" for callback function');
    }

    // Using the raw multi command is only possible with this function
    // If the command is not yet added to the client, the internal function should be called right away
    // Otherwise we need to redirect the calls to make sure the internal functions don't get skipped
    // The internal functions could actually be used for any non hooked function
    // but this might change from time to time and at the moment there's no good way to distinguish them
    // from each other, so let's just do it do it this way for the time being
    if (command === 'multi' || typeof this[command] !== 'function') {
        return this.internal_send_command(new Command(command, args, callback));
    }
    if (typeof callback === 'function') {
        args = args.concat([callback]); // Prevent manipulating the input array
    }
    return this[command].apply(this, args);
};

RedisClient.prototype.end = function (flush) {
    const self = this;
    // Clear retry_timer
    if (this.retry_timer) {
        clearTimeout(this.retry_timer);
        this.retry_timer = null;
    }
    this.connected = false;
    this.ready = false;
    this.closing = true;

    this.stream.removeAllListeners('close');

    // stream.end() just sends a TCP fin and waits for a corresponding FIN
    // from the server, which denotes the closure, and triggers connection_gone(close)
    // this will flush for us and close gracefully
    // we also have a timeout for a less graceful close 5sec later
    return new Promise((res, rej) => {
        const timeout = setTimeout(() => {
            this.stream.removeAllListeners('close');
            this.stream.removeAllListeners('end');
            self.connection_gone('end');
            res();
        }, 5000);
        this.stream.once('close', function (hadError) {
            clearTimeout(timeout);
            self.connection_gone('close');
            res();
        });
        this.stream.end();
    })

};

RedisClient.prototype.unref = function () {
    if (this.connected) {
        debug("Unref'ing the socket connection");
        this.stream.unref();
    } else {
        debug('Not connected yet, will unref later');
        this.once('connect', function () {
            this.unref();
        });
    }
};

RedisClient.prototype.duplicate = function (options, callback) {
    if (typeof options === 'function') {
        callback = options;
        options = null;
    }
    var existing_options = utils.clone(this.options);
    options = utils.clone(options);
    for (var elem in options) {
        existing_options[elem] = options[elem];
    }
    var client = new RedisClient(existing_options);
    client.selected_db = options.db || this.selected_db;
    if (typeof callback === 'function') {
        var ready_listener = function () {
            callback(null, client);
            client.removeAllListeners(error_listener);
        };
        var error_listener = function (err) {
            callback(err);
            client.end(true);
        };
        client.once('ready', ready_listener);
        client.once('error', error_listener);
        return;
    }
    return client;
};
