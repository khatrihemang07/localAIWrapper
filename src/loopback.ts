import { isIPv4 } from "node:net";

// True when HOST names an address that only this machine can reach: localhost,
// IPv6 ::1, and the 127.0.0.0/8 block IPv4 reserves for loopback (also when
// written as an IPv4-mapped IPv6 address). Anything this cannot parse counts as
// non-loopback, so an unusual spelling gets a warning rather than silence.
// Short forms such as "127.1" and hex forms are deliberately not parsed.
export function isLoopbackHost(host: string): boolean {
  let h = host.toLowerCase();
  if (h.startsWith("[") && h.endsWith("]")) h = h.slice(1, -1);
  if (h === "localhost" || h === "::1" || h === "0:0:0:0:0:0:0:1") return true;
  if (h.startsWith("::ffff:")) h = h.slice("::ffff:".length);
  // net.isIPv4 rejects zero-padded octets such as "127.0.0.01", so only canonical dotted quads pass.
  return isIPv4(h) && h.startsWith("127.");
}
