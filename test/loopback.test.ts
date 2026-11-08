import { expect, test } from "bun:test";
import { isLoopbackHost } from "../src/loopback.ts";

test.each([
  "localhost",
  "LOCALHOST",
  "Localhost",
  "::1",
  "[::1]",
  "0:0:0:0:0:0:0:1",
  "[0:0:0:0:0:0:0:1]",
  "127.0.0.1",
  "127.0.0.2",
  "127.1.2.3",
  "127.255.255.255",
  "[127.0.0.1]",
  "::ffff:127.0.0.1",
  "[::ffff:127.0.0.1]",
  "::FFFF:127.0.0.1",
  "::ffff:127.255.255.254",
])("%p is loopback", (host) => {
  expect(isLoopbackHost(host)).toBe(true);
});

test.each([
  "0.0.0.0",
  "::",
  "[::]",
  "0:0:0:0:0:0:0:0",
  "192.168.1.5",
  "10.0.0.1",
  "128.0.0.1",
  "126.255.255.255",
  "1.127.0.0.1",
  "example.com",
  "localhost.example.com",
  "", // unset-but-empty HOST
  "127.1", // short form: not parsed as loopback (conservative, warns)
  "127.0.1", // short form
  "0x7f.0.0.1", // hex form
  "127.0.0.01", // zero-padded octet: net.isIPv4 rejects it
  "127.00.0.1",
  "127.0.0.256", // out of range
  "127.0.0.-1",
  "::ffff:192.168.1.5",
  "::ffff:0.0.0.0",
  "::ffff:127.0.0.01", // zero-padded mapped octet
  "::ffff:7f00:1", // hex form of 127.0.0.1: not parsed (conservative, warns)
  "fe80::1",
])("%p is not loopback", (host) => {
  expect(isLoopbackHost(host)).toBe(false);
});
