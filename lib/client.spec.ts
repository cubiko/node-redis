import { strict as assert } from 'assert';
import { once } from 'events';
import { itWithClient, TEST_REDIS_SERVERS, TestRedisServers } from './test-utils';
import RedisClient from './client';
import { AbortError } from './errors';
import { defineScript } from './lua-script';

describe('Client', () => {
    describe('authentication', () => {
        itWithClient(TestRedisServers.PASSWORD, 'Client should be authenticated', async client => {
            assert.equal(
                await client.ping(),
                'PONG'
            );
        });

        it('should not retry connecting if failed due to wrong auth', async () => {
            const client = RedisClient.create({
                socket: {
                    ...TEST_REDIS_SERVERS[TestRedisServers.PASSWORD],
                    password: 'wrongpassword'
                }
            });

            await assert.rejects(
                client.connect(),
                {
                    message: 'WRONGPASS invalid username-password pair or user is disabled.'
                }
            );

            assert.equal(client.isOpen, false);
        });
    });

    describe('legacyMode', () => {
        const client = RedisClient.create({
            socket: TEST_REDIS_SERVERS[TestRedisServers.OPEN],
            legacyMode: true
        });

        before(() => client.connect());
        afterEach(() => client.modern.flushAll());
        after(() => client.disconnect());

        it('client.sendCommand should call the callback', done => {
            (client as any).sendCommand('PING', (err?: Error, reply?: string) => {
                if (err) {
                    return done(err);
                }

                try {
                    assert.equal(reply, 'PONG');
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('client.sendCommand should work without callback', async () => {
            (client as any).sendCommand('PING');
            await client.modern.ping(); // make sure the first command was replied
        });

        it('client.modern.sendCommand should return a promise', async () => {
            assert.equal(
                await client.modern.sendCommand(['PING']),
                'PONG'
            );
        });

        it('client.{command} should accept vardict arguments', done => {
            (client as any).set('a', 'b', (err?: Error, reply?: string) => {
                if (err) {
                    return done(err);
                }

                try {
                    assert.equal(reply, 'OK');
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('client.{command} should accept arguments array', done => {
            (client as any).set(['a', 'b'], (err?: Error, reply?: string) => {
                if (err) {
                    return done(err);
                }

                try {
                    assert.equal(reply, 'OK');
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('client.{command} should accept mix of strings and array of strings', done => {
            (client as any).set(['a'], 'b', ['GET'], (err?: Error, reply?: string) => {
                if (err) {
                    return done(err);
                }

                try {
                    assert.equal(reply, null);
                    done();
                } catch (err) {
                    done(err);
                }
            });
        });

        it('client.multi.exec should call the callback', done => {
            (client as any).multi()
                .ping()
                .exec((err?: Error, reply?: string) => {
                    if (err) {
                        return done(err);
                    }

                    try {
                        assert.deepEqual(reply, ['PONG']);
                        done();
                    } catch (err) {
                        done(err);
                    }
                });
        });

        it('client.multi.exec should work without callback', async () => {
            (client as any).multi()
                .ping()
                .exec();
            await client.modern.ping(); // make sure the first command was replied
        });

        it('client.modern.exec should return a promise', async () => {
            assert.deepEqual(
                await ((client as any).multi().modern
                    .ping()
                    .exec()),
                ['PONG']
            );
        });
    });

    describe('events', () => {
        it('connect, ready, end', async () => {
            const client = RedisClient.create({
                socket: TEST_REDIS_SERVERS[TestRedisServers.OPEN]
            });

            await Promise.all([
                client.connect(),
                once(client, 'connect'),
                once(client, 'ready')
            ]);

            await Promise.all([
                client.disconnect(),
                once(client, 'end')
            ]);
        });
    });

    describe('sendCommand', () => {
        itWithClient(TestRedisServers.OPEN, 'PING', async client => {
            assert.equal(await client.sendCommand(['PING']), 'PONG');
        });

        describe('AbortController', () => {
            itWithClient(TestRedisServers.OPEN, 'success', async client => {
                await client.sendCommand(['PING'], {
                    signal: new AbortController().signal
                });
            });

            itWithClient(TestRedisServers.OPEN, 'AbortError', async client => {
                const controller = new AbortController();
                controller.abort();

                await assert.rejects(
                    client.sendCommand(['PING'], {
                        signal: controller.signal
                    }),
                    AbortError
                );
            });
        });
    });

    describe('multi', () => {
        itWithClient(TestRedisServers.OPEN, 'simple', async client => {
            assert.deepEqual(
                await client.multi()
                    .ping()
                    .set('key', 'value')
                    .get('key')
                    .exec(),
                ['PONG', 'OK', 'value']
            );
        });

        itWithClient(TestRedisServers.OPEN, 'should reject the whole chain on error', async client => {
            client.on('error', () => {
                // ignore errors
            });

            await assert.rejects(
                client.multi()
                    .ping()
                    .addCommand(['DEBUG', 'RESTART'])
                    .ping()
                    .exec()
            );
        });

        it('with script', async () => {
            const client = RedisClient.create({
                scripts: {
                    add: defineScript({
                        NUMBER_OF_KEYS: 0,
                        SCRIPT: 'return ARGV[1] + 1;',
                        transformArguments(number: number): Array<string> {
                            return [number.toString()];
                        },
                        transformReply(reply: number): number {
                            return reply;
                        }
                    })
                }
            });
    
            await client.connect();

            try {
                assert.deepEqual(
                    await client.multi()
                        .add(1)
                        .exec(),
                    [2]
                );
            } finally {
                await client.disconnect();
            }
        });
    });
    
    it('scripts', async () => {
        const client = RedisClient.create({
            scripts: {
                add: defineScript({
                    NUMBER_OF_KEYS: 0,
                    SCRIPT: 'return ARGV[1] + 1;',
                    transformArguments(number: number): Array<string> {
                        return [number.toString()];
                    },
                    transformReply(reply: number): number {
                        return reply;
                    }
                })
            }
        });

        await client.connect();

        try {
            assert.equal(
                await client.add(1),
                2
            );
        } finally {
            await client.disconnect();
        }
    });

    itWithClient(TestRedisServers.OPEN, 'should reconnect after DEBUG RESTART', async client => {
        client.on('error', () => {
            // ignore errors
        });

        await client.sendCommand(['CLIENT', 'SETNAME', 'client']);
        await assert.rejects(client.sendCommand(['DEBUG', 'RESTART']));
        assert.ok(await client.sendCommand(['CLIENT', 'GETNAME']) === null);
    });

    itWithClient(TestRedisServers.OPEN, 'should SELECT db after reconnection', async client => {
        client.on('error', () => {
            // ignore errors
        });

        await client.select(1);
        await assert.rejects(client.sendCommand(['DEBUG', 'RESTART']));
        assert.equal(
            (await client.clientInfo()).db,
            1
        );
    });
});